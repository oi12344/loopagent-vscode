# 类型检查契约修复设计

## 目标

恢复共享类型与三个消费者之间的一致性，使 `npm run typecheck` 不再被既有 `codeReview`、Java AST 和 Webview 契约错误阻塞。

## 范围

- 在 `src/shared/chatTypes.ts` 补齐代码审查配置、问题和报告类型。
- 将 Java fallback/Tree-sitter 提取器迁移到当前 `graphTypes.ts` 字段命名和 `SyntaxNode` API。
- 将 Webview 实际消费的 host 消息加入共享协议；删除没有 host 生产者且无需持久化的 `editDismissRequested` 消息。
- 为恢复的对话消息补齐 UI 读取的运行标识、工作流和已应用改动字段。

## 取舍

- 以当前 TypeScript/Python 适配器和消息生产者为规范，不向共享类型保留旧字段别名。
- Java 节点的范围使用 AST 起止行；fallback 无法推断结束范围时使用起始行。
- 撤销操作继续由 Webview 发起，host 返回结构化结果；“保留”只清除本地通知，不发送无效消息。

## 验证

- 运行 Java、codeReview、Webview 相关 Vitest。
- 运行 `npm run typecheck`、`npm run compile` 和 `git diff --check`。
