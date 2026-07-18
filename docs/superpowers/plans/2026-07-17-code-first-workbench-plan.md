# 代码优先智能体工作台实施计划

> **面向 Agent 执行者：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐项执行；所有步骤使用复选框追踪。

**目标：** 将 LoopAgent 侧栏改造成在窄宽度下易于追踪任务、执行过程和回答的代码优先工作台。

**架构：** 保持 App 作为唯一状态容器，复用已有 startTask 消息和模型选择。任务建议调用共享提交函数；执行步骤的展开状态仅在助手消息组件内管理。样式只使用 VS Code CSS 变量，不引入依赖或图片资源。

**技术栈：** TypeScript、React 19、CSS、Vitest、Testing Library、VS Code Webview。

## 全局约束

- 仅修改 src/webview/App.tsx、src/webview/styles.css、test/App.test.tsx 与本计划的实施记录。
- 不修改 WebviewToHostMessage、HostToWebviewMessage、Extension Host、模型配置或 Agent runtime。
- 不增加依赖、图标库、图片资源、持久化、任务历史或新的面板。
- 保持现有模型菜单、思考模式、流式回答、失败提示和运行中禁用语义。
- 所有交互控件必须可键盘操作并沿用 VS Code 主题变量。
- 仅使用一个 Extension Development Host，并通过 npm run debug:vscode 启动。

---

## 文件范围

- src/webview/App.tsx：提交入口、状态栏、空状态建议和助手步骤折叠行为。
- src/webview/styles.css：紧凑、主题感知的工作台布局。
- test/App.test.tsx：建议任务提交和完成后步骤折叠回归测试。
- docs/superpowers/plans/2026-07-17-code-first-workbench-plan.md：记录实际验证结果。

---

## Task 1：锁定并实现任务建议与执行状态

**Files：**

- Modify: test/App.test.tsx
- Modify: src/webview/App.tsx

**Consumes：** RunModelSelection、VsCodeApi.postMessage、现有 handleSubmit 与 AssistantTurn.status。

**Produces：** submitTask(task: string)、TaskSuggestions 与受控的助手步骤折叠状态；所有任务仍通过 { type: "startTask", task, model } 发往 Host。

- [x] **步骤 1：写入建议任务的失败测试**

在 test/App.test.tsx 的 LoopAgent webview app 组中加入：

~~~tsx
it("submits a suggested workspace task", async () => {
  const user = userEvent.setup();
  const postMessage = vi.fn<(message: WebviewToHostMessage) => void>();
  render(<App vscodeApi={{ postMessage }} />);

  await user.click(screen.getByRole("button", { name: "Explain the active file" }));

  expect(postMessage).toHaveBeenCalledWith({
    type: "startTask",
    task: "Explain the active file",
    model: { provider: "deepseek", model: "deepseek-v4-flash", thinking: "disabled" },
  });
  expect(screen.getByText("Explain the active file")).toBeInTheDocument();
});
~~~

- [x] **步骤 2：运行测试确认红灯**

~~~powershell
npm test -- --run test/App.test.tsx
~~~

预期：新增用例因缺少 Explain the active file 按钮失败，其他用例继续通过。

- [x] **步骤 3：写入完成后折叠的失败测试**

在同一文件加入：

~~~tsx
it("collapses completed execution steps", () => {
  render(<App />);
  postHostMessage({ type: "runStarted", runId: "run-1", task: "Inspect the project" });
  postHostMessage({ type: "assistantStarted", runId: "run-1", provider: "DeepSeek" });
  postHostMessage({ type: "assistantThinking", runId: "run-1", message: "Reading files" });
  postHostMessage({ type: "runFinished", runId: "run-1" });

  expect(screen.getByText("Process").closest("details")).not.toHaveAttribute("open");
});
~~~

- [x] **步骤 4：再次运行测试确认红灯**

~~~powershell
npm test -- --run test/App.test.tsx
~~~

预期：新增折叠用例失败，因为完成后 details 仍保持展开。

- [x] **步骤 5：在 App.tsx 实现最小交互**

将当前提交主体提取为共享函数，表单只阻止默认行为：

