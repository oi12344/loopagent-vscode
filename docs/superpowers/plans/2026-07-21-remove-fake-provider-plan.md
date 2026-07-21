# 移除 Fake 模型提供方实施计划

1. 删除 Fake runner、Fake 配置分支和共享类型中的 Fake provider。
2. 删除 Webview 的 `Fake local` 选项及对应测试，更新 DeepSeek 配置测试。
3. 运行单元测试、类型检查、编译和差异检查，确认测试夹具未被误删。

验收标准：源码和测试不再引用 Fake 模型提供方；`npm test`、`npm run typecheck`、`npm run compile` 和 `git diff --check` 全部通过。
