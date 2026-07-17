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

## 测试发现边界

项目根目录可保留 `.worktrees/` 中的功能 worktree。Vitest 配置必须排除 `.worktrees/**`，避免根目录的 `npm test` 重复扫描隔离 worktree 内的源码、测试和构建产物。

Vitest 默认使用 Node 环境；只有需要真实 DOM 的 `test/App.test.tsx` 通过文件注释启用 `jsdom`。测试 setup 不再全局加载，以避免每个 Node/SQLite 测试重复初始化 DOM 环境。

## 本地 VS Code 调试流程

本地测试插件时，使用固定入口：

```powershell
npm run debug:vscode
```

该入口会先关闭本项目已经启动的 Extension Development Host，再用固定的 `.local-vscode-user-data`、`.local-vscode-extensions` 和 `9333` 调试端口启动一个新窗口。这样可以保证同一轮测试只有一个 VS Code 调试窗口，避免多个窗口同时连接不同版本的 Extension Host。

日常验证顺序：

1. 运行 `npm test`、`npm run typecheck`、`npm run compile`。
2. 运行 `npm run debug:vscode`。
3. 在唯一的 Extension Development Host 中点击 Activity Bar 的 `LoopAgent` 入口打开 Chat 视图。
4. 修改代码后优先在同一窗口中执行 `Developer: Reload Window`，不要重复启动新窗口。
5. 测试结束后关闭该调试窗口；如出现 `.local-vscode-user-data-*` 或 `.local-vscode-extensions-*` 这类带编号的目录，确认没有 VS Code 占用后再清理。

注意事项：首次启动 VS Code 可能出现登录、欢迎页或扩展推荐弹窗，它们会遮挡 Webview。验证页面时应先关闭遮挡层，再用截图和实际交互确认功能，而不是只依赖 DOM 文本。

## 稳定 VSIX E2E

需要验证实际安装包而不是开发目录时，先生成固定 VSIX，再启动隔离窗口：

```powershell
npm run package:vsix
npm run start:vscode:vsix-e2e
```

该入口把 `.artifacts\loopagent-vscode-0.0.1.vsix` 安装到固定的 `.local-vscode-extensions`，并复用固定的 `.local-vscode-user-data` 和 `9333` 远程调试端口。启动参数不包含 `--extensionDevelopmentPath`，因此验证对象是已安装的 VSIX，而不是当前源码目录中的开发扩展。

默认启动前会关闭使用该固定用户数据目录的已有 VS Code 窗口，保证本项目只保留一个 VSIX E2E 窗口。真实 DeepSeek 验证可以继承当前进程的环境变量，但启动脚本、测试输出和验证记录不得输出任何密钥。

真实代码探索按以下安全顺序执行：

```powershell
Test-Path Env:DEEPSEEK_API_KEY
npm run start:vscode:vsix-e2e
npm run test:e2e:code-exploration
```

`Test-Path` 只检查环境变量是否存在，不读取或输出它的值。若结果为 `False`，应在隔离窗口中执行 `LoopAgent: Set Model API Key`，让 VS Code SecretStorage 保存密钥；不得把真实值写入 PowerShell history、仓库文件或验证记录。

自动化使用固定问题“追踪 LoopAgentChatViewProvider.startRun 到生成代码语义上下文的调用链，并说明工作区源码缓存何时失效。请列出关键源码文件和函数。”。语义判定同时要求可见的代码上下文构建、模型调用和完成状态，并检查回答是否命中至少三个下游语义锚点、至少两个真实源码路径，以及 `providerRegistry.ts` 或 `vscodeWorkspaceIntelligence.ts` 中至少一个关键实现文件。判定结果只输出锚点、路径、缺失状态、回答长度和截图路径，不保存完整回答。

CDP runner 只覆盖单轮 Webview 提交和结果读取，不负责多轮对话、工具调用或 SQLite 索引接入。若当前 VS Code 版本不暴露可访问的 Webview CDP target，人工 fallback 必须复用同一个隔离窗口，提交同一固定问题，并按相同语义规则结合可见 Process 状态和截图验收；不得为 fallback 启动第二个 VS Code 窗口。