~~~tsx
function submitTask(task: string) {
  const trimmedMessage = task.trim();
  if (!trimmedMessage || isRunning) return;

  const runModel: RunModelSelection = {
    ...selectedModel.selection,
    thinking: effectiveThinkingMode,
  };
  setIsRunning(true);
  setActiveRunId(null);
  setOpenMenu(null);
  setTurns((currentTurns) => [
    ...currentTurns,
    { id: createTurnId("user"), role: "user", content: trimmedMessage, pending: true },
  ]);
  setMessage("");
  vscodeApi.postMessage({ type: "startTask", task: trimmedMessage, model: runModel });
}

function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  submitTask(message);
}
~~~

在空状态渲染以下组件，两个按钮均调用 `submitTask`：

~~~tsx
const suggestedTasks = ["Explain the active file", "Find where this is implemented"];

function TaskSuggestions({ onSelect }: { onSelect(task: string): void }) {
  return (
    <div className="task-suggestions" aria-label="Suggested tasks">
      {suggestedTasks.map((task) => (
        <button key={task} type="button" className="suggestion-button" onClick={() => onSelect(task)}>
          {task}
        </button>
      ))}
    </div>
  );
}
~~~

顶部展示以下状态与当前模型，不再渲染 `activeRunId`：

~~~tsx
<div className="header-meta">
  <span className={`status-pill status-${isRunning ? "running" : "ready"}`}>
    <span className="status-dot" aria-hidden="true" />
    {isRunning ? "Running" : "Ready"}
  </span>
  <span className="active-model">{selectedModel.label}</span>
</div>
~~~

在 `AssistantMessage` 的函数体开头添加完成后自动折叠、同时允许手动开关的状态：

~~~tsx
const [isProcessOpen, setIsProcessOpen] = React.useState(turn.status !== "done");
const previousStatus = React.useRef(turn.status);

React.useEffect(() => {
  if (turn.status === "done" && previousStatus.current !== "done") {
    setIsProcessOpen(false);
  }
  previousStatus.current = turn.status;
}, [turn.status]);
~~~

将现有步骤元素替换为：

~~~tsx
<details
  className="process-details"
  open={isProcessOpen}
  onToggle={(event) => setIsProcessOpen(event.currentTarget.open)}
>
  <summary>Process</summary>
  <ol>{turn.process.map((item) => <li key={item}>{item}</li>)}</ol>
</details>
~~~

- [x] **步骤 6：运行测试确认绿灯并提交**

~~~powershell
npm test -- --run test/App.test.tsx
git add -- src/webview/App.tsx test/App.test.tsx
git commit -m "feat(ui): add code-first task flow"
~~~

预期：test/App.test.tsx 全部通过，建议任务使用既有消息契约发送，步骤在完成后折叠，流式回答和失败显示未回归。

---

## Task 2：完成紧凑的主题感知布局

**Files：**

- Modify: src/webview/styles.css

**Consumes：** Task 1 的状态栏、任务建议、message-* 与 process-details 类名。

**Produces：** 不依赖 JavaScript 尺寸计算的紧凑侧栏布局，支持深色、浅色和最大 340px 窄宽度。

- [x] **步骤 1：实现最小 CSS 调整**

保留现有类名，在 styles.css 中加入或调整：

