# Java 物流接口 E2E 测试指南

## 测试目标

使用 Chrome DevTools Protocol (CDP) 自动化测试 LoopAgent VSCode 扩展在 Java 项目中的表现：

1. **启动 VSCode** 并加载 LoopAgent 扩展
2. **打开项目** `D:\zz\yguc\yguc-biz`
3. **定位文件** `LogisticsController.java`
4. **提问** "请在 LogisticsController 中新增一个新增物流信息的接口"
5. **捕获** 模型的推理过程、工具调用、最终回答
6. **生成报告** 包含截图和详细记录

## 快速开始

### 方式 1：使用启动脚本（推荐）

```powershell
# 在项目根目录执行
.\scripts\run-java-logistics-test.ps1
```

脚本会自动：
- 启动 VSCode 测试实例（CDP 端口 9333）
- 等待扩展加载
- 执行测试脚本
- 生成报告到 `.artifacts/` 目录
- 提示是否关闭 VSCode

### 方式 2：手动分步执行

#### 步骤 1：启动 VSCode（启用 CDP）

```powershell
# 启动 VSCode 并启用远程调试
$VSCODE_PATH = "C:\Users\msi\AppData\Local\Programs\Microsoft VS Code\Code.exe"
$EXTENSION_PATH = "E:\zz\loopagent-vscode"

& $VSCODE_PATH `
  --remote-debugging-port=9333 `
  --disable-extensions `
  --extensionDevelopmentPath=$EXTENSION_PATH `
  --new-window
```

等待 10-15 秒让 VSCode 完全启动并加载扩展。

#### 步骤 2：运行测试脚本

```powershell
# 在新的 PowerShell 窗口执行
node .\scripts\run-java-logistics-e2e.mjs
```

## 测试脚本工作流程

测试脚本 `run-java-logistics-e2e.mjs` 执行以下步骤：

### 阶段 1：连接和准备
1. **连接 CDP** - 连接到 VSCode 的 CDP 端口（9333）
2. **查找 Workbench** - 定位 VSCode 主窗口的调试目标
3. **打开文件夹** - 使用 `vscode.openFolder` API 打开项目
4. **打开文件** - 使用 `vscode.workspace.openTextDocument` 打开目标文件

### 阶段 2：对话交互
5. **打开 LoopAgent** - 点击活动栏中的 LoopAgent 图标
6. **查找 Webview** - 定位 LoopAgent 的 Webview 调试目标
7. **新建会话** - 点击 "New chat" 按钮
8. **提交问题** - 填充 textarea 并点击提交按钮

### 阶段 3：捕获和报告
9. **监听推理** - 轮询 DOM，捕获：
   - 推理过程（`.reasoning-content`）
   - 工具调用（`.tool-call-entry`）
   - 最终回答（`.assistant-answer`）
   - 状态变化（`.status-pill`）
10. **截图** - 使用 `Page.captureScreenshot` 保存 PNG
11. **生成报告** - 写入 Markdown 报告到 `.artifacts/`

## 输出文件

测试完成后会生成两个文件：

### 1. 截图 `.artifacts/java-logistics-e2e.png`

完整的 VSCode 窗口截图，包含：
- 编辑器中的 LogisticsController.java
- LoopAgent 侧边栏和对话界面
- 模型的最终回答

### 2. 报告 `.artifacts/java-logistics-e2e.md`

Markdown 格式的详细报告，包含：

```markdown
# Java 物流接口 E2E 测试报告

## 执行摘要
- 状态: ✅ 成功完成 / ❌ 失败
- 总耗时: XX 秒
- 推理过程长度: XX 字符
- 工具调用次数: XX 次
- 最终回答长度: XX 字符

## 推理过程
（模型的 thinking 内容）

## 工具调用详情
#### 工具调用 1: Read
**输入**: { "file_path": "..." }
**输出**: （文件内容）

#### 工具调用 2: Write
...

## 最终回答
（模型生成的回答内容）
```

## 监控和调试

### 实时进度输出

脚本每 5 秒输出一次进度到 stderr：

```
[进度] 推理: 1234字 | 工具调用: 3次 | 回答: 567字 | 状态: Thinking | 耗时: 15s
```

### JSON 结果输出

脚本最后会输出 JSON 到 stdout，供自动化工具解析：

```json
{
  "success": true,
  "elapsedMs": 45000,
  "reasoningLength": 1234,
  "toolCallCount": 5,
  "answerLength": 890,
  "error": null,
  "screenshotPath": "E:\\zz\\loopagent-vscode\\.artifacts\\java-logistics-e2e.png",
  "transcriptPath": "E:\\zz\\loopagent-vscode\\.artifacts\\java-logistics-e2e.md"
}
```

### 超时设置

- **连接超时**: 10 秒（CDP WebSocket 连接）
- **请求超时**: 20 秒（单个 CDP 命令）
- **回答超时**: 300 秒（5 分钟，等待模型完成回答）

可以在脚本中修改 `TURN_TIMEOUT_MS` 常量来调整回答超时。

## 常见问题

### Q1: 脚本报错 "未找到 VS Code workbench 的 CDP 目标"

**原因**: VSCode 未完全启动或 CDP 端口未开启

