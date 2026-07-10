# DeepSeek 预算层后真实对话测试报告

## 说明

- 测试日期：2026-07-09
- API key：未写入报告，测试时仅通过当前 PowerShell 进程环境变量注入。
- 测试目标：验证语义上下文预算层生效后，真实发送给 DeepSeek 的 prompt 长度是否下降，同时关键上下文是否仍完整命中。
- 记录范围：每题实际发送给 DeepSeek 的完整 `messages`，以及模型返回的完整文本回答。
- 对比基线：`2026-07-09-deepseek-real-dialogue-full-report.md`，即预算层之前的真实 DeepSeek transcript。

## 汇总

| 编号 | 模式 | system chars | 旧 system chars | 降幅 | 源码片段数 | 关系数 | prompt 缺失项 | 回答字符数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Q1 | `focused-source` | 13799 | 16974 | 18.7% | 4 | 17 | `[]` | 223 |
| Q2 | `focused-source` | 12584 | 16024 | 21.5% | 5 | 21 | `[]` | 234 |
| Q3 | `focused-source` | 17660 | 24761 | 28.7% | 3 | 28 | `[]` | 157 |
| Q4 | `focused-source` | 8070 | 12214 | 33.9% | 5 | 14 | `[]` | 219 |
| Q5 | `focused-source` | 11829 | 16055 | 26.3% | 5 | 28 | `[]` | 246 |

## Q1 providerRegistry system prompt 串联

- 模型：`deepseek-chat`
- 上下文模式：`focused-source`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`
- system prompt 字符数：`13799`
- 预算层前 system prompt 字符数：`16974`
- 长度降幅：`18.7%`
- 源码片段数：`4`
- 关系数：`17`

### 用户问题

```text
请基于代码上下文，用不超过120字说明 providerRegistry.ts 里的 createConfiguredAgentRunner 如何把 runtime context、code intelligence 和 createModelRunner 串成模型 system prompt。
```

### 实际发送给模型的 messages

#### message[0] role=system

```text
## 代码语义索引上下文

查询: 请基于代码上下文，用不超过120字说明 providerRegistry.ts 里的 createConfiguredAgentRunner 如何把 runtime context、code intelligence 和 createModelRunner 串成模型 system prompt。

### 入口符号
- function src/extension/model/providerRegistry.ts::createConfiguredAgentRunner (src/extension/model/providerRegistry.ts:22-52)
- function src/extension/agentRunner.ts::createRunId (src/extension/agentRunner.ts:73-75)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createCodeIntelligenceContext (src/extension/intelligence/context/codeIntelligenceContext.ts:36-137)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createQueryTermFallbackSnippet (src/extension/intelligence/context/codeIntelligenceContext.ts:157-192)
- function src/extension/model/modelRunner.ts::createModelRunner (src/extension/model/modelRunner.ts:11-73)

### 相关符号
- function src/extension/model/modelConfig.ts::getModelRuntimeConfig (src/extension/model/modelConfig.ts:24-45)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140)
- function src/extension/model/providerRegistry.ts::requireVsCodeApi (src/extension/model/providerRegistry.ts:54-56)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createTreeSitterParserRuntime (src/extension/intelligence/parser/treeSitterRuntime.ts:27-71)
- function src/extension/model/providers/deepseekProvider.ts::createDeepSeekProvider (src/extension/model/providers/deepseekProvider.ts:18-48)
- function src/extension/runtime/contextPrompt.ts::renderCodeRuntimeContextPrompt (src/extension/runtime/contextPrompt.ts:5-78)
- function src/extension/runtime/vscodeRuntimeContext.ts::collectVsCodeRuntimeContext (src/extension/runtime/vscodeRuntimeContext.ts:25-29)
- function src/extension/intelligence/context/contextBudget.ts::evaluateCodeIntelligenceBudget (src/extension/intelligence/context/contextBudget.ts:15-60)
- function src/extension/intelligence/graph/graphTraverser.ts::expandFromNodes (src/extension/intelligence/graph/graphTraverser.ts:9-39)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::extractQueryTerms (src/extension/intelligence/context/codeIntelligenceContext.ts:139-146)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::rankSnippetNodes (src/extension/intelligence/context/codeIntelligenceContext.ts:208-220)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::clipLines (src/extension/intelligence/context/codeIntelligenceContext.ts:269-280)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::selectMissingTermFallback (src/extension/intelligence/context/codeIntelligenceContext.ts:194-206)
- function src/extension/model/modelRunner.ts::createMessages (src/extension/model/modelRunner.ts:75-89)

### 关系
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelConfig.ts:function:getModelRuntimeConfig:24 @src/extension/model/providerRegistry.ts:27
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providerRegistry.ts:function:requireVsCodeApi:54 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 @src/extension/model/providerRegistry.ts:35
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providers/deepseekProvider.ts:function:createDeepSeekProvider:18 @src/extension/model/providerRegistry.ts:37
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelRunner.ts:function:createModelRunner:11 @src/extension/model/providerRegistry.ts:44
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/contextPrompt.ts:function:renderCodeRuntimeContextPrompt:5 @src/extension/model/providerRegistry.ts:47
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/vscodeRuntimeContext.ts:function:collectVsCodeRuntimeContext:25 @src/extension/model/providerRegistry.ts:47
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/contextBudget.ts:function:evaluateCodeIntelligenceBudget:15 @src/extension/intelligence/context/codeIntelligenceContext.ts:43
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/graph/graphTraverser.ts:function:expandFromNodes:9 @src/extension/intelligence/context/codeIntelligenceContext.ts:48
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:extractQueryTerms:139 @src/extension/intelligence/context/codeIntelligenceContext.ts:57
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:rankSnippetNodes:208 @src/extension/intelligence/context/codeIntelligenceContext.ts:61
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:clipLines:269 @src/extension/intelligence/context/codeIntelligenceContext.ts:68
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createQueryTermFallbackSnippet:157 @src/extension/intelligence/context/codeIntelligenceContext.ts:69
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createQueryTermFallbackSnippet:157 @src/extension/intelligence/context/codeIntelligenceContext.ts:101
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:selectMissingTermFallback:194 @src/extension/intelligence/context/codeIntelligenceContext.ts:113
- symbol:src/extension/model/modelRunner.ts:function:createModelRunner:11 --calls/exact--> symbol:src/extension/model/modelRunner.ts:function:createMessages:75 @src/extension/model/modelRunner.ts:43

