# 开发指南

本项目采用“文档可追溯优先”的开发规则：代码变更应该能在之后通过文档理解，而不是依赖聊天记录还原上下文。

## 文档语言

所有项目文档必须使用中文输出。

允许保留英文的内容：

- 代码标识符
- 文件路径
- 命令行命令
- API 名称
- 包名
- 错误信息原文

除此之外，设计说明、实施计划、验收记录和技术债描述都应使用中文。

## 功能开发必须配套文档

每个功能或行为变更都应在 `docs/superpowers/` 下有对应文档。

命名建议：

- `docs/superpowers/specs/YYYY-MM-DD-short-topic-design.md`
- `docs/superpowers/plans/YYYY-MM-DD-short-topic-plan.md`

功能文档至少应包含：

- 目标
- 非目标
- 用户可见行为
- 涉及文件或模块
- 关键设计决策
- 验证命令
- 已知后续工作

## 简洁规则

优先选择能支撑当前里程碑的最小设计。

对本项目而言：

- VS Code 插件是 UI 外壳。
- React Webview 是交互界面。
- agent runtime 应保持独立，不与 VS Code UI 代码耦合。
- 共享抽象只在重复行为已经真实出现时再提取。

## 清理规则

快速迭代容易留下过时代码。标记任务完成前，应检查：

- 未使用文件
- 未使用依赖
- 死导出
- 旧 TODO
- 调试日志
- 已失真的测试夹具
- 描述旧实现的文档

如果某些内容无法立即清理，必须记录到相关计划或设计文档中，让它成为可见技术债，而不是隐藏杂物。

## 本地 VS Code 调试流程

本地测试插件时，使用固定入口：

```powershell
npm run debug:vscode
```

该入口会先关闭本项目已经启动的 Extension Development Host，再用固定的 `.local-vscode-user-data`、`.local-vscode-extensions` 和 `9333` 调试端口启动一个新窗口。这样可以保证同一轮测试只有一个 VS Code 调试窗口，避免多个窗口同时连接不同版本的 Extension Host。

日常验证顺序：

1. 运行 `npm test`、`npm run typecheck`、`npm run compile`。
2. 运行 `npm run debug:vscode`。
3. 在唯一的 Extension Development Host 中执行 `LoopAgent: Open Panel`。
4. 修改代码后优先在同一窗口中执行 `Developer: Reload Window`，不要重复启动新窗口。
5. 测试结束后关闭该调试窗口；如出现 `.local-vscode-user-data-*` 或 `.local-vscode-extensions-*` 这类带编号的目录，确认没有 VS Code 占用后再清理。

注意事项：首次启动 VS Code 可能出现登录、欢迎页或扩展推荐弹窗，它们会遮挡 Webview。验证页面时应先关闭遮挡层，再用截图和实际交互确认功能，而不是只依赖 DOM 文本。
