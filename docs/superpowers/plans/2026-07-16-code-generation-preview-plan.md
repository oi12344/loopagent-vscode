# 代码生成与编辑预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让模型通过 `readFile` 和经用户确认的 `applyEdit` 读取、生成、预览并应用工作区代码变更。

**架构：** 新增编辑提案服务，负责路径校验、文件快照、文本替换、虚拟 Diff URI 和确认后的 `WorkspaceEdit`。`readFile` 与 `applyEdit` 都是现有 `ReactAgentTool`；前者并发安全，后者串行并等待原生 Diff 审阅。Chat Provider 在激活时创建并持有服务，通过现有 runner 依赖注入复用。

**技术栈：** TypeScript、VS Code Extension API、Vitest、现有 OpenAI-compatible ReAct runtime。

## 全局约束

- 在当前 `main` checkout 开发；不创建 worktree、分支或新依赖。
- 仅支持工作区内文本文件；拒绝绝对路径、`..`、目录、冲突操作、符号链接、未保存文档和现有 `isIndexableWorkspacePath` 排除的敏感或元数据路径。
- `readFile` 最大回灌 20,000 字符；截断必须明确告知模型。
- 一份提案的所有文件只提供一次“应用全部/取消”确认；确认前不写入真实文件。
- 提案确认前重新解析所有源/目标路径并校验符号链接、未保存文档、目标状态和源文件快照；冲突、取消、run 取消或 `WorkspaceEdit` 失败时零自动重试。
- 保持当前 3 个工具步骤加第 4 个无工具最终回答步骤，以及每轮 10 个工具请求上限。
- 不实现 Git、自动终端执行、自动确认、二进制编辑或自绘 Webview Diff。

---

### Task 1：实现文件读取和原生 Diff 编辑提案工具

**文件：**

- 新增：`src/extension/agent/readFileTool.ts`
- 新增：`src/extension/agent/applyEditTool.ts`
- 新增：`src/extension/agent/editPreviewService.ts`
- 新增：`test/editTools.test.ts`

**接口：**

```typescript
export type EditOperation =
  | { kind: "replace"; path: string; oldText: string; newText: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string };

export type EditPreviewService = {
  apply(changes: readonly EditOperation[], signal: AbortSignal): Promise<string>;
  dispose(): void;
};

export function createReadFileTool(vscodeApi: VsCodeEditApi): ReactAgentTool;
export function createApplyEditTool(service: EditPreviewService): ReactAgentTool;
export function createEditPreviewService(vscodeApi: VsCodeEditApi): EditPreviewService;
```

`VsCodeEditApi` 只暴露该功能实际需要的 `workspace.workspaceFolders`、`workspace.fs`、`workspace.applyEdit`、`Uri`、`WorkspaceEdit`、`commands.executeCommand`、`window.showInformationMessage` 和 `workspace.registerTextDocumentContentProvider`，以便 Vitest 使用小型内存替身。

- [x] **步骤 1：写入失败的读取与编辑提案测试**

在 `test/editTools.test.ts` 使用内存工作区与 `VsCodeEditApi` 假对象，新增以下用例：

```typescript
it("reads a requested line range and reports truncation", async () => {
  // 读取第 2-3 行；20,000 字符以上的完整读取返回截断说明。
});

it("rejects paths outside the workspace before reading", async () => {
  // ../secret.ts、C:\\secret.ts、.env、符号链接与未保存文档均不调用 workspace.fs.readFile。
});

it("previews a replace proposal and does not apply it when cancelled", async () => {
  // 断言 vscode.diff 被调用、showInformationMessage 返回 Cancel、applyEdit 未调用。
});

it("applies confirmed create replace rename and delete operations once", async () => {
  // 断言一个 WorkspaceEdit 包含预期操作，workspace.applyEdit 只调用一次。
});

it("rejects a proposal when its source snapshot changes before confirmation", async () => {
  // 二次 readFile 返回不同内容；断言 applyEdit 未调用。
});
```

`replace` 测试必须断言空 `oldText`、零匹配和多匹配均在打开 Diff 前失败；取消的 `AbortSignal` 在确认后、调用 `workspace.applyEdit` 前必须阻止写入。

