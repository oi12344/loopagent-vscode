# 动态工作流检查点与可恢复执行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for task execution and `superpowers:verification-before-completion` before claiming completion.

**Goal:** 让 `runDynamicGraph` 在节点部分成功、失败、取消和扩展重启后，从已提交检查点继续执行，只重新运行失败节点及其受影响下游节点；禁止旧运行覆盖新运行，也禁止不确定副作用被盲目重复执行。

**Architecture:** 在现有 `.loopagent/conversation.sqlite` 连接上增加独立的 `workflow_checkpoint` 表，扩展 `ConversationStore` 提供带 `runId`/`revision` 守卫的读写接口。工作流工具按 `conversationId + runId + planHash` 加载检查点，动态引擎只接收恢复后的 frontier；每个节点状态和状态通道在边界事件后原子提交。完成状态必须经过统一门禁，legacy cycle 在入口校验端点并按轮次隔离结果。

**Tech Stack:** TypeScript, Node `node:sqlite`, React agent runtime, VS Code Extension Development Host, CDP scripts, Vitest/Jest repository test commands.

---

## 任务 1：建立 JSON-safe 检查点契约和内存实现

**Files:**
- Add `src/shared/workflowCheckpoint.ts` with status/node/error/side-effect types, a versioned `WorkflowCheckpoint` shape, `createPlanHash()` and `sanitizeWorkflowCheckpoint()` helpers.
- Modify `src/extension/conversation/conversationStore.ts` to expose `saveWorkflowCheckpoint`, `loadWorkflowCheckpoint`, and `clearWorkflowCheckpoint`.
- Add `test/extension/conversation/workflowCheckpoint.test.ts` for serialization, plan hash stability, size rejection, and stale run/revision behavior.

**Steps:**
1. Write a failing test that saves a checkpoint containing plain objects, `Map`-like state converted to JSON-safe values, node attempts, `sideEffect: "unknown"`, frontier and unresolved failures, then loads the same values.
2. Write failing tests that reject unsupported checkpoint versions, non-JSON values, oversized payloads, an old revision, and a different `runId` overwriting an existing active run.
3. Define the smallest public contract:
   ```ts
   type WorkflowCheckpointStatus = "running" | "recovering" | "waiting_input" | "waiting_external" | "failed" | "completed" | "cancelled" | "recovery_required";
   type WorkflowNodeCheckpoint = { nodeId: string; status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"; inputHash: string; attempts: number; result?: { status: string; content?: string; error?: string }; error?: { code: string; message: string; retryable: boolean }; sideEffect: "none" | "applied" | "unknown" };
   type WorkflowCheckpoint = { version: 1; conversationId: string; runId: string; planHash: string; revision: number; status: WorkflowCheckpointStatus; frontier: string[]; executionOrder: string[]; nodes: Record<string, WorkflowNodeCheckpoint>; state: { step: number; version: number; values: Record<string, unknown> }; unresolvedFailures: Array<{ nodeId?: string; code: string; message: string }>; updatedAt: number };
   ```
4. Make `saveWorkflowCheckpoint` return `boolean`; accept a first write, same-run monotonic revisions, and a new run only after no active row exists. `clearWorkflowCheckpoint(conversationId, runId)` deletes only the matching run. Keep the implementation as one `Map` in the in-memory store.
5. Run the focused test; then run `npm run typecheck` and `git diff --check`.
6. Commit: `feat: add workflow checkpoint contract`.

## 任务 2：把检查点持久化到现有 conversation SQLite

**Files:**
- Modify `src/extension/conversation/persistentConversationStore.ts` to create/read/write `workflow_checkpoint`.
- Modify `test/extension/conversation/persistentConversationStore.test.ts` with reopen, corrupt-row, stale-revision and stale-run cases.