~~~css
.app-shell { gap: 8px; padding: 8px; }
.app-header { border-bottom: 0; padding-bottom: 0; }
.message-user {
  background: var(--vscode-input-background);
  border-color: transparent;
  max-width: 94%;
}
.message-assistant {
  background: transparent;
  border-color: transparent;
  padding-inline: 2px;
}
.process-details {
  background: var(--vscode-textBlockQuote-background, transparent);
  border-left-color: var(--vscode-textLink-foreground, #3794ff);
  padding: 6px 8px;
}
.header-meta,
.task-suggestions {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.header-meta { align-items: center; justify-content: flex-end; }
.active-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-dot {
  background: var(--vscode-testing-iconPassed);
  border-radius: 50%;
  display: inline-block;
  height: 6px;
  margin-right: 5px;
  width: 6px;
}
.status-running .status-dot { background: var(--vscode-charts-yellow); }
.task-suggestions { flex-wrap: wrap; justify-content: center; }
.suggestion-button {
  background: var(--vscode-textBlockQuote-background, transparent);
  border: 1px solid var(--vscode-panel-border, transparent);
  color: var(--vscode-foreground);
  text-align: left;
}
~~~

为状态栏、建议按钮和输入工具栏补充规则；使用 min-width: 0、overflow-wrap: anywhere 和现有 @media (max-width: 340px)，使长模型名称、建议文案和发送按钮不溢出或覆盖。不得新增渐变、圆形装饰、图片或硬编码主题颜色。

- [x] **步骤 2：运行静态检查**

~~~powershell
npm run typecheck
npm run compile
~~~

预期：两条命令均以退出码 0 完成。

- [x] **步骤 3：在唯一调试窗口验收并提交**

~~~powershell
npm run debug:vscode
git add -- src/webview/styles.css
git commit -m "style(ui): refine agent workbench"
~~~

在启动的唯一 Extension Development Host 中打开 Activity Bar 的 LoopAgent 视图，检查两项建议可点击、提交后控件禁用、完成后步骤折叠、缩窄侧栏时顶部和输入区不重叠。检查完成后关闭调试窗口，再执行提交。

---

## Task 3：集中验证、清理与交付记录

**Files：**

- Modify: docs/superpowers/plans/2026-07-17-code-first-workbench-plan.md

**Consumes：** Task 1 和 Task 2 的已提交改动。

**Produces：** 只记录实际执行结果的中文验收记录。

- [x] **步骤 1：运行集中验证与清理检查**

~~~powershell
npm test
npm run typecheck
npm run compile
git diff --check
git status --short
rg -n -i "console\.log|TODO|TBD" src/webview test/App.test.tsx
~~~

预期：测试、类型检查、构建和 diff 格式检查全部通过，且没有本功能遗留的调试输出、占位标记或未跟踪构建产物。发现无关用户改动时不删除。

- [x] **步骤 2：写入实际验收记录并提交**

在本文档末尾增加 实施结果，只记录实际通过的命令、真实侧栏检查结论和未完成项（若存在）。然后运行：

~~~powershell
git add -- docs/superpowers/plans/2026-07-17-code-first-workbench-plan.md
git commit -m "docs(ui): record workbench verification"
~~~

---

## 实施结果

### 已交付变更

- Task 1 已由提交 `7bd1c72 feat(ui): add code-first task flow` 交付：添加两个任务建议，复用既有 `startTask` 消息契约，并在助手回合完成时折叠执行步骤。
- Task 2 已由提交 `1a519b9 style(ui): refine agent workbench` 交付：完成工作台的紧凑主题感知样式调整。

### 验证与清理

- Task 1 的聚焦测试 `npm test -- --run test/App.test.tsx` 报告 8/8 通过；当时的全量 `npm test` 报告 51 个测试文件、293 个测试通过，类型检查和 `git diff --check` 通过。
- Task 2 的 `npm run typecheck`、`npm run compile` 和 `git diff --check` 通过；固定 CSS 颜色搜索无匹配。
- 本次集中执行 `npm test`：51 个测试文件、293 个测试全部通过；`npm run typecheck`、`npm run compile` 与 `git diff --check` 均以退出码 0 完成。
- 写入本记录前，`git status --short` 无输出；`rg -n -i "console\\.log|TODO|TBD" src/webview test/App.test.tsx` 无匹配（退出码 1 按无匹配处理），未发现本功能的调试输出、占位标记或未跟踪构建产物。

### 侧栏验收与已知限制

- 已通过唯一的 Extension Development Host 启动并关闭完成侧栏检查。Computer Use 截图因 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)` 受阻；CDP 兜底截图确认空状态的两个建议、`Ready` 状态、当前模型和输入区均可见，320px Workbench 截图确认窄宽换行正常且内部无重叠。
- 本地假模型交互脚本在提交前未等待 React 的模型选择提交，因此沿用既有 DeepSeek 选择并以 `fetch failed` 结束。该脚本未验证发送禁用状态或成功完成后的折叠状态；两项行为由新增单元测试覆盖，未重复该交互或另启调试宿主。
