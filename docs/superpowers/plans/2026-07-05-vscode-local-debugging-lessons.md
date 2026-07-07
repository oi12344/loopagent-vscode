# VS Code 本地调试复盘与经验

日期：2026-07-05

## 背景

本轮为了验证 React Webview、消息协议和白屏修复，反复启动 VS Code Extension Development Host。由于每次启动都新建了 VS Code 调试窗口，并且还生成了带编号的 `.local-vscode-user-data-*`、`.local-vscode-extensions-*` 目录，导致桌面上出现多个 VS Code 窗口，影响判断当前页面到底来自哪一次构建。

## 根因

1. VS Code CLI 每执行一次 `code --extensionDevelopmentPath=...` 都可能打开一个新的 Extension Development Host。
2. 之前调试时使用了不同的本地 user-data / extensions 目录，等于每次都启动一套新的 VS Code 配置环境。
3. 白屏排查过程中同时依赖浏览器调试、截图、VS Code 窗口人工观察，缺少“先关闭旧调试窗口，再启动新窗口”的固定入口。
4. Webview 内容运行在 VS Code 隔离环境里，CDP 或窗口文本不一定能稳定读到 React 页面内容，截图和真实点击更可靠。

## 后续规则

1. 本项目只使用 `npm run debug:vscode` 启动本地插件调试。
2. 该命令启动前会尝试关闭同一项目路径下的旧 Extension Development Host，只保留一个调试窗口。
3. 固定使用 `.local-vscode-user-data`、`.local-vscode-extensions` 和 `9333` 调试端口，不再创建带编号的调试目录。
4. 新需求完成后的 VS Code 本地验证，必须记录是否使用了唯一调试窗口。
5. 需要多窗口对比时，先在回复中说明原因；测试结束后关闭额外窗口并清理临时目录。

## 本次踩坑记录

1. 不要把 VS Code/Copilot 登录弹窗、欢迎页、扩展推荐页误判为 Webview 页面问题。
2. 不要只看 source map 或 CSP 噪音；白屏根因要回到控制台错误和 React 入口排查。
3. `acquireVsCodeApi()` 只能调用一次；React StrictMode 下重复渲染会放大这类问题。
4. 假事件流要避免重复结束事件，否则 UI 看似正常但协议语义会变脏。
5. Webview 验证要结合截图、按钮点击、事件列表结果，不要只依赖 DOM 文本抽取。
6. 调试窗口过多时，先停下来确认当前窗口来源，否则容易在旧构建上验证新功能。

## 验收口径

后续每次本地 VS Code 验证完成后，最终回复必须写明：

1. 使用的启动命令。
2. 当前是否只保留一个 LoopAgent Extension Development Host。
3. 页面和功能是否与已开发内容一致。
4. 如未做 VS Code 窗口级验证，必须明确说明原因。

## 追加经验：JSON 文件编码

Windows PowerShell 5 的 `Set-Content -Encoding UTF8` 会写入 UTF-8 BOM。`package.json` 一旦带 BOM，Vite/PostCSS 在加载配置时可能报 `Unexpected token`。后续修改 JSON 文件时应使用结构化 JSON 工具并确保 UTF-8 无 BOM，或在写回后做编码检查。