**Steps:**
1. Add failing tests using a temporary SQLite file: save, close, reopen, and load a checkpoint; corrupt `checkpoint_json` must return `undefined` without breaking conversations.
2. Add a failing test proving an old asynchronous save with a lower revision or mismatched run is ignored, while a matching higher revision replaces the row.
3. Add the table with `conversation_id` primary key and `run_id`, `plan_hash`, `revision`, `status`, `checkpoint_json`, `updated_at`; retain WAL, busy timeout and existing `interrupted_run` behavior.
4. Validate version, identifiers, revision and required arrays/objects before returning parsed JSON. Use one SQL `INSERT ... ON CONFLICT ... WHERE` guard so the write is atomic; do not add a second database or a cache.
5. Run the focused persistence tests, `npm run typecheck`, and `git diff --check`.
6. Commit: `feat: persist workflow checkpoints`.

## 任务 3：把会话运行身份和存储注入工作流工具

**Files:**
- Modify `src/extension/model/providerRegistry.ts` to pass `conversationId`, `runId`, and the `ConversationStore` into the dynamic workflow tool factory.
- Modify `src/extension/agent/dynamicWorkflowTools.ts` options and `runDynamicGraph` to calculate a canonical plan hash, load a matching checkpoint, and return `resumeToken` plus structured status.
- Add `test/extension/agent/dynamicWorkflowTools.checkpoint.test.ts` with a fake store/orchestrator.

**Steps:**
1. Write failing tests for same-plan invocation loading a checkpoint, changed-plan invocation starting a new run, and output containing an opaque token only for resumable non-terminal states.
2. Extend the factory options with the existing request identity and store; do not make the model provide database details. Generate a token from `conversationId`, `runId`, `planHash` and revision without embedding node output or secrets.
3. Canonicalize only the parsed graph definition (`nodes`/legacy nodes, resolvers, cycles, limits and initial state) before hashing. Exclude `include` and transient tool output so a formatting-only retry resumes the same plan.
4. Before constructing the engine, reject invalid cycle endpoints and graph limits. On a matching checkpoint, pass completed node results and the saved frontier into the engine; on a plan mismatch, clear the old terminal checkpoint and start a fresh run.
5. Preserve the existing required-tool behavior: a failed or recovery-required graph must not be reported as `completed`; include `failedNodes`, `unreachedNodes`, `unresolvedFailures`, `sideEffect`, and `resumeToken` in JSON.
6. Run focused tool tests, `npm run typecheck`, and `git diff --check`.
7. Commit: `feat: inject workflow run identity`.

## 任务 4：实现引擎的 frontier 恢复和 cycle 隔离

**Files:**
- Modify `src/extension/agent/workflow/dynamicGraphEngine.ts` to accept an optional checkpoint seed and checkpoint callback, reuse completed nodes, and expose terminal node metadata.
- Modify `src/extension/agent/workflow/dynamicGraphTypes.ts` only where the runtime contract requires the checkpoint seed/callback types.
- Modify `src/extension/agent/dynamicWorkflowTools.ts` to save checkpoints after node completion/failure/cancellation and before returning.
- Add/extend `test/extension/agent/workflow/dynamicGraphEngine.test.ts` for retry and resume behavior.

**Steps:**
1. Write failing engine tests with deterministic fake runners: node A succeeds once, node B fails, then a second execute resumes B while A remains at execution count 1; a plan/input fingerprint change invalidates A's saved result.
2. Write a failing test that an old cycle result cannot satisfy a later round, and a failing test that `cycles[].from`/`to` referencing an undeclared node is rejected before any runner call.
3. Add the minimum seed structure for completed node results, node attempts, frontier, execution order and state snapshot. Treat saved `running` nodes as pending, never as completed.
4. After each node result, build and persist a JSON-safe checkpoint with incremented revision. A node with `sideEffect: "unknown"` becomes `recovery_required` and is never placed back in the automatic retry frontier.
5. In legacy cycles, keep per-round result maps and reset only nodes deliberately re-entered by the cycle. Do not use the old global `completedNodes` map to read a prior round. The compiled semantic path must not instantiate `CycleManager`.
6. Run engine/tool tests, `npm run typecheck`, and `git diff --check`.
7. Commit: `fix: resume dynamic workflows from frontier`.

## 任务 5：统一失败分类和完成门禁