### 源码片段
#### src/extension/model/providerRegistry.ts:22-52
``\`typescript
export async function createConfiguredAgentRunner(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
  deps: CreateConfiguredAgentRunnerDeps = {},
): Promise<AgentRunner> {
  const config = await getModelRuntimeConfig(context, selection);
  if (config.provider === "fake") {
    return fakeAgentRunner;
  }

  const workspaceIntelligence =
    deps.workspaceIntelligence ??
    createVsCodeWorkspaceIntelligence(deps.vscodeApi ?? requireVsCodeApi(), {
      parserRuntime: deps.parserRuntime ?? createTreeSitterParserRuntime(),
    });
  const provider = createDeepSeekProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    thinking: config.thinking,
  });

  return createModelRunner({
    provider,
    systemPromptProvider: async (request) => {
      const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
      const codePrompt = await workspaceIntelligence.buildCodeIntelligencePrompt(request.task);
      return [runtimePrompt, codePrompt].filter(Boolean).join("\n\n");
    },
  });
}
``\`
#### src/extension/intelligence/parser/treeSitterRuntime.ts:27-71
``\`typescript
export function createTreeSitterParserRuntime(options: TreeSitterParserRuntimeOptions = {}): ParserRuntime {
  const wasmDirectory = options.wasmDirectory ?? path.join(__dirname, "tree-sitter");
  const parserWasmPath = options.parserWasmPath ?? path.join(wasmDirectory, "web-tree-sitter.wasm");
  const grammarWasmDirectory = options.grammarWasmDirectory ?? wasmDirectory;
  const languages = new Map<TreeSitterLanguageId, Promise<Language>>();

  return {
    async parse(filePath, languageId, text) {
      const normalizedLanguageId = normalizeLanguageId(languageId);
      if (!normalizedLanguageId) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(filePath, `Tree-sitter 不支持语言 ${languageId}，已降级为轻量抽取。`),
        ]);
      }

      try {
        await initializeParser(parserWasmPath);
        const language = await loadLanguage(normalizedLanguageId);
        const parser = new Parser();
        parser.setLanguage(language);
        return createParsedSource(filePath, languageId, text, parser.parse(text), []);
      } catch (error) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(
            filePath,
            `Tree-sitter 解析失败，已降级为轻量抽取：${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
      }
    },
  };

  function loadLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
    const existing = languages.get(languageId);
    if (existing) {
      return existing;
    }

    const wasmPath =
      options.languageWasmPaths?.[languageId] ?? path.join(grammarWasmDirectory, LANGUAGE_WASM_BY_ID[languageId]);
    const promise = Language.load(wasmPath);
    languages.set(languageId, promise);
    return promise;
  }
}
``\`
#### src/extension/runtime/contextPrompt.ts:5-78
``\`typescript
export function renderCodeRuntimeContextPrompt(context: CodeRuntimeContext): string {
  if (!hasUsefulContext(context)) {
    return "";
  }

  const lines: string[] = [
    "当前 VS Code 工作区只读上下文如下。该上下文不是完整仓库；回答时优先结合用户请求、活动文件和选区。",
    "",
  ];

  lines.push("## 工作区");
  if (context.workspace.name) {
    lines.push(`- 名称: ${context.workspace.name}`);
  }
  if (context.workspace.roots.length > 0) {
    lines.push(`- 根目录: ${context.workspace.roots.join(", ")}`);
  }

  if (context.activeEditor) {
    lines.push("", "## 活动文件");
    lines.push(`- 路径: ${context.activeEditor.path}`);
    lines.push(`- 语言: ${context.activeEditor.languageId}`);
    lines.push(`- 行数: ${context.activeEditor.lineCount}`);
    if (context.activeEditor.cursor) {
      lines.push(`- 光标: ${context.activeEditor.cursor.line}:${context.activeEditor.cursor.character}`);
    }
    if (context.activeEditor.isDirty) {
      lines.push("- 状态: 未保存");
    }

    appendExcerpt(lines, context.activeEditor.selection, context.activeEditor.languageId, "选区");
    appendExcerpt(lines, context.activeEditor.snippet, context.activeEditor.languageId, "光标附近代码");
  }

  if (context.visibleEditors.length > 0) {
    lines.push("", "## 可见编辑器");
    for (const editor of context.visibleEditors) {
      lines.push(`- ${editor.path} (${editor.languageId}${editor.isDirty ? ", 未保存" : ""})`);
    }
  }

  if (context.openTabs.length > 0) {
    lines.push("", "## 打开的文件");
    for (const tab of context.openTabs) {
      const metadata = [tab.languageId, tab.isDirty ? "未保存" : undefined, tab.isPinned ? "固定" : undefined]
        .filter(Boolean)
        .join(", ");
      lines.push(metadata ? `- ${tab.path} (${metadata})` : `- ${tab.path}`);
    }
  }

  if (context.projectFiles.length > 0) {
    lines.push("", "## 项目文件摘要");
    for (const projectFile of context.projectFiles) {
      lines.push(`### ${projectFile.path} (${projectFile.kind}${projectFile.truncated ? ", 已截断" : ""})`);
      lines.push("``\`text", sanitizeCodeBlock(projectFile.summary), "``\`");
    }
  }

  if (context.diagnostics.length > 0) {
    lines.push("", "## 诊断");
    for (const diagnostic of context.diagnostics) {
      lines.push(
        `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.severity}: ${diagnostic.message}`,
      );
    }
  }

  lines.push("", "## 上下文预算");
  lines.push(`- 使用字符: ${context.budget.usedChars}/${context.budget.maxChars}`);
  lines.push(`- 是否截断: ${context.budget.truncated ? "是" : "否"}`);

  return lines.join("\n").trim();
}
``\`
#### src/extension/model/modelRunner.ts:11-73
``\`typescript
export function createModelRunner({ provider, systemPrompt, systemPromptProvider }: CreateModelRunnerOptions): AgentRunner {
  return {
    run: async function* (request) {
      const { runId, task, signal } = request;
      yield { type: "runStarted", runId, task } satisfies HostToWebviewMessage;
      yield { type: "assistantStarted", runId, provider: provider.displayName } satisfies HostToWebviewMessage;

      const systemPrompts = [systemPrompt];
      if (systemPromptProvider) {
        yield {
          type: "assistantThinking",
          runId,
          message: "Building code context"
``\`

### 语义索引预算
- 上下文模式: focused-source (implementation-explanation-query)
- 源码片段: 4/5
- 使用字符: 6000/6000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 providerRegistry.ts 里的 createConfiguredAgentRunner 如何把 runtime context、code intelligence 和 createModelRunner 串成模型 system prompt。
```