**解决方案**:
1. 确认 VSCode 启动参数包含 `--remote-debugging-port=9333`
2. 等待更长时间（15-20 秒）再运行测试脚本
3. 手动访问 `http://127.0.0.1:9333/json/list` 检查 CDP 是否可用

### Q2: 脚本报错 "未在 XXms 内找到 LoopAgent Webview 的 CDP 目标"

**原因**: LoopAgent 扩展未加载或 Webview 未打开

**解决方案**:
1. 确认启动参数包含 `--extensionDevelopmentPath=E:\zz\loopagent-vscode`
2. 手动打开 LoopAgent 视图，确认扩展正常运行
3. 检查 VSCode 开发者工具（Help > Toggle Developer Tools）的控制台错误

### Q3: 脚本报错 "打开文件夹失败" 或 "打开文件失败"

**原因**: 项目路径不存在或文件路径错误

**解决方案**:
1. 确认项目路径存在: `Test-Path "D:\zz\yguc\yguc-biz"`
2. 确认文件路径存在: `Test-Path "D:\zz\yguc\yguc-biz\src\main\java\com\sunshine\procurement\controller\LogisticsController.java"`
3. 修改脚本中的 `PROJECT_PATH` 和 `TARGET_FILE` 常量

### Q4: 脚本报错 "等待响应超时 300000ms"

**原因**: 模型响应时间过长或卡住

**解决方案**:
1. 增加 `TURN_TIMEOUT_MS` 到更大的值（如 600000 = 10 分钟）
2. 检查最后状态输出，确认模型是否在正常工作
3. 手动检查 VSCode 中的 LoopAgent 界面，查看是否有错误提示

### Q5: 工具调用或推理内容为空

**原因**: DOM 选择器不匹配或 Webview 结构变化

**解决方案**:
1. 手动打开 LoopAgent Webview 的开发者工具
2. 检查 DOM 结构，确认选择器是否正确：
   - `.reasoning-content` - 推理内容
   - `.tool-call-entry` - 工具调用条目
   - `.assistant-answer` - 最终回答
3. 更新脚本中的选择器

## 自定义测试

### 修改测试项目和文件

编辑 `scripts/run-java-logistics-e2e.mjs`:

```javascript
// 目标项目和文件路径
const PROJECT_PATH = "D:\\your\\project\\path";
const TARGET_FILE = "D:\\your\\project\\path\\src\\YourFile.java";
```

### 修改测试提示词

编辑 `scripts/run-java-logistics-e2e.mjs`:

```javascript
// 测试提示词
const TEST_PROMPT = "你的自定义问题";
```

### 修改超时时间

编辑 `scripts/run-java-logistics-e2e.mjs`:

```javascript
const TURN_TIMEOUT_MS = 600_000; // 10 分钟
```

## 技术细节

### CDP 架构

```
Node.js 测试脚本
    ↓ WebSocket
VSCode CDP 服务器 (端口 9333)
    ↓
  ┌─────────────────┐
  │  Workbench      │ ← 主窗口（打开文件、执行命令）
  │  Target         │
  └─────────────────┘
    ↓
  ┌─────────────────┐
  │  Webview        │ ← LoopAgent UI（提交问题、捕获回答）
  │  Target         │
  └─────────────────┘
```

### 同步求值模式

CDP 的 `Runtime.evaluate` 在 Webview 上下文变化后会回收挂起的 Promise，因此脚本使用**同步求值模式**：

1. 所有注入的 JavaScript 代码保持同步（不使用 `awaitPromise: true`）
2. 需要等待的地方回到 Node.js 侧使用 `delay()`
3. 通过 `syncEval()` 辅助函数访问 Webview 的 `document` 和 `window`

```javascript
const WEBVIEW_DOCUMENT = `const webviewDocument =
  document.getElementById("active-frame")?.contentDocument ?? document;
const webviewWindow = webviewDocument.defaultView;`;

function syncEval(body) {
  return `(() => {
    ${WEBVIEW_DOCUMENT}
    if (!webviewWindow) return { ok: false, reason: "webview window missing" };
    ${body}
  })()`;
}
```

### 工具调用捕获

脚本通过轮询 DOM 结构捕获工具调用：

```javascript
const toolCalls = [...(turn?.querySelectorAll(".tool-call-entry") ?? [])].map((entry) => {
  return {
    name: entry.querySelector(".tool-call-name")?.textContent?.trim() ?? "",
    input: entry.querySelector(".tool-call-input")?.textContent?.trim() ?? "",
    output: entry.querySelector(".tool-call-output")?.textContent?.trim() ?? "",
    status: [...entry.classList].find((name) => name.startsWith("tool-call-"))
  };
});
```

## 相关文件

- **CDP 客户端**: [scripts/cdpClient.mjs](../scripts/cdpClient.mjs)
- **测试脚本**: [scripts/run-java-logistics-e2e.mjs](../scripts/run-java-logistics-e2e.mjs)
- **启动脚本**: [scripts/run-java-logistics-test.ps1](../scripts/run-java-logistics-test.ps1)
- **其他 E2E 测试**: [scripts/run-multi-file-edit-e2e.mjs](../scripts/run-multi-file-edit-e2e.mjs)

## 扩展阅读

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [VSCode Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
