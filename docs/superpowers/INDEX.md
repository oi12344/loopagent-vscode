# docs/superpowers 文档索引

自动生成的目录清单，规划新功能前先在这里按关键词定位相关历史 plan/spec，再打开对应文件，不用整目录 grep。

维护方式：新增/重命名 docs/superpowers 下的文档后，重新运行下面的生成脚本刷新本文件。

## 实施计划（plans/）

- [动态工作流检查点与可恢复执行实施计划](plans/2026-08-01-workflow-checkpoint-recovery-plan.md)

- [React Webview 最小模块实施计划](plans/2026-07-04-react-webview-plan.md)
- [VS Code 本地调试复盘与经验](plans/2026-07-05-vscode-local-debugging-lessons.md)
- [Webview 空白面板修复记录](plans/2026-07-05-webview-blank-panel-fix-plan.md)
- [Webview 消息协议实施计划](plans/2026-07-05-webview-message-protocol-plan.md)
- [Agent Runner 适配层实施计划](plans/2026-07-06-agent-runner-adapter-plan.md)
- [对话输入区与模型控制实施计划](plans/2026-07-06-chat-composer-model-controls-plan.md)
- [类 Copilot 对话 UI 实施计划](plans/2026-07-06-copilot-style-chat-ui-plan.md)
- [DeepSeek v4 flash Provider 接入实施计划](plans/2026-07-06-deepseek-v4-flash-provider-plan.md)
- [代码运行时上下文注入实施计划](plans/2026-07-07-code-runtime-context-plan.md)
- [多语言代码智能索引实施计划](plans/2026-07-08-multilang-code-intelligence-plan.md)
- [多语言代码智能索引验证记录](plans/2026-07-08-multilang-code-intelligence-verification.md)
- [VS Code 工作区代码上下文接入验证记录](plans/2026-07-08-vscode-workspace-code-context-verification.md)
- [DeepSeek 预算层后真实对话测试报告](plans/2026-07-09-deepseek-budgeted-dialogue-test-report.md)
- [DeepSeek 单题真实测试：模型集成是怎么实现的](plans/2026-07-09-deepseek-model-integration-query-report.md)
- [DeepSeek 真实对话完整提示词与回答记录](plans/2026-07-09-deepseek-real-dialogue-full-report.md)
- [增量代码索引与 Tree-sitter Runtime 实施计划](plans/2026-07-09-incremental-index-tree-sitter-plan.md)
- [增量代码索引与 Tree-sitter Runtime 验证记录](plans/2026-07-09-incremental-index-tree-sitter-verification.md)
- [ReAct Agent Runtime 最小实现计划](plans/2026-07-09-react-agent-runtime-plan.md)
- [VS Code 打包宿主与复杂问题代码索引测试报告](plans/2026-07-09-vscode-packaged-code-intelligence-test-report.md)
- [真实 AST 语义抽取实施计划](plans/2026-07-10-real-ast-semantic-extraction-plan.md)
- [SQLite 符号级增量代码索引总实施计划](plans/2026-07-10-sqlite-vector-code-index-plan.md)
- [稳定 Chunk 与 Snapshot 最小实施计划](plans/2026-07-11-sqlite-index-chunk-snapshot-plan.md)
- [Embedding 与向量召回实施计划](plans/2026-07-11-sqlite-index-embedding-vector-plan.md)
- [扩展生命周期与端到端验证实施计划](plans/2026-07-11-sqlite-index-lifecycle-validation-plan.md)
- [SQLite 检索与模型上下文实施计划](plans/2026-07-11-sqlite-index-retrieval-context-plan.md)
- [SQLite 存储与 Worker 实施计划](plans/2026-07-11-sqlite-index-storage-worker-plan.md)
- [工作区增量索引实施计划](plans/2026-07-11-sqlite-index-workspace-incremental-plan.md)
- [VSIX 代码探索 E2E 稳定基线实施计划](plans/2026-07-11-vsix-code-exploration-e2e-plan.md)
- [VSIX 代码探索 E2E 验证记录](plans/2026-07-11-vsix-code-exploration-e2e-verification.md)
- [生产 ReAct 与代码搜索工具实施计划](plans/2026-07-13-production-react-code-search-tool-plan.md)
- [生产 ReAct 与代码搜索工具验证记录](plans/2026-07-13-production-react-code-search-tool-verification.md)
- [SQLite FTS 上下文最小实施计划](plans/2026-07-14-sqlite-fts-context-minimal-plan.md)
- [工作区持久化增量索引最小实施计划](plans/2026-07-14-sqlite-index-workspace-minimal-plan.md)
- [项目事实与任务经验记忆实施计划](plans/2026-07-15-agent-memory-plan.md)
- [持久化符号源码片段实施计划](plans/2026-07-15-persisted-symbol-source-plan.md)
- [ReAct 搜索收敛实施计划](plans/2026-07-15-react-search-convergence-plan.md)
- [ReAct 工具调用可观测性实施计划](plans/2026-07-15-react-tool-observability-plan.md)
- [代码生成与编辑预览实施计划](plans/2026-07-16-code-generation-preview-plan.md)
- [ReAct 单轮并发工具执行实施计划](plans/2026-07-16-concurrent-tool-execution-plan.md)
- [ReAct 同轮查询合并实施计划](plans/2026-07-16-merged-explore-code-queries-plan.md)
- [ReAct 单步同名工具去重实施计划](plans/2026-07-16-per-turn-tool-dedup-plan.md)
- [ReAct 强制最终回答实施计划](plans/2026-07-16-react-forced-final-answer-plan.md)
- [代码优先智能体工作台实施计划](plans/2026-07-17-code-first-workbench-plan.md)
- [模型推理与右侧对话实施计划](plans/2026-07-17-model-reasoning-and-right-alignment-plan.md)
- [右侧副侧边栏实施计划](plans/2026-07-17-right-secondary-sidebar-plan.md)
- [SuperPowers 代码搜索优化方案总结](plans/2026-07-18-OPTIMIZATION-SUMMARY.md)
- [Edit 模式可直接问答](plans/2026-07-18-edit-mode-answers.md)
- [多轮对话功能实现计划](plans/2026-07-18-multi-turn-conversation-plan.md)
- [搜索索引优化实施计划](plans/2026-07-18-search-index-optimization-plan.md)

