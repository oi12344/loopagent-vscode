# VSIX 代码探索 E2E 稳定基线设计

## 背景

LoopAgent 已具备真实 VS Code 工作区扫描、Tree-sitter 解析、内存语义图、名称检索、相关节点扩展、代码片段裁剪和 DeepSeek 流式回答能力。当前验证主要依赖单元测试、Extension Development Host 和独立 SQLite 能力探针，尚缺少一条覆盖“生产构建 -> VSIX 打包 -> 隔离安装 -> 真实模型代码探索”的可重复验收链路。

本设计把当前功能整理为一个可安装、可启动、可重复验证的稳定基线。稳定化只补充构建和测试基础设施，不改变代码探索算法、聊天协议或产品交互。

## 目标

1. 使用生产构建生成可安装的 `.vsix`。
2. 把 VSIX 安装到项目固定的隔离 VS Code 用户目录和扩展目录，不污染日常 VS Code 环境。
3. 在隔离窗口中打开当前仓库，使用本机提供的 `DEEPSEEK_API_KEY` 发起一次真实代码探索请求。
4. 验证工作区扫描、代码智能 prompt、远端模型调用、流式 Webview 展示和最终回答形成完整闭环。
5. 生成可审计的中文验证记录，记录构建、安装、交互、可见结果和限制。

## 非目标

1. 不新增多轮对话历史；每次问题仍是独立请求。
2. 不新增文件读取、符号搜索或调用者查询等 Agent tool。
3. 不把 SQLite Worker 接入工作区索引；SQLite 仍按现有独立探针验证。
4. 不修改当前扫描范围、预算、缓存或语义图算法。
5. 不把真实模型回答做成逐字匹配的确定性测试。
6. 不发布到 VS Code Marketplace，也不安装到用户日常 VS Code 配置。

## 方案选择

采用“可重复的隔离 VSIX E2E”方案：仓库提供固定打包与启动入口，生产构建后安装 VSIX，再用固定用户目录、扩展目录和调试端口启动一个隔离窗口。

未采用以下方案：

- 仅使用 Extension Development Host：无法证明 VSIX 文件清单、安装后资源路径和生产构建入口正确。
- 安装到日常 VS Code：会污染用户扩展与配置，难以稳定复现。
- 只跑单元测试：无法证明真实 VS Code、Webview、Tree-sitter/WASM 和 DeepSeek 网络链路协同工作。

## 稳定基线边界

稳定基线对应当前分支已经完成的用户可见能力：

- Activity Bar 中的 LoopAgent Chat View。
- DeepSeek 与 Fake local 模型选择。
- DeepSeek API Key 的 SecretStorage 和 `DEEPSEEK_API_KEY` 环境变量回退。
- `.ts`、`.tsx`、`.js`、`.jsx`、`.py` 工作区文件扫描。
- Tree-sitter 语法树、符号和引用提取。
- 内存搜索索引、语义图扩展和代码片段 prompt。
- DeepSeek 流式输出及 Webview 中的过程状态。
- SQLite Worker 生产产物，但它不参与本次代码探索 E2E。

尚未实施的 SQLite Schema、Migration、Job 队列和 Writer Lease 不属于本稳定版本。

## 构建与打包

仓库新增可重复的 VSIX 打包入口，按以下顺序执行：

1. 运行完整单元测试和类型检查。
2. 执行 `vscode:prepublish` 的 production build。
3. 使用固定版本的 `@vscode/vsce` 生成 VSIX 到项目内的忽略目录。
4. 检查 VSIX 文件清单。

VSIX 必须包含：

- `dist/extension.js`
- `dist/webview.js`
- `dist/webview.css`
- `dist/sqliteIndexWorker.js`
- Tree-sitter runtime 与当前支持语言所需的 WASM 资源
- `package.json`
- `resources/loopagent.svg`

VSIX 不得包含：

- `dist/test/**`
- `test/**`
- `.local-vscode-user-data/**`
- `.local-vscode-extensions/**`
- `.git/**`
- `.env*`、密钥、token、日志和临时截图

打包产物目录不进入 Git。现有 `.vscodeignore` 对 `dist/test/**` 的发布边界继续保留；实现阶段必须通过 VSIX 实际文件清单验证其他排除规则，而不能只依赖配置推断。

## 隔离安装与窗口生命周期

E2E 复用项目规定的固定资源：

- 用户目录：`.local-vscode-user-data`
- 扩展目录：`.local-vscode-extensions`
- 远程调试端口：`9333`
- 工作区：当前仓库根目录

启动脚本必须先识别并关闭本项目已有的 LoopAgent Extension Development Host 或 VSIX E2E 窗口，确保同一时间只有一个测试窗口。随后脚本执行：

1. 向固定扩展目录安装刚生成的 VSIX，使用 `--force` 覆盖同版本安装。
2. 不传入 `--extensionDevelopmentPath`，确保加载的是安装后的 VSIX。
3. 打开当前仓库根目录。
4. 使用固定用户目录、扩展目录和调试端口启动新窗口。
5. 测试结束后关闭该窗口，不创建带编号的临时 VS Code 目录。