### 模型完整回答

```text
`createConfiguredAgentRunner` 在 `systemPromptProvider` 中串联三者：先调用 `collectVsCodeRuntimeContext` 生成 runtime prompt，再调用 `workspaceIntelligence.buildCodeIntelligencePrompt` 生成 code prompt，最后将两者拼接作为 model runner 的 system prompt。
```

## Q2 LoopAgentChatViewProvider 复用 workspaceIntelligence

- 模型：`deepseek-chat`
- 上下文模式：`focused-source`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`
- system prompt 字符数：`12584`
- 预算层前 system prompt 字符数：`16024`
- 长度降幅：`21.5%`
- 源码片段数：`5`
- 关系数：`21`

### 用户问题

```text
请基于代码上下文，用不超过120字说明 extension.ts 里的 LoopAgentChatViewProvider.startRun 如何复用 workspaceIntelligence。
```

### 实际发送给模型的 messages

#### message[0] role=system

```text
## 代码语义索引上下文

查询: 请基于代码上下文，用不超过120字说明 extension.ts 里的 LoopAgentChatViewProvider.startRun 如何复用 workspaceIntelligence。

### 入口符号
- method src/extension.ts::LoopAgentChatViewProvider.startRun (src/extension.ts:94-113)
- class src/extension.ts::LoopAgentChatViewProvider (src/extension.ts:53-114)
- method src/extension.ts::LoopAgentChatViewProvider.constructor (src/extension.ts:59-59)
- method src/extension.ts::LoopAgentChatViewProvider.resolveWebviewView (src/extension.ts:61-92)
- method src/extension.ts::LoopAgentChatViewProvider.if (src/extension.ts:83-85)

### 相关符号
- function src/extension/model/providerRegistry.ts::createConfiguredAgentRunner (src/extension/model/providerRegistry.ts:22-52)
- function src/extension/agentRunner.ts::startAgentRun (src/extension/agentRunner.ts:28-45)
- method src/extension.ts::LoopAgentChatViewProvider.if (src/extension.ts:108-110)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createTreeSitterParserRuntime (src/extension/intelligence/parser/treeSitterRuntime.ts:27-71)
- function src/extension.ts::createNonce (src/extension.ts:150-159)
- function src/extension/webviewHtml.ts::createWebviewHtml (src/extension/webviewHtml.ts:8-47)
- function src/extension/model/modelConfig.ts::getModelRuntimeConfig (src/extension/model/modelConfig.ts:24-45)
- function src/extension/model/providerRegistry.ts::requireVsCodeApi (src/extension/model/providerRegistry.ts:54-56)
- function src/extension/model/providers/deepseekProvider.ts::createDeepSeekProvider (src/extension/model/providers/deepseekProvider.ts:18-48)
- function src/extension/model/modelRunner.ts::createModelRunner (src/extension/model/modelRunner.ts:11-73)
- function src/extension/runtime/contextPrompt.ts::renderCodeRuntimeContextPrompt (src/extension/runtime/contextPrompt.ts:5-78)
- function src/extension/runtime/vscodeRuntimeContext.ts::collectVsCodeRuntimeContext (src/extension/runtime/vscodeRuntimeContext.ts:25-29)
- function src/extension/agentRunner.ts::pumpRunMessages (src/extension/agentRunner.ts:47-71)

### 关系
- symbol:src/extension.ts:method:startRun:94 --calls/exact--> symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 @src/extension.ts:97
- symbol:src/extension.ts:method:startRun:94 --calls/exact--> symbol:src/extension/agentRunner.ts:function:startAgentRun:28 @src/extension.ts:100
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --contains/exact--> symbol:src/extension.ts:method:constructor:59 @src/extension.ts:59
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --contains/exact--> symbol:src/extension.ts:method:resolveWebviewView:61 @src/extension.ts:61
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --contains/exact--> symbol:src/extension.ts:method:if:83 @src/extension.ts:83
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --contains/exact--> symbol:src/extension.ts:method:startRun:94 @src/extension.ts:94
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --contains/exact--> symbol:src/extension.ts:method:if:108 @src/extension.ts:108
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 @src/extension.ts:55
- symbol:src/extension.ts:class:LoopAgentChatViewProvider:53 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 @src/extension.ts:56
- symbol:src/extension.ts:method:resolveWebviewView:61 --calls/exact--> symbol:src/extension.ts:function:createNonce:150 @src/extension.ts:73
- symbol:src/extension.ts:method:resolveWebviewView:61 --calls/exact--> symbol:src/extension/webviewHtml.ts:function:createWebviewHtml:8 @src/extension.ts:75
- symbol:src/extension.ts:method:if:83 --calls/exact--> symbol:src/extension.ts:method:startRun:94 @src/extension.ts:84
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelConfig.ts:function:getModelRuntimeConfig:24 @src/extension/model/providerRegistry.ts:27
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providerRegistry.ts:function:requireVsCodeApi:54 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 @src/extension/model/providerRegistry.ts:35
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providers/deepseekProvider.ts:function:createDeepSeekProvider:18 @src/extension/model/providerRegistry.ts:37
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelRunner.ts:function:createModelRunner:11 @src/extension/model/providerRegistry.ts:44
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/contextPrompt.ts:function:renderCodeRuntimeContextPrompt:5 @src/extension/model/providerRegistry.ts:47
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/vscodeRuntimeContext.ts:function:collectVsCodeRuntimeContext:25 @src/extension/model/providerRegistry.ts:47
- symbol:src/extension/agentRunner.ts:function:startAgentRun:28 --calls/exact--> symbol:src/extension/agentRunner.ts:function:pumpRunMessages:47 @src/extension/agentRunner.ts:36