## 设计文档（specs/）

- [动态工作流检查点与可恢复执行设计](specs/2026-08-01-workflow-checkpoint-recovery-design.md)

- [历史菜单定位修复设计](specs/2026-07-21-history-menu-position-design.md)
- [移除 Fake 模型提供方设计](specs/2026-07-21-remove-fake-provider-design.md)

- [React Webview 最小模块设计](specs/2026-07-04-react-webview-design.md)
- [Webview 消息协议最小设计](specs/2026-07-05-webview-message-protocol-design.md)
- [Agent Runner 适配层设计](specs/2026-07-06-agent-runner-adapter-design.md)
- [对话输入区与模型控制设计](specs/2026-07-06-chat-composer-model-controls-design.md)
- [代码运行时上下文设计](specs/2026-07-06-code-runtime-context-design.md)
- [类 Copilot 对话 UI 设计](specs/2026-07-06-copilot-style-chat-ui-design.md)
- [模型 Provider 抽象与 DeepSeek v4 flash 接入设计](specs/2026-07-06-model-provider-deepseek-design.md)
- [多语言 AST 解析与代码语义图设计](specs/2026-07-08-multilang-code-intelligence-design.md)
- [VS Code 工作区代码上下文接入补充设计](specs/2026-07-08-vscode-workspace-code-context-design.md)
- [增量代码索引与 Tree-sitter Runtime 设计](specs/2026-07-09-incremental-index-tree-sitter-design.md)
- [ReAct Agent Runtime 状态机设计](specs/2026-07-09-react-agent-runtime-design.md)
- [真实 AST 语义抽取设计](specs/2026-07-10-real-ast-semantic-extraction-design.md)
- [SQLite 持久化与向量代码索引总览](specs/2026-07-10-sqlite-vector-code-index-design.md)
- [稳定 Chunk 与 Snapshot 最小设计](specs/2026-07-11-sqlite-index-chunk-snapshot-design.md)
- [Embedding 与向量召回设计](specs/2026-07-11-sqlite-index-embedding-vector-design.md)
- [扩展生命周期与端到端验证设计](specs/2026-07-11-sqlite-index-lifecycle-validation-design.md)
- [SQLite 检索与模型上下文设计](specs/2026-07-11-sqlite-index-retrieval-context-design.md)
- [SQLite 存储与 Worker 设计](specs/2026-07-11-sqlite-index-storage-worker-design.md)
- [工作区增量索引设计](specs/2026-07-11-sqlite-index-workspace-incremental-design.md)
- [VSIX 代码探索 E2E 稳定基线设计](specs/2026-07-11-vsix-code-exploration-e2e-design.md)
- [生产 ReAct 与代码搜索工具设计](specs/2026-07-13-production-react-code-search-tool-design.md)
- [SQLite FTS 上下文最小设计](specs/2026-07-14-sqlite-fts-context-minimal-design.md)
- [工作区持久化增量索引最小设计](specs/2026-07-14-sqlite-index-workspace-minimal-design.md)
- [项目事实与任务经验记忆设计](specs/2026-07-15-agent-memory-design.md)
- [持久化符号源码片段设计](specs/2026-07-15-persisted-symbol-source-design.md)
- [ReAct 搜索收敛设计](specs/2026-07-15-react-search-convergence-design.md)
- [ReAct 工具调用可观测性设计](specs/2026-07-15-react-tool-observability-design.md)
- [代码生成与编辑预览设计](specs/2026-07-16-code-generation-preview-design.md)
- [ReAct 单轮并发工具执行设计](specs/2026-07-16-concurrent-tool-execution-design.md)
- [ReAct 单步同名工具去重设计](specs/2026-07-16-per-turn-tool-dedup-design.md)
- [代码优先智能体工作台设计](specs/2026-07-17-code-first-workbench-design.md)
- [模型推理与右侧对话设计](specs/2026-07-17-model-reasoning-and-right-alignment-design.md)
- [右侧副侧边栏设计](specs/2026-07-17-right-secondary-sidebar-design.md)
- [ReAct 流程对比：优化前后](specs/2026-07-18-REACT-FLOW-COMPARISON.md)
- [强制工具调用修复：只暴露被强制的函数](specs/2026-07-18-forced-tool-choice-fix.md)
- [SuperPowers 代码搜索索引优化设计](specs/2026-07-18-search-index-optimization-design.md)
- [多轮对话持久化设计](specs/2026-07-19-conversation-persistence-design.md)

## 状态驱动动态工作流

- [状态驱动动态工作流架构规格](specs/2026-07-31-state-driven-dynamic-workflow-design.md)
- [状态驱动动态工作流改造实施计划](plans/2026-07-31-state-driven-dynamic-workflow-plan.md)

## 生成脚本

```bash
for f in $(find docs/superpowers -type f -name "*.md" ! -name INDEX.md | sort); do
  title=$(sed "1s/^﻿//" "$f" | grep -m1 "^# " | sed "s/^# //")
  echo -e "$f	$title"
done
```
