# 类型检查契约修复计划

1. [x] 为 `chatTypes.ts` 补齐 CodeReview 与恢复消息字段类型，并先运行受影响测试确认基线。
2. [x] 迁移 Java fallback/AST 提取器的节点、边、导入和未解析引用字段，补齐 AST 子节点访问。
3. [x] 对齐 Webview 与 host 的撤销/内容重置消息，移除没有生产者的 dismiss 消息。
4. [x] 运行集中验证，修复剩余由本次契约变更直接产生的错误，并记录结果。

## 验证记录

- 受影响测试：3 个文件、51 个测试通过。
- `npm run typecheck`：通过。
- `npm run compile`：通过。
- 全量测试：912 个通过、3 个跳过；剩余失败为既有 `exploreCodeSpool` 输出契约 1 个和 Windows 进程树终止 2 个。
- `git diff --check`：通过；仅报告现有文件的 LF/CRLF 转换提示。