### 源码片段
#### src/extension.ts:94-113
``\`typescript
  private startRun(message: Extract<WebviewToHostMessage, { type: "startTask" }>, webview: vscode.Webview): void {
    this.activeRun?.cancel();

    void createConfiguredAgentRunner(this.context, message.model, {
      workspaceIntelligence: this.workspaceIntelligence,
    }).then((runner) => {
      const run = startAgentRun({
        task: message.task,
        runner,
        postMessage: (hostMessage) => webview.postMessage(hostMessage),
      });

      this.activeRun = run;
      void run.done.finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
      });
    });
  }
``\`
#### src/extension.ts:53-114
``\`typescript
class LoopAgentChatViewProvider implements vscode.WebviewViewProvider {
  private activeRun: AgentRunHandle | undefined;
  private readonly workspaceIntelligence = createVsCodeWorkspaceIntelligence(vscode, {
    parserRuntime: createTreeSitterParserRuntime(),
  });

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };

    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const nonce = createNonce();

    webviewView.webview.html = createWebviewHtml({
      cspSource: webviewView.webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
    });

    const messageSubscription = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === "startTask") {
        this.startRun(message, webviewView.webview);
      }
    });

    webviewView.onDidDispose(() => {
      this.activeRun?.cancel();
      messageSubscription.dispose();
    });
  }

  private startRun(message: Extract<WebviewToHostMessage, { type: "startTask" }>, webview: vscode.Webview): void {
    this.activeRun?.cancel();

    void createConfiguredAgentRunner(this.context, message.model, {
      workspaceIntelligence: this.workspaceIntelligence,
    }).then((runner) => {
      const run = startAgentRun({
        task: message.task,
        runner,
        postMessage: (hostMessage) => webview.postMessage(hostMessage),
      });

      this.activeRun = run;
      void run.done.finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
      });
    });
  }
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140
``\`typescript
export function createVsCodeWorkspaceIntelligence(
  vscodeApi: VsCodeWorkspaceApi,
  options: CreateVsCodeWorkspaceIntelligenceOptions = {},
): WorkspaceIntelligence {
  const sourceCache = new Map<string, string>();
  const dirtyPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxWorkspaceFiles = options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const { parserRuntime, maxWorkspaceFiles: _maxWorkspaceFiles, ...budgets } = options;

  const watcher = vscodeApi.workspace.createFileSystemWatcher?.(SOURCE_INCLUDE_PATTERN);
  watcher?.onDidCreate((uri) => markDirty(uri));
  watcher?.onDidChange((uri) => markDirty(uri));
  watcher?.onDidDelete((uri) => markDeleted(uri));

  return createWorkspaceIntelligence({
    budgets,
    parserRuntime,
    async readWorkspaceFiles() {
      const workspaceRoots = getWorkspaceRoots(vscodeApi.workspace.workspaceFolders);
      const uris = await vscodeApi.workspace.findFiles(SOURCE_INCLUDE_PATTERN, SOURCE_EXCLUDE_PATTERN, maxWorkspaceFiles);
      const files: WorkspaceSourceFile[] = [];
      const currentPaths = new Set<string>();

      for (const uri of uris) {
        const relativePath = getWorkspaceRelativePath(vscodeApi, uri, workspaceRoots);
        if (!isIndexableWorkspacePath(relativePath)) {
          continue;
        }

        const cacheKey = normalizePathSeparators(relativePath);
        if (deletedPaths.has(cacheKey)) {
          continue;
        }

        const languageId = detectWorkspaceLanguageId(relativePath);
        if (!languageId) {
          continue;
        }

        currentPaths.add(cacheKey);
        let text = sourceCache.get(cacheKey);
        if (text === undefined || dirtyPaths.has(cacheKey)) {
          const bytes = await vscodeApi.workspace.fs.readFile(uri);
          if (bytes.byteLength > maxFileBytes) {
            sourceCache.delete(cacheKey);
            dirtyPaths.delete(cacheKey);
            continue;
          }
          text = new TextDecoder().decode(bytes);
          sourceCache.set(cacheKey, text);
          dirtyPaths.delete(cacheKey);
        }

        files.push({ path: cacheKey, languageId, text });
      }

      for (const cachedPath of sourceCache.keys()) {
        if (!currentPaths.has(cachedPath)) {
          sourceCache.delete(cachedPath);
          dirtyPaths.delete(cachedPath);
          deletedPaths.delete(cachedPath);
        }
      }

      return files;
    },
    readSourceRange(filePath, startLine, endLine) {
      return readSourceRangeFromText(sourceCache.get(normalizePathSeparators(filePath)) ?? "", startLine, endLine);
    },
  });

  function markDirty(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    dirtyPaths.add(cacheKey);
    deletedPaths.delete(cacheKey);
  }

  function markDeleted(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    sourceCache.delete(cacheKey);
    dirtyPaths.delete(cacheKey);
    deletedPaths.add(cacheKey);
  }

  function getWatcherCacheKey(uri: WorkspaceUri): string {
    return normalizePathSeparators(
      getWorkspaceRelativePath(vscodeApi, uri, getWorkspaceRoots(vscodeApi.workspace.workspaceFolders)),
    );
``\`
#### src/extension.ts:59-59
``\`typescript
  constructor(private readonly context: vscode.ExtensionContext) {}
``\`
#### src/extension.ts:61-92
``\`typescript

``\`

### 语义索引预算
- 上下文模式: focused-source (implementation-explanation-query)
- 源码片段: 5/5
- 使用字符: 6000/6000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 extension.ts 里的 LoopAgentChatViewProvider.startRun 如何复用 workspaceIntelligence。
```

### 模型完整回答

```text
在 `LoopAgentChatViewProvider` 构造函数中，`workspaceIntelligence` 通过 `createVsCodeWorkspaceIntelligence` 创建并保存为实例属性。`startRun` 方法在调用 `createConfiguredAgentRunner` 时，将 `this.workspaceIntelligence` 作为参数传入，从而复用了已创建的 `workspaceIntelligence` 实例。
```

## Q3 VS Code workspace 增量刷新

- 模型：`deepseek-chat`
- 上下文模式：`focused-source`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`
- system prompt 字符数：`17660`
- 预算层前 system prompt 字符数：`24761`
- 长度降幅：`28.7%`
- 源码片段数：`3`
- 关系数：`28`

### 用户问题

```text
请基于代码上下文，用不超过120字说明 createVsCodeWorkspaceIntelligence 如何用 watcher 和缓存处理源码增量刷新。
```

### 实际发送给模型的 messages

#### message[0] role=system

```text
## 代码语义索引上下文