## 密钥安全

真实 E2E 只从以下来源读取 DeepSeek API Key：

1. 隔离 VS Code 用户目录内由 `LoopAgent: Set Model API Key` 写入的 SecretStorage；或
2. 启动进程继承的 `DEEPSEEK_API_KEY` 环境变量。

自动化脚本只检查环境变量是否存在，不打印变量内容。密钥不得写入命令参数、JSON、测试夹具、验证文档、截图文件名、日志或 VSIX。测试完成后检查 Git diff 和打包清单，确认没有密钥或临时配置进入仓库。

缺少密钥时，真实模型 E2E 必须明确失败并提示配置方式，不得降级为 Fake local 后仍报告通过。

## E2E 交互流程

真实窗口按以下顺序操作：

1. 确认 VS Code 加载的是安装后的 `local-dev.loopagent-vscode`，而不是 `--extensionDevelopmentPath`。
2. 执行 `LoopAgent: Focus Chat`。
3. 在 Webview 中选择 `DeepSeek v4 Flash`，thinking 默认关闭。
4. 提交固定问题：

```text
追踪 LoopAgentChatViewProvider.startRun 到生成代码语义上下文的调用链，并说明工作区源码缓存何时失效。请列出关键源码文件和函数。
```

5. 等待回答完成，并采集 Webview 可见状态、最终回答、Extension Host 日志和截图。

问题只给出入口符号，不在问题中泄露预期的下游函数名，使最终语义锚点能够证明模型获得了代码探索上下文，而不是简单复述问题。

## 验收判据

### 确定性门禁

- 完整单元测试通过。
- TypeScript 类型检查通过。
- production build 通过。
- SQLite 最低版本 Extension Host 能力探针通过。
- VSIX 能安装并在隔离窗口中激活。
- VSIX 清单满足包含和排除规则。
- Extension Host 没有扩展激活、Tree-sitter、WASM 或 Webview 资源加载错误。

### 真实模型语义判据

Webview 必须依次出现：

- `Building code context`
- `Calling DeepSeek deepseek-v4-flash`
- 非空流式回答
- `Done`

回答必须引用入口以外的真实下游语义锚点。至少命中以下五项中的三项：

- `createConfiguredAgentRunner`
- `systemPromptProvider`
- `buildCodeIntelligencePrompt`
- `createVsCodeWorkspaceIntelligence`
- `sourceCache`、`dirtyPaths` 或文件 watcher 的失效行为

回答还必须至少给出两个真实源码路径，其中一个是 `src/extension/model/providerRegistry.ts` 或 `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`。判定只检查语义锚点和可核对事实，不要求措辞一致。

如果模型请求成功但回答未满足语义判据，本轮记为失败并保留证据；不得仅凭 HTTP 成功或出现 `Done` 判定代码探索通过。

## 自动化与人工证据边界

自动化负责：

- 构建、打包、安装和启动。
- VSIX 文件清单检查。
- 通过 CDP 尝试打开 Chat、输入问题、提交并读取状态。
- 保存不含密钥的日志和截图路径。

真实 VS Code Webview 的 DOM 或焦点可能因版本变化不可访问。自动化按以下顺序降级：

1. CDP 直接访问 Workbench 和 Webview。
2. 键盘与焦点事件驱动真实界面。
3. 人工执行固定问题并用截图、可见文本和 Extension Host 日志验收。

发生降级时，验证记录必须说明使用的路径，不能把单元测试或直接调用模型 API 替代为 VS Code E2E。

## 失败处理

- 打包失败：停止，不启动 VS Code。
- 安装失败：保留 VSIX 和 CLI 错误，停止测试。
- 扩展未激活或资源缺失：记录 Extension Host 日志，修复生产文件边界后重跑。
- Tree-sitter/WASM 错误：记录具体资源路径，不退回正则解析后报告通过。
- DeepSeek 鉴权、余额、限流或服务错误：记录错误类别，不记录响应中的敏感信息；该轮不计为通过。
- 语义锚点不足：保留回答和截图，按代码探索失败处理。

## 文档与验证记录

实现时同步更新：

- `docs/development.md`：增加稳定 VSIX 的构建、隔离安装和 E2E 命令。
- `docs/superpowers/plans/`：记录 RED -> GREEN -> REFACTOR 的实现任务。
- `docs/superpowers/plans/2026-07-11-vsix-code-exploration-e2e-verification.md`：记录实际命令、版本、VSIX 清单摘要、真实问题、语义锚点、截图路径和限制。

验证记录不得包含 API Key、Authorization header 或完整外部响应载荷；只保留验收所需的最终回答和状态摘要。

## 已知限制与后续工作

- 当前每次 DeepSeek 请求都会重新建立内存图和搜索索引，仅解析结果与源码文本按文件缓存。
- 当前没有扫描进度、手动重建命令或索引状态 UI。
- 当前不携带上一轮聊天历史。
- 当前模型不能主动调用代码搜索工具。
- SQLite 持久化索引完成后，需要新增独立迁移与恢复 E2E；不修改本基线对单轮代码探索的验收定义。
