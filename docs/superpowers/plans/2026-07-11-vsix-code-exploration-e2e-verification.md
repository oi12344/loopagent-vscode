# VSIX 代码探索 E2E 验证记录

## 验证状态

当前状态：**确定性门禁通过，真实 DeepSeek E2E 待配置密钥**。

本记录对应源码基线 `18fca12`。真实模型链路已经完成 VSIX 安装、Workbench 打开、Webview 定位、固定问题提交和当前 assistant turn 读取，最终在模型请求前明确失败为 `DeepSeek API key is not configured`。因此本轮不能记为代码探索 E2E 通过。

## 验证对象

- 分支：`feature/sqlite-index-storage-worker`
- VSIX：`.artifacts/loopagent-vscode-0.0.1.vsix`
- VSIX 大小：595648 bytes
- VSIX 条目：16
- 安装扩展：`local-dev.loopagent-vscode-0.0.1`
- 安装版 VS Code：1.128.0
- SQLite probe VS Code：1.103.0
- SQLite probe Extension Host Node：22.17.0

## 确定性门禁

以下命令均在隔离 worktree 中执行：

```powershell
npm test
npm run typecheck
npm run package:vsix
npm run test:vscode:sqlite-probe
```

结果：

- Vitest：37 个测试文件、192 个测试通过。
- TypeScript：`tsc --noEmit -p ./` 通过。
- VSIX：生成成功，实际 ZIP 清单 16 个条目。
- SQLite probe：`sqlite=true`、`wal=true`、`foreignKeys=true`、`fts5=true`。
- `node --check scripts/run-code-exploration-e2e.mjs` 通过。
- `git diff --check` 通过。

期间有一次并行执行触发沙箱 cwd 映射异常，Vitest 在加载 `test/setup.ts` 前统一失败；同一命令单独重跑后 37 个测试文件、192 个测试全部通过。该异常未作为产品测试失败处理。

## 隔离安装

使用 `npm run start:vscode:vsix-e2e` 安装并启动唯一测试窗口：

- 用户目录：`.local-vscode-user-data`
- 扩展目录：`.local-vscode-extensions`
- CDP 端口：`9333`
- CDP 协议：1.3
- 启动参数不使用 `--extensionDevelopmentPath`

安装日志确认 VSIX 被解压到 `.local-vscode-extensions/local-dev.loopagent-vscode-0.0.1`。启动器在本机同时发现 `code.cmd` 和 `code` 时只选择第一个 CLI，避免把两个路径拼成无效命令。

## 真实代码探索

固定问题：

```text
追踪 LoopAgentChatViewProvider.startRun 到生成代码语义上下文的调用链，并说明工作区源码缓存何时失效。请列出关键源码文件和函数。
```

执行命令：

```powershell
npm run test:e2e:code-exploration
```

当前结果：

```text
LoopAgent run failed: DeepSeek API key is not configured
```

该结果证明自动化已经进入安装版 Webview 并提交当前问题，但没有证明 DeepSeek 网络请求、流式回答或代码探索语义判定通过。当前没有成功截图；`.artifacts/code-exploration-e2e.png` 仅在回答完成并执行语义判定后生成。

自动化兼容 VS Code 1.128 的 Webview 结构：从 Workbench 点击 Activity Bar 的 `LoopAgent` 入口，再通过宿主 target 的 `#active-frame.contentDocument` 访问真实 UI。轮询只接受本次提交后新增的 assistant turn。

## 语义判定边界

- 必须出现 `Building code context`、`Calling DeepSeek deepseek-v4-flash` 和 `Done`。
- 五个语义类别至少命中三个。
- `sourceCache`、`dirtyPaths` 和 `watcher` 同属一个缓存失效类别，最多计一次。
- 至少命中两个 `.ts` 源码路径，其中一个必须是 `providerRegistry.ts` 或 `vscodeWorkspaceIntelligence.ts`。
- `.tsx` 路径不会被截断后误计为 `.ts` 路径。

## 日志与安全

- runner 不读取或打印 `DEEPSEEK_API_KEY`，不记录 `Authorization`。
- 当前环境变量存在性检查结果为 `False`，未读取变量值。
- 验证记录不包含 SecretStorage 内容、请求 header 或完整外部响应。
- Extension Host 日志显示 `local-dev.loopagent-vscode` 由 `onView:loopagent.chat` 正常激活，未发现 LoopAgent 激活错误。

## 待完成

1. 在唯一的隔离 VS Code 窗口执行 `LoopAgent: Set Model API Key`，把密钥写入 VS Code SecretStorage。
2. 重新运行 `npm run test:e2e:code-exploration`。
3. 记录 `passed: true`、实际语义锚点、源码路径、回答长度和截图路径。
4. 检查最新 Extension Host 日志后，将本记录状态更新为最终结论。