查询: 请基于代码上下文，用不超过120字说明 createVsCodeWorkspaceIntelligence 如何用 watcher 和缓存处理源码增量刷新。

### 入口符号
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createCodeIntelligenceContext (src/extension/intelligence/context/codeIntelligenceContext.ts:36-137)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createQueryTermFallbackSnippet (src/extension/intelligence/context/codeIntelligenceContext.ts:157-192)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWatcherCacheKey (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:135-139)
- function src/extension/intelligence/workspaceIntelligence.ts::createWorkspaceIntelligence (src/extension/intelligence/workspaceIntelligence.ts:57-226)

### 相关符号
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::markDirty (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:122-126)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::markDeleted (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:128-133)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWorkspaceRoots (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:213-215)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWorkspaceRelativePath (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:217-227)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::isIndexableWorkspacePath (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:142-160)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::normalizePathSeparators (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:229-231)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::detectWorkspaceLanguageId (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:162-180)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::readSourceRangeFromText (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:203-211)
- function src/extension/intelligence/context/contextBudget.ts::evaluateCodeIntelligenceBudget (src/extension/intelligence/context/contextBudget.ts:15-60)
- function src/extension/intelligence/graph/graphTraverser.ts::expandFromNodes (src/extension/intelligence/graph/graphTraverser.ts:9-39)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::extractQueryTerms (src/extension/intelligence/context/codeIntelligenceContext.ts:139-146)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::rankSnippetNodes (src/extension/intelligence/context/codeIntelligenceContext.ts:208-220)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::clipLines (src/extension/intelligence/context/codeIntelligenceContext.ts:269-280)
- function src/extension/intelligence/context/codeIntelligenceContext.ts::selectMissingTermFallback (src/extension/intelligence/context/codeIntelligenceContext.ts:194-206)

### 关系
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:markDirty:122 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:61
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:markDirty:122 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:62
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:markDeleted:128 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:63
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:65
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRoots:213 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:69
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRelativePath:217 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:75
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:isIndexableWorkspacePath:142 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:76
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:80
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:detectWorkspaceLanguageId:162 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:85
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:readSourceRangeFromText:203 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:118
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:118
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/contextBudget.ts:function:evaluateCodeIntelligenceBudget:15 @src/extension/intelligence/context/codeIntelligenceContext.ts:43
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/graph/graphTraverser.ts:function:expandFromNodes:9 @src/extension/intelligence/context/codeIntelligenceContext.ts:48
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:extractQueryTerms:139 @src/extension/intelligence/context/codeIntelligenceContext.ts:57
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:rankSnippetNodes:208 @src/extension/intelligence/context/codeIntelligenceContext.ts:61
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:clipLines:269 @src/extension/intelligence/context/codeIntelligenceContext.ts:68
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createQueryTermFallbackSnippet:157 @src/extension/intelligence/context/codeIntelligenceContext.ts:69
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createQueryTermFallbackSnippet:157 @src/extension/intelligence/context/codeIntelligenceContext.ts:101
- symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:selectMissingTermFallback:194 @src/extension/intelligence/context/codeIntelligenceContext.ts:113
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:136
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRelativePath:217 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:137
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRoots:213 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:137
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:36 @src/extension/intelligence/workspaceIntelligence.ts:164
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:markDirty:122 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:123
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:markDeleted:128 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:129
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRelativePath:217 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:224
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:isIndexableWorkspacePath:142 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:143
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:detectWorkspaceLanguageId:162 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:163