- [x] **步骤 2：运行定向测试并确认红灯**

```powershell
npm test -- --run test/editTools.test.ts
```

预期：测试因模块不存在而失败；不得出现 VS Code 宿主、密钥或网络错误。

- [x] **步骤 3：实现最小编辑服务和两个工具**

在 `readFileTool.ts` 中验证唯一字段 `path`、可选成对的 1 起始行号，复用 `isIndexableWorkspacePath` 拒绝敏感或元数据路径，并在读取前拒绝符号链接组件与未保存文档，使用工作区 `Uri` 与 `workspace.fs.readFile` 读取 UTF-8 文本。完整读取超过 20,000 字符时截断，并返回 `Read file was truncated at 20000 characters; request a line range.`。

在 `editPreviewService.ts` 中：

1. 将每个相对路径解析到唯一工作区根目录，拒绝越界与目录目标。
2. 读取受影响文件快照，在内存中顺序应用 `EditOperation`，并拒绝重复/冲突路径与不唯一的 `oldText`。
3. 注册 `loopagent-edit-preview` 内容提供器，以 proposal ID 保存原始/目标文本；每个文件使用 `vscode.diff` 打开原生 Diff。
4. 所有 Diff 打开后以 `{ modal: true }` 调用 `showInformationMessage("Review LoopAgent changes", "Apply all", "Cancel")`。
5. 只有选择 `Apply all` 且 signal 未取消时，重读原始路径确认快照不变，构建一个 `WorkspaceEdit` 并调用一次 `workspace.applyEdit`。
6. 返回不含文件内容的成功、取消、冲突或失败 observation；`dispose` 释放内容提供器并清空预览缓存。

在 `applyEditTool.ts` 中验证 `changes` 数组及四种操作的严格 JSON 形状，然后委托 `service.apply`。它不设置 `isConcurrencySafe`。

