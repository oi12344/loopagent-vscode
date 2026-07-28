# 去掉默认 reviewer 子智能体设计

## 目标

默认多子智能体流程只并行执行相互独立的分析节点，由父智能体直接汇总 `runDynamicGraph` 返回的结构化结果，避免为普通仓库问答额外调用 reviewer 模型。

## 范围

- 更新父智能体提示词：并行分析完成后由父智能体汇总，不默认创建 reviewer 节点。
- 更新代码探索真实 E2E：运行图恰好包含两个无依赖的只读分析节点。
- 更新 E2E 判定：要求两个节点实际并行完成，并明确拒绝 reviewer 节点。
- 更新相关单元测试和动态图运行文档。

## 非目标

- 不删除 `reviewer` 角色及其只读权限。
- 不删除 `dependsOn`、`inputMapping` 或 resolver 能力。
- 不阻止用户明确要求独立代码审查时创建 reviewer 节点。
- 不改变 executor 的编辑、命令审批和工作区边界。

## 数据流

```text
用户请求
  -> 父智能体判断需要并行探索
  -> runDynamicGraph
       -> explorer A ┐
                     ├-> 返回结构化 results
       -> explorer B ┘
  -> 父智能体直接核对并汇总
  -> 最终答案
```

两个分析节点不声明 `dependsOn`，因此调度器可以并行启动。父智能体只根据工具返回的节点状态和结果作答；任一节点失败时必须在最终答案中说明，不生成补偿 reviewer。

## 取舍

选择保留 reviewer 能力但移出默认流程。相比彻底删除角色，这一方案改动更小，也保留显式代码审查场景；相比继续默认创建 reviewer，可减少一次模型调用、串行等待和依赖结果映射。

## 验证

- 单元测试验证 E2E 问题要求两个节点且不包含 reviewer。
- 单元测试验证图结构判定拒绝 reviewer 或依赖节点。
- 运行相关测试、类型检查、构建和 `git diff --check`。
- 在固定 VS Code 调试窗口运行真实 DeepSeek E2E，确认 `parallelReadOnlyNodes >= 2`、无 reviewer、父智能体生成完整答案。

## 关联文件

- `src/extension/model/providerRegistry.ts`
- `scripts/codeExplorationE2e.js`
- `scripts/run-code-exploration-e2e.mjs`
- `test/codeExplorationE2e.test.ts`
- `test/providerRegistryCodeContext.test.ts`
- `docs/superpowers/guides/dynamic-graph-runtime.md`