### 源码片段
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:135-139
``\`typescript
  function getWatcherCacheKey(uri: WorkspaceUri): string {
    return normalizePathSeparators(
      getWorkspaceRelativePath(vscodeApi, uri, getWorkspaceRoots(vscodeApi.workspace.workspaceFolders)),
    );
  }
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140
``\`typescript
export function createVsCodeWorkspaceIntelligence(
  vscodeApi: VsCodeWorkspaceApi,
  options: CreateVsCodeWorkspaceIntelligenceOptions = {},
): WorkspaceIntelligence {
  const sourceCache = new Map<string, string>();
  const dirtyPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxWorkspaceFiles = options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES;
  const { parserRuntime, maxWorkspaceFiles: _maxWorkspaceFiles, ...budgets } = options;

  const watcher = vscodeApi.workspace.createFileSystemWatcher?.(SOURCE_INCLUDE_PATTERN);
  watcher?.onDidCreate((uri) => markDirty(uri));
  watcher?.onDidChange((uri) => markDirty(uri));
  watcher?.onDidDelete((uri) => markDeleted(uri));

  return createWorkspaceIntelligence({
    budgets,
    parserRuntime,
    async readWorkspaceFiles() {
      const workspaceRoots = getWorkspaceRoots(vscodeApi.workspace.workspaceFolders);
      const uris = await vscodeApi.workspace.findFiles(SOURCE_INCLUDE_PATTERN, SOURCE_EXCLUDE_PATTERN, maxWorkspaceFiles);
      const files: WorkspaceSourceFile[] = [];
      const currentPaths = new Set<string>();

      for (const uri of uris) {
        const relativePath = getWorkspaceRelativePath(vscodeApi, uri, workspaceRoots);
        if (!isIndexableWorkspacePath(relativePath)) {
          continue;
        }

        const cacheKey = normalizePathSeparators(relativePath);
        if (deletedPaths.has(cacheKey)) {
          continue;
        }

        const languageId = detectWorkspaceLanguageId(relativePath);
        if (!languageId) {
          continue;
        }

        currentPaths.add(cacheKey);
        let text = sourceCache.get(cacheKey);
        if (text === undefined || dirtyPaths.has(cacheKey)) {
          const bytes = await vscodeApi.workspace.fs.readFile(uri);
          if (bytes.byteLength > maxFileBytes) {
            sourceCache.delete(cacheKey);
            dirtyPaths.delete(cacheKey);
            continue;
          }
          text = new TextDecoder().decode(bytes);
          sourceCache.set(cacheKey, text);
          dirtyPaths.delete(cacheKey);
        }

        files.push({ path: cacheKey, languageId, text });
      }

      for (const cachedPath of sourceCache.keys()) {
        if (!currentPaths.has(cachedPath)) {
          sourceCache.delete(cachedPath);
          dirtyPaths.delete(cachedPath);
          deletedPaths.delete(cachedPath);
        }
      }

      return files;
    },
    readSourceRange(filePath, startLine, endLine) {
      return readSourceRangeFromText(sourceCache.get(normalizePathSeparators(filePath)) ?? "", startLine, endLine);
    },
  });

  function markDirty(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    dirtyPaths.add(cacheKey);
    deletedPaths.delete(cacheKey);
  }

  function markDeleted(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    sourceCache.delete(cacheKey);
    dirtyPaths.delete(cacheKey);
    deletedPaths.add(cacheKey);
  }

  function getWatcherCacheKey(uri: WorkspaceUri): string {
    return normalizePathSeparators(
      getWorkspaceRelativePath(vscodeApi, uri, getWorkspaceRoots(vscodeApi.workspace.workspaceFolders)),
    );
``\`
#### src/extension/intelligence/context/codeIntelligenceContext.ts:36-137
``\`typescript
export function createCodeIntelligenceContext({
  query,
  graph,
  searchIndex,
  sourceProvider,
  maxChars = 8_000,
}: CreateCodeIntelligenceContextOptions): CodeIntelligenceResult {
  const profile = evaluateCodeIntelligenceBudget(query, maxChars);
  const entryNodes = searchIndex
    .search(query, profile.maxEntryNodes)
    .map((nodeId) => graph.getNode(nodeId))
    .filter((node): node is CodeNode => Boolean(node));
  const expanded = expandFromNodes(graph, entryNodes, profile.expandDepth);
  const entryNodeIds = new Set(entryNodes.map((node) => node.id));
  const relatedNodes = expanded.nodes.filter((node) => !entryNodeIds.has(node.id)).slice(0, profile.maxRelatedNodes);
  const visibleNodeIds = new Set([...entryNodes, ...relatedNodes].map((node) => node.id));
  const edges = expanded.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .slice(0, profile.maxEdges);
  const snippets: CodeIntelligenceSnippet[] = [];
  const fallbackCandidates: CodeIntelligenceSnippet[] = [];
  const queryTerms = extractQueryTerms(query);
  let usedChars = 0;
  let truncated = false;

  const snippetNodes = rankSnippetNodes([...entryNodes, ...relatedNodes], queryTerms, expanded.edges, entryNodeIds).slice(
    0,
    profile.maxSnippetNodes,
  );
  const snippetNodeIds = new Set(snippetNodes.map((node) => node.id));
  for (const node of snippetNodes) {
    const sourceText = sourceProvider(node.filePath, node.startLine, node.endLine);
    const lineClipped = clipLines(sourceText, profile.maxSnippetLines);
    const fallback = createQueryTermFallbackSnippet({
      filePath: node.filePath,
      startLine: node.startLine,
      sourceText,
      queryTerms,
      renderedText: lineClipped.text,
    });
    if (fallback) {
      fallbackCandidates.push(fallback);
    }
    const remaining = Math.max(0, profile.maxSnippetChars - usedChars);
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const clipped = lineClipped.text.slice(0, remaining);
    usedChars += clipped.length;
    truncated = truncated || lineClipped.truncated || clipped.length < lineClipped.text.length;
    snippets.push({
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      text: clipped,
    });
  }

  for (const node of [...entryNodes, ...relatedNodes]) {
    if (snippetNodeIds.has(node.id)) {
      continue;
    }
    const sourceText = sourceProvider(node.filePath, node.startLine, node.endLine);
    const
``\`

### 语义索引预算
- 上下文模式: focused-source (implementation-explanation-query)
- 源码片段: 3/5
- 使用字符: 6000/6000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createVsCodeWorkspaceIntelligence 如何用 watcher 和缓存处理源码增量刷新。
```

### 模型完整回答

```text
`createVsCodeWorkspaceIntelligence` 注册文件监听器 (`watcher`)，监听文件创建、修改、删除事件。事件触发时，将文件路径标记为脏 (`markDirty`) 或删除 (`markDeleted`)。读取文件时，先查缓存，若已脏或不存在则重新读取并更新缓存，实现增量刷新。
```

## Q4 Tree-sitter 多语言 wasm 加载

- 模型：`deepseek-chat`
- 上下文模式：`focused-source`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`
- system prompt 字符数：`8070`
- 预算层前 system prompt 字符数：`12214`
- 长度降幅：`33.9%`
- 源码片段数：`5`
- 关系数：`14`

### 用户问题

```text
请基于代码上下文，用不超过120字说明 createTreeSitterParserRuntime 如何加载多语言 wasm grammar。
```

### 实际发送给模型的 messages

#### message[0] role=system

```text
## 代码语义索引上下文

查询: 请基于代码上下文，用不超过120字说明 createTreeSitterParserRuntime 如何加载多语言 wasm grammar。

### 入口符号
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createTreeSitterParserRuntime (src/extension/intelligence/parser/treeSitterRuntime.ts:27-71)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createParsedSource (src/extension/intelligence/parser/treeSitterRuntime.ts:95-109)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createWarning (src/extension/intelligence/parser/treeSitterRuntime.ts:111-117)
- file src/extension/intelligence/parser/treeSitterRuntime.ts (src/extension/intelligence/parser/treeSitterRuntime.ts:1-118)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::loadLanguage (src/extension/intelligence/parser/treeSitterRuntime.ts:59-70)

### 相关符号
- function src/extension/intelligence/parser/treeSitterRuntime.ts::normalizeLanguageId (src/extension/intelligence/parser/treeSitterRuntime.ts:88-93)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::initializeParser (src/extension/intelligence/parser/treeSitterRuntime.ts:73-86)

### 关系
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:normalizeLanguageId:88 @src/extension/intelligence/parser/treeSitterRuntime.ts:35
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createParsedSource:95 @src/extension/intelligence/parser/treeSitterRuntime.ts:37
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createWarning:111 @src/extension/intelligence/parser/treeSitterRuntime.ts:38
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:initializeParser:73 @src/extension/intelligence/parser/treeSitterRuntime.ts:43
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:loadLanguage:59 @src/extension/intelligence/parser/treeSitterRuntime.ts:44
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createParsedSource:95 @src/extension/intelligence/parser/treeSitterRuntime.ts:47
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createParsedSource:95 @src/extension/intelligence/parser/treeSitterRuntime.ts:49
- symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createWarning:111 @src/extension/intelligence/parser/treeSitterRuntime.ts:50
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 @src/extension/intelligence/parser/treeSitterRuntime.ts:27
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:loadLanguage:59 @src/extension/intelligence/parser/treeSitterRuntime.ts:59
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:initializeParser:73 @src/extension/intelligence/parser/treeSitterRuntime.ts:73
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:normalizeLanguageId:88 @src/extension/intelligence/parser/treeSitterRuntime.ts:88
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createParsedSource:95 @src/extension/intelligence/parser/treeSitterRuntime.ts:95
- file:src/extension/intelligence/parser/treeSitterRuntime.ts --contains/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createWarning:111 @src/extension/intelligence/parser/treeSitterRuntime.ts:111

