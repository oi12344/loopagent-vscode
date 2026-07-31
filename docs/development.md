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

新增或重命名文档后，同步更新 [docs/superpowers/INDEX.md](superpowers/INDEX.md)（规划新功能前的检索入口，CodeGraph 不索引 markdown，靠这份清单代替全目录 grep）。

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

## 状态驱动动态工作流

动态工作流的新入口应让模型生成语义计划：节点使用 `after` 描述前置关系，使用 `contextFrom` 声明状态读取，审核节点使用 `reviews` 声明被审核节点。模型不得生成 `cycles`、自由表达式或 reducer。

运行时流程固定为：读取 superstep 快照、执行当前 frontier、收集写入、按通道策略原子提交、根据已提交状态路由下一 frontier。节点输出写入 `outputs.<nodeId>`，运行历史写入 `history`；`single` 写入冲突必须失败，不能依赖 Promise 完成顺序。

`review` 节点必须返回结构化 `{"decision":"approve"|"revise","feedback":string[]}`。`revise` 回到被审核节点，`approve` 进入合法后继或 `END`。`maxSteps` 和 `maxExecutions` 始终生效，即使业务退出条件没有满足也不能无限运行。

旧 `initialNodes/resolvers/cycles` 输入只允许作为兼容入口；新增模型提示不得继续推荐旧循环配置。副作用节点在同一步串行执行，Webview 只展示状态，不负责调度或提交。

## 动态工作流恢复

`runDynamicGraph` 使用现有 `.loopagent/conversation.sqlite` 中独立的 `workflow_checkpoint` 表保存节点状态，不与 React 的 `interrupted_run` 混用。检查点由 `conversationId`、`runId`、`planHash` 和单调 `revision` 共同定位；旧运行或低 revision 的迟到写入必须被存储层拒绝。

同一计划恢复时，已完成节点只复用结果，失败节点及其下游从 `frontier` 继续。`running` 节点按未完成处理；计划 hash 变化会清除旧检查点并启动新计划。返回值包含 `workflowStatus`、`failedNodes`、`unreachedNodes`、`unresolvedFailures` 和不透明 `resumeToken`，父智能体不能把部分成功当成 `completed`。

节点角色为 `executor` 时默认副作用为 `unknown`。失败后状态为 `recovery_required`，不会自动重复 `applyEdit` 或 `runCommand`；只有只读节点或明确标记 `sideEffect: "none"` 的节点允许按 retry 配置重试。完成门禁要求必需节点终态成功/跳过、未决失败为空、没有副作用对账等待，并且最终检查点写入成功。

扩展重启沿用现有 `resumeRun` 入口和同一个 `runId`，由 provider 将会话身份及 `ConversationStore` 注入动态图工具。验证恢复时必须使用同一个 Extension Development Host，确认已完成节点执行计数不增加，再检查失败节点是否只执行一次新的尝试。

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

自动化使用复杂项目问题验证强制动态图运行时。判定除源码语义锚点和真实路径外，还要求成功调用 `runDynamicGraph`，至少两个只读节点并发运行，并在其后完成审查节点。判定结果只输出锚点、路径、工具名、并发指标、回答长度和截图路径，不保存完整回答。

CDP runner 覆盖单轮 Webview 提交、动态图工具历史、子节点状态时序和结果读取。若当前 VS Code 版本不暴露可访问的 Webview CDP target，人工 fallback 必须复用同一个隔离窗口，提交同一固定问题，并按相同语义规则结合可见 Process 状态和截图验收；不得为 fallback 启动第二个 VS Code 窗口。运行时边界和排障命令见 [强制动态图运行时指南](superpowers/guides/dynamic-graph-runtime.md)。