**Files:**
- Modify `src/extension/agent/workflow/workflowRecovery.ts` to classify resolver, timeout, validation, cancellation and side-effect-unknown errors using the existing recovery vocabulary.
- Modify `src/extension/agent/dynamicWorkflowTools.ts` to apply the classifier and completion gate.
- Add/extend tests for resolver failure, cancellation, no-progress, and uncertain side effects.

**Steps:**
1. Write failing tests proving resolver failure produces `failed` with `unresolvedFailures`, cancellation produces `cancelled`, invalid graph produces a pre-execution error, and unknown side effect produces `recovery_required` without a second edit/command call.
2. Reuse existing recovery categories/actions; do not add a second error taxonomy. Keep retry decisions at node boundaries and preserve original error text in the structured result.
3. Return `completed` only when all required nodes are terminal-success/skipped, unresolved failures are empty, no reconciliation is pending, and the final checkpoint write succeeds. A graph with zero completed nodes remains an error for the parent tool gate.
4. Add a small regression assertion that `workflowStatus` cannot be `completed` when `failedNodes` or `unreachedNodes` is non-empty.
5. Run focused recovery tests, `npm run typecheck`, and `git diff --check`.
6. Commit: `fix: enforce workflow completion gate`.

## 任务 6：接通扩展重启后的恢复入口

**Files:**
- Modify `src/extension.ts` to preserve the parent `conversationId`/`runId` when resuming and pass the persistent conversation store into `createConfiguredAgentRunner`.
- Modify `src/extension/model/providerRegistry.ts` and related runner request types only as needed to carry the identity.
- Add/extend `test/extension/conversation/workflow-restart.test.ts` for close/reopen and stale-run scenarios.

**Steps:**
1. Write a failing integration test that stores a failed graph, recreates the persistent store/provider boundary, and resumes the same conversation without rerunning completed A.
2. Reuse the existing `resumeRun`/`interrupted_run` lifecycle; do not create a second VS Code window or a second lifecycle store. On new user work, clear the old matching checkpoint before allocating a new `runId`.
3. Ensure cancellation/final cleanup clears only the matching terminal checkpoint; a late callback from the old run must receive `false` from the store guard.
4. Run the focused restart tests, `npm run typecheck`, and `npm run compile`.
5. Commit: `feat: restore workflow checkpoints after restart`.

## 任务 7：文档、真实 CDP 验收和最终清理

**Files:**
- Update `docs/development.md` with checkpoint/retry/side-effect rules and the supported resume path.
- Update `docs/superpowers/INDEX.md` with the new plan/spec entries using the repository index generator if available.
- Add or update one CDP script under `scripts/` for a deterministic failure/resume/restart matrix; store only redacted results under `.artifacts/`.
- Add `docs/superpowers/plans/2026-08-01-workflow-checkpoint-recovery-verification.md` as a concise Chinese verification record.

**Steps:**
1. Run `npm test`, `npm run typecheck`, `npm run compile`, and `git diff --check`; fix only root causes and rerun affected checks.
2. Reuse one `npm run debug:vscode` Extension Development Host on CDP port 9333. Execute real scenarios: A-success/B-failure then retry, host close/reopen then retry, invalid cycle endpoint, maxNodes/maxSteps limits, and an unknown side-effect guard. Capture counts, statuses and latency without credentials.
3. Confirm the CDP output shows A execution count 1 after recovery, B count incremented, no stale-run overwrite, and no duplicate side-effect call. Record command, timestamp, artifact path, pass/fail and known limitations in the verification record.
4. Review `git diff`, `git status`, and `git diff --check`; remove temporary debug output and ensure no key/token is present in source, tests, artifacts or logs.
5. Update this plan checkboxes and commit: `docs: record workflow checkpoint verification`.

## 完成判定

- 所有任务的测试、编译和文档步骤完成；没有已知的严重缺陷、临时调试代码或未说明的限制。
- `npm test`、`npm run typecheck`、`npm run compile`、`git diff --check` 均有本次运行的成功证据。
- CDP 真实路径验证了失败重试、执行效率、边界校验和重启恢复；最终回复只报告已验证结果，不把计划当成完成。