### 源码片段
#### src/extension/intelligence/parser/treeSitterRuntime.ts:27-71
``\`typescript
export function createTreeSitterParserRuntime(options: TreeSitterParserRuntimeOptions = {}): ParserRuntime {
  const wasmDirectory = options.wasmDirectory ?? path.join(__dirname, "tree-sitter");
  const parserWasmPath = options.parserWasmPath ?? path.join(wasmDirectory, "web-tree-sitter.wasm");
  const grammarWasmDirectory = options.grammarWasmDirectory ?? wasmDirectory;
  const languages = new Map<TreeSitterLanguageId, Promise<Language>>();

  return {
    async parse(filePath, languageId, text) {
      const normalizedLanguageId = normalizeLanguageId(languageId);
      if (!normalizedLanguageId) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(filePath, `Tree-sitter 不支持语言 ${languageId}，已降级为轻量抽取。`),
        ]);
      }

      try {
        await initializeParser(parserWasmPath);
        const language = await loadLanguage(normalizedLanguageId);
        const parser = new Parser();
        parser.setLanguage(language);
        return createParsedSource(filePath, languageId, text, parser.parse(text), []);
      } catch (error) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(
            filePath,
            `Tree-sitter 解析失败，已降级为轻量抽取：${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
      }
    },
  };

  function loadLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
    const existing = languages.get(languageId);
    if (existing) {
      return existing;
    }

    const wasmPath =
      options.languageWasmPaths?.[languageId] ?? path.join(grammarWasmDirectory, LANGUAGE_WASM_BY_ID[languageId]);
    const promise = Language.load(wasmPath);
    languages.set(languageId, promise);
    return promise;
  }
}
``\`
#### src/extension/intelligence/parser/treeSitterRuntime.ts:95-109
``\`typescript
function createParsedSource(
  filePath: string,
  languageId: string,
  text: string,
  tree: unknown,
  diagnostics: IndexDiagnostic[],
): ParsedSource {
  return {
    filePath,
    languageId,
    text,
    tree,
    diagnostics,
  };
}
``\`
#### src/extension/intelligence/parser/treeSitterRuntime.ts:111-117
``\`typescript
function createWarning(filePath: string, message: string): IndexDiagnostic {
  return {
    filePath,
    severity: "warning",
    message,
  };
}
``\`
#### src/extension/intelligence/parser/treeSitterRuntime.ts:59-70
``\`typescript
  function loadLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
    const existing = languages.get(languageId);
    if (existing) {
      return existing;
    }

    const wasmPath =
      options.languageWasmPaths?.[languageId] ?? path.join(grammarWasmDirectory, LANGUAGE_WASM_BY_ID[languageId]);
    const promise = Language.load(wasmPath);
    languages.set(languageId, promise);
    return promise;
  }
``\`
#### src/extension/intelligence/parser/treeSitterRuntime.ts:88-93
``\`typescript
function normalizeLanguageId(languageId: string): TreeSitterLanguageId | undefined {
  if (languageId in LANGUAGE_WASM_BY_ID) {
    return languageId as TreeSitterLanguageId;
  }
  return undefined;
}
``\`

### 语义索引预算
- 上下文模式: focused-source (implementation-explanation-query)
- 源码片段: 5/5
- 使用字符: 2793/6000
- 是否截断: 否
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createTreeSitterParserRuntime 如何加载多语言 wasm grammar。
```

### 模型完整回答

```text
createTreeSitterParserRuntime 通过 `loadLanguage` 函数加载多语言 wasm grammar。该函数从 `languages` 缓存中查找，若不存在则根据 `languageId` 从 `grammarWasmDirectory` 或 `languageWasmPaths` 获取 wasm 路径，调用 `Language.load(wasmPath)` 异步加载并缓存，支持按需加载多种语言。
```

## Q5 OpenAI-compatible SSE 流解析

- 模型：`deepseek-chat`
- 上下文模式：`focused-source`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`
- system prompt 字符数：`11829`
- 预算层前 system prompt 字符数：`16055`
- 长度降幅：`26.3%`
- 源码片段数：`5`
- 关系数：`28`

### 用户问题

```text
请基于代码上下文，用不超过120字说明 createOpenAiCompatibleClient 如何解析 DeepSeek SSE 流并输出 assistantDelta。
```

### 实际发送给模型的 messages

#### message[0] role=system

```text
## 代码语义索引上下文

查询: 请基于代码上下文，用不超过120字说明 createOpenAiCompatibleClient 如何解析 DeepSeek SSE 流并输出 assistantDelta。

### 入口符号
- function src/extension/model/openAiCompatibleClient.ts::createOpenAiCompatibleClient (src/extension/model/openAiCompatibleClient.ts:23-39)
- function src/extension/model/openAiCompatibleClient.ts::createHttpError (src/extension/model/openAiCompatibleClient.ts:96-115)
- file src/extension/model/openAiCompatibleClient.ts (src/extension/model/openAiCompatibleClient.ts:1-218)
- function src/extension/model/openAiCompatibleClient.ts::streamChatCompletion (src/extension/model/openAiCompatibleClient.ts:41-94)
- function src/extension/model/openAiCompatibleClient.ts::readErrorMessage (src/extension/model/openAiCompatibleClient.ts:117-124)