- [x] **步骤 4：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/editTools.test.ts
```

预期：读取上限、路径校验、四类操作、原生 Diff 调用、整份提案一次确认、取消/冲突/取消信号零写入均通过。

### Task 2：接入 ReAct 运行时与代码生成提示词

**文件：**

- 修改：`src/extension/model/providerRegistry.ts`
- 修改：`src/extension.ts`
- 修改：`test/providerRegistryCodeContext.test.ts`
- 修改：`test/reactAgentRunner.test.ts`
- 更新：`docs/superpowers/plans/2026-07-16-code-generation-preview-plan.md`

**接口：**

```typescript
export type CreateConfiguredAgentRunnerDeps = {
  vscodeApi?: VsCodeWorkspaceApi;
  workspaceIntelligence?: WorkspaceIntelligence;
  parserRuntime?: ParserRuntime;
  readFileTool?: ReactAgentTool;
  applyEditTool?: ReactAgentTool;
};
```

生产路径传入真实的 `readFileTool`、`applyEditTool`；测试可注入替身，不依赖真实 VS Code Host。

- [x] **步骤 1：写入失败的 Agent 接入测试**

在 `test/providerRegistryCodeContext.test.ts` 使 mocked DeepSeek provider 先发起 `readFile`，收到 observation 后发起 `applyEdit`，最后返回文本。断言：

```typescript
expect(readFileTool.invoke).toHaveBeenCalledTimes(1);
expect(applyEditTool.invoke).toHaveBeenCalledTimes(1);
expect(capturedMessages[2]).toContainEqual(
  expect.objectContaining({ role: "tool", toolCallId: "apply-call" }),
);
```

在 `test/reactAgentRunner.test.ts` 新增同一步 `readFile` 与 `applyEdit` 的时序用例：`readFile` 标记并发安全、`applyEdit` 未标记；断言读工具完成后才开始编辑工具。

同时断言生产提示词包含“先读取相关文件”、“只通过 applyEdit 提出变更”和“应用成功前不得声称完成”。

- [x] **步骤 2：运行定向测试并确认红灯**

```powershell
npm test -- --run test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts
```

预期：生产 tools 仍只有 `exploreCode`，`readFile` 与 `applyEdit` 请求报未知工具，且提示词缺少代码生成约束。

- [x] **步骤 3：最小接入**

在 `providerRegistry.ts` 将注入或生产创建的 `readFileTool`、`applyEditTool` 与 `exploreCode` 放入同一 `tools` 数组，并把三条代码生成约束加入 `REACT_SYSTEM_PROMPT`：

```typescript
"Before editing, read the relevant file content with readFile.",
"Propose all workspace changes only through applyEdit.",
"Do not claim an edit succeeded until applyEdit reports that it was applied.",
```

在 `extension.ts` 创建工具，并通过 `createConfiguredAgentRunner` 的依赖传入；`createConfiguredAgentRunner` 不在每次 run 重复注册预览 provider。

- [x] **步骤 4：运行定向测试并确认绿灯**

```powershell
npm test -- --run test/editTools.test.ts test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts
```

预期：模型可跨步骤读取后编辑；`applyEdit` 返回的确认结果进入下一模型调用；同轮编辑不会与读工具并发；提示词契约通过。

- [ ] **步骤 5：集中验证与原生 Diff 验收**

独立运行：

```powershell
npm run typecheck
npm test
npm run compile
git diff --check
```

复用唯一 Extension Development Host，选择 DeepSeek 并配置现有 SecretStorage 后请求“在一个测试文件中添加常量”。确认原生 Diff 显示红绿变更；选择取消后文件不变，再重试并选择应用后检查文件变化。若本机没有可用 API key，记录为真实模型 E2E 未执行，但仍通过 `test/editTools.test.ts` 验证 Host 交互。

- [x] **步骤 6：更新记录并提交**

在本文末尾追加中文 RED/GREEN、集中验证、原生 Diff 验收和真实模型 E2E 结果。提交：

```powershell
git add -- src/extension.ts src/extension/agent/readFileTool.ts src/extension/agent/applyEditTool.ts src/extension/agent/editPreviewService.ts src/extension/model/providerRegistry.ts test/editTools.test.ts test/providerRegistryCodeContext.test.ts test/reactAgentRunner.test.ts docs/superpowers/plans/2026-07-16-code-generation-preview-plan.md
git commit -m "feat(agent): preview generated workspace edits"
```

## 实施结果

- RED：`test/editTools.test.ts` 初始因三个生产模块不存在而失败；`test/providerRegistryCodeContext.test.ts` 初始在 `readFile` 报 `Unknown tool`，证明未注册的新工具无法进入 ReAct 循环。
- GREEN：读取与编辑服务覆盖行区间、20,000 字符截断、工作区/敏感路径拒绝、取消零写入、快照冲突、取消信号，以及一次 `WorkspaceEdit` 的创建、替换、重命名和删除。`applyEdit` 工具 schema 明确声明四种 operation，避免模型只得到模糊的数组约束。
- 运行时：Chat Provider 只创建一次预览服务、`readFile` 和 `applyEdit`，后续 run 复用同一实例；`readFile` 为并发安全，`applyEdit` 未声明并发安全，因此同轮会在读取完成后串行审阅。
- 安全复审：拒绝路径组件中的符号链接和未保存文档；用户确认后再次解析替换/删除源、创建目标及重命名两端路径，并重检目标不存在性。`file` URI 的脏文档比较使用大小写不敏感的 `fsPath`，避免 Windows 路径大小写绕过。
- 集中验证：`npm test` 通过 51 个测试文件、291 个测试；`npm run typecheck`、`npm run compile` 和 `git diff --check` 均通过。
- 真实模型：现有 `npm run test:e2e:code-exploration` 通过。DeepSeek 编辑请求起初暴露 operation schema 不完整，补齐后真实模型调用 `applyEdit`，VS Code 打开 `LoopAgent: scratch/loopagent-preview-e2e.ts` 原生预览标签，工具 observation 返回取消，模型最终说明“创建操作已被取消”；目标文件不存在。
- 已知限制：原生 VS Code 确认控件不在 CDP 文档树中，且 Windows 自动化随后检测到用户输入状态，因此没有替用户执行“应用全部”写入验收。确认后写入的行为由 `test/editTools.test.ts` 覆盖；步骤 5 保持未勾选，等待用户在当前调试窗口手动选择一次“应用全部”后完成真实宿主验收。