### 相关符号
- class src/extension/model/types.ts::ModelProviderError (src/extension/model/types.ts:43-53)
- function src/extension/model/openAiCompatibleClient.ts::parseServerSentEvents (src/extension/model/openAiCompatibleClient.ts:126-159)
- function src/extension/model/openAiCompatibleClient.ts::findEventSeparator (src/extension/model/openAiCompatibleClient.ts:161-174)
- function src/extension/model/openAiCompatibleClient.ts::getSeparatorLength (src/extension/model/openAiCompatibleClient.ts:176-178)
- function src/extension/model/openAiCompatibleClient.ts::extractEventData (src/extension/model/openAiCompatibleClient.ts:180-187)
- function src/extension/model/openAiCompatibleClient.ts::parseChunk (src/extension/model/openAiCompatibleClient.ts:189-195)
- function src/extension/model/openAiCompatibleClient.ts::mapChunkEvents (src/extension/model/openAiCompatibleClient.ts:197-213)
- function src/extension/model/openAiCompatibleClient.ts::trimTrailingSlash (src/extension/model/openAiCompatibleClient.ts:215-217)
- method src/extension/model/types.ts::ModelProviderError.constructor (src/extension/model/types.ts:47-52)

### 关系
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createOpenAiCompatibleClient:23 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 @src/extension/model/openAiCompatibleClient.ts:36
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:readErrorMessage:117 @src/extension/model/openAiCompatibleClient.ts:97
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:101
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:103
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:105
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:107
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:109
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:111
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:113
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createOpenAiCompatibleClient:23 @src/extension/model/openAiCompatibleClient.ts:23
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 @src/extension/model/openAiCompatibleClient.ts:41
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 @src/extension/model/openAiCompatibleClient.ts:96
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:readErrorMessage:117 @src/extension/model/openAiCompatibleClient.ts:117
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseServerSentEvents:126 @src/extension/model/openAiCompatibleClient.ts:126
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:findEventSeparator:161 @src/extension/model/openAiCompatibleClient.ts:161
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:getSeparatorLength:176 @src/extension/model/openAiCompatibleClient.ts:176
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:extractEventData:180 @src/extension/model/openAiCompatibleClient.ts:180
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseChunk:189 @src/extension/model/openAiCompatibleClient.ts:189
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:mapChunkEvents:197 @src/extension/model/openAiCompatibleClient.ts:197
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:trimTrailingSlash:215 @src/extension/model/openAiCompatibleClient.ts:215
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:trimTrailingSlash:215 @src/extension/model/openAiCompatibleClient.ts:56
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 @src/extension/model/openAiCompatibleClient.ts:73
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:77
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseServerSentEvents:126 @src/extension/model/openAiCompatibleClient.ts:80
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseChunk:189 @src/extension/model/openAiCompatibleClient.ts:89
- symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:41 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:mapChunkEvents:197 @src/extension/model/openAiCompatibleClient.ts:90
- symbol:src/extension/model/types.ts:class:ModelProviderError:43 --contains/exact--> symbol:src/extension/model/types.ts:method:constructor:47 @src/extension/model/types.ts:47
- symbol:src/extension/model/openAiCompatibleClient.ts:function:parseServerSentEvents:126 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:findEventSeparator:161 @src/extension/model/openAiCompatibleClient.ts:138

### 源码片段
#### src/extension/model/openAiCompatibleClient.ts:23-39
``\`typescript
export function createOpenAiCompatibleClient({
  id = "openai-compatible",
  displayName,
  baseUrl,
  apiKey,
  model,
  fetch: fetchImpl = fetch,
  body = {},
}: OpenAiCompatibleClientOptions): ModelProvider {
  return {
    id,
    displayName: displayName ?? model,
    stream(request) {
      return streamChatCompletion({ baseUrl, apiKey, model, fetchImpl, body, request });
    },
  };
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:96-115
``\`typescript
async function createHttpError(response: Response): Promise<ModelProviderError> {
  const message = await readErrorMessage(response);

  switch (response.status) {
    case 401:
      return new ModelProviderError("authentication_failed", "DeepSeek API authentication failed", response.status);
    case 402:
      return new ModelProviderError("insufficient_balance", "DeepSeek account balance is insufficient", response.status);
    case 422:
      return new ModelProviderError("invalid_parameters", `DeepSeek rejected the request parameters: ${message}`, response.status);
    case 429:
      return new ModelProviderError("rate_limited", "DeepSeek rate limit reached", response.status);
    case 500:
      return new ModelProviderError("server_error", "DeepSeek server returned an error", response.status);
    case 503:
      return new ModelProviderError("server_overloaded", "DeepSeek server is overloaded", response.status);
    default:
      return new ModelProviderError("request_failed", `Model request failed with HTTP ${response.status}: ${message}`, response.status);
  }
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:41-94
``\`typescript
async function* streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  fetchImpl,
  body,
  request,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  body: Record<string, unknown>;
  request: ModelRequest;
}) {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: request.messages satisfies ModelMessage[],
      stream: true,
      stream_options: { include_usage: true },
      ...body,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  if (!response.body) {
    throw new ModelProviderError("request_failed", "Model response did not include a readable body");
  }

  for await (const chunk of parseServerSentEvents(response.body)) {
    if (request.signal.aborted) {
      return;
    }

    if (chunk === "[DONE]") {
      return;
    }

    const parsedChunk = parseChunk(chunk);
    for (const event of mapChunkEvents(parsedChunk)) {
      yield event;
    }
  }
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:117-124
``\`typescript
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || response.statusText || "request failed";
  } catch {
    return response.statusText || "request failed";
  }
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:197-208
``\`typescript
function* mapChunkEvents(chunk: ChatCompletionChunk) {
  for (const choice of chunk.choices ?? []) {
    const reasoningContent = choice.delta?.reasoning_content;
    if (reasoningContent) {
      yield { type: "reasoningDelta" as const, content: reasoningContent };
    }

    const content = choice.delta?.content;
    if (content) {
      yield { type: "contentDelta" as const, content };
    }
  }
``\`

### 语义索引预算
- 上下文模式: focused-source (implementation-explanation-query)
- 源码片段: 5/5
- 使用字符: 3329/6000
- 是否截断: 否
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createOpenAiCompatibleClient 如何解析 DeepSeek SSE 流并输出 assistantDelta。
```

### 模型完整回答

```text
`createOpenAiCompatibleClient` 通过 `streamChatCompletion` 发起 SSE 流请求，使用 `parseServerSentEvents` 解析事件数据。对每个数据块，先检查是否为 `[DONE]`，再通过 `parseChunk` 转为 JSON，最后由 `mapChunkEvents` 提取 `choice.delta` 中的 `content` 和 `reasoning_content` 并输出为 `assistantDelta`。
```
