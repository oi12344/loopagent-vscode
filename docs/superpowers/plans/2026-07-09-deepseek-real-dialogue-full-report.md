# DeepSeek 真实对话完整提示词与回答记录

## 说明

- 测试日期：2026-07-09
- API key：未写入报告，测试时仅通过当前 PowerShell 进程环境变量注入。
- 记录范围：每题实际发送给 DeepSeek 的 `messages`，以及模型返回的完整文本回答。
- 注意：system prompt 内包含代码索引片段，内容来自当前 worktree 的 `src/` 源码。

## Q1 providerRegistry system prompt 串联

- 模型：`deepseek-chat`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`

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
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createCodeIntelligenceContext (src/extension/intelligence/context/codeIntelligenceContext.ts:34-40)
- function src/extension/model/modelRunner.ts::createModelRunner (src/extension/model/modelRunner.ts:11-73)
- function src/extension/model/modelRunner.ts::createMessages (src/extension/model/modelRunner.ts:75-89)
- function src/extension/runtime/codeRuntimeContext.ts::createSelectionExcerpt (src/extension/runtime/codeRuntimeContext.ts:229-242)

### 相关符号
- function src/extension/model/modelConfig.ts::getModelRuntimeConfig (src/extension/model/modelConfig.ts:24-45)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140)
- function src/extension/model/providerRegistry.ts::requireVsCodeApi (src/extension/model/providerRegistry.ts:54-56)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createTreeSitterParserRuntime (src/extension/intelligence/parser/treeSitterRuntime.ts:27-71)
- function src/extension/model/providers/deepseekProvider.ts::createDeepSeekProvider (src/extension/model/providers/deepseekProvider.ts:18-24)
- function src/extension/runtime/contextPrompt.ts::renderCodeRuntimeContextPrompt (src/extension/runtime/contextPrompt.ts:5-78)
- function src/extension/runtime/vscodeRuntimeContext.ts::collectVsCodeRuntimeContext (src/extension/runtime/vscodeRuntimeContext.ts:25-29)

### 关系
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelConfig.ts:function:getModelRuntimeConfig:24 @src/extension/model/providerRegistry.ts:27
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:createVsCodeWorkspaceIntelligence:49 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providerRegistry.ts:function:requireVsCodeApi:54 @src/extension/model/providerRegistry.ts:34
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/intelligence/parser/treeSitterRuntime.ts:function:createTreeSitterParserRuntime:27 @src/extension/model/providerRegistry.ts:35
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/providers/deepseekProvider.ts:function:createDeepSeekProvider:18 @src/extension/model/providerRegistry.ts:37
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/model/modelRunner.ts:function:createModelRunner:11 @src/extension/model/providerRegistry.ts:44
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/contextPrompt.ts:function:renderCodeRuntimeContextPrompt:5 @src/extension/model/providerRegistry.ts:47
- symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:22 --calls/exact--> symbol:src/extension/runtime/vscodeRuntimeContext.ts:function:collectVsCodeRuntimeContext:25 @src/extension/model/providerRegistry.ts:47
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
#### src/extension/agentRunner.ts:73-75
``\`typescript
function createRunId(): string {
  return `run-${Date.now().toString(36)}`;
}
``\`
#### src/extension/intelligence/context/codeIntelligenceContext.ts:34-40
``\`typescript
export function createCodeIntelligenceContext({
  query,
  graph,
  searchIndex,
  sourceProvider,
  maxChars = 8_000,
}: CreateCodeIntelligenceContextOptions): CodeIntelligenceResult {
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
          message: "Building code context",
        } satisfies HostToWebviewMessage;

        try {
          systemPrompts.push(await systemPromptProvider(request));
        } catch {
          yield {
            type: "assistantThinking",
            runId,
            message: "Code context unavailable",
          } satisfies HostToWebviewMessage;
        }
      }

      yield {
        type: "assistantThinking",
        runId,
        message: `Calling ${provider.displayName}`,
      } satisfies HostToWebviewMessage;

      const messages = createMessages(task, systemPrompts);
      let reportedReasoningSignal = false;

      for await (const event of provider.stream({ messages, signal })) {
        if (signal.aborted) {
          return;
        }

        if (event.type === "reasoningDelta" && !reportedReasoningSignal) {
          reportedReasoningSignal = true;
          yield {
            type: "assistantThinking",
            runId,
            message: "Received model reasoning signal",
          } satisfies HostToWebviewMessage;
        }

        if (event.type === "contentDelta") {
          yield {
            type: "assistantDelta",
            runId,
            content: event.content,
          } satisfies HostToWebviewMessage;
        }
      }

      yield { type: "assistantFinished", runId } satisfies HostToWebviewMessage;
      yield { type: "runFinished", runId } satisfies HostToWebviewMessage;
    },
  };
}
``\`
#### src/extension/model/modelRunner.ts:75-89
``\`typescript
function createMessages(task: string, systemPrompts: Array<string | undefined>): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const systemPrompt of systemPrompts) {
    const trimmedPrompt = systemPrompt?.trim();

    if (trimmedPrompt) {
      messages.push({ role: "system", content: trimmedPrompt });
    }
  }

  messages.push({ role: "user", content: task });

  return messages;
}
``\`
#### src/extension/runtime/codeRuntimeContext.ts:229-242
``\`typescript
function createSelectionExcerpt(
  selection: RuntimeSelection,
  text: string,
  budget: TextBudget,
): CodeRuntimeTextExcerpt {
  const excerpt = budget.take(text);

  return {
    startLine: selection.startLine,
    endLine: selection.endLine,
    text: excerpt.text,
    truncated: excerpt.truncated,
  };
}
``\`
#### src/extension/model/modelConfig.ts:24-45
``\`typescript
export async function getModelRuntimeConfig(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
): Promise<ModelRuntimeConfig> {
  const configuration = vscode.workspace.getConfiguration("loopagent.model");
  const provider = getConfiguredProviderId();
  const model = configuration.get<string>("model", "deepseek-v4-flash");
  const baseUrl = configuration.get<string>("baseUrl", "").trim() || undefined;
  const thinking = normalizeThinkingMode(configuration.get<string>("thinking", "disabled"));
  const config = createModelRuntimeConfig({
    provider,
    model,
    baseUrl,
    thinking,
  }, selection);
  const apiKey = await getModelApiKey(context, config.provider);

  return {
    ...config,
    apiKey,
  };
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
  }
}
``\`
#### src/extension/model/providerRegistry.ts:54-56
``\`typescript
function requireVsCodeApi(): VsCodeWorkspaceApi {
  return require("vscode") as VsCodeWorkspaceApi;
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
#### src/extension/model/providers/deepseekProvider.ts:18-24
``\`typescript
export function createDeepSeekProvider({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  thinking = DEFAULT_THINKING,
  fetch: fetchImpl,
}: DeepSeekProviderOptions): ModelProvider {
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
    for (const projectFile
``\`

### 语义索引预算
- 使用字符: 12000/12000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 providerRegistry.ts 里的 createConfiguredAgentRunner 如何把 runtime context、code intelligence 和 createModelRunner 串成模型 system prompt。
```

### 模型完整回答

```text
`createConfiguredAgentRunner` 内部将 `collectVsCodeRuntimeContext` 收集的运行时上下文，通过 `renderCodeRuntimeContextPrompt` 渲染；同时利用 `workspaceIntelligence.buildCodeIntelligencePrompt` 构建代码智能提示。最后，这两部分作为 `systemPromptProvider` 传入 `createModelRunner`，组合成模型 system prompt。
```

## Q2 LoopAgentChatViewProvider 复用 workspaceIntelligence

- 模型：`deepseek-chat`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`

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
- method src/extension.ts::LoopAgentChatViewProvider.if (src/extension.ts:108-110)

### 相关符号
- function src/extension/model/providerRegistry.ts::createConfiguredAgentRunner (src/extension/model/providerRegistry.ts:22-52)
- function src/extension/agentRunner.ts::startAgentRun (src/extension/agentRunner.ts:28-45)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::createVsCodeWorkspaceIntelligence (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:49-140)
- function src/extension/intelligence/parser/treeSitterRuntime.ts::createTreeSitterParserRuntime (src/extension/intelligence/parser/treeSitterRuntime.ts:27-71)
- function src/extension.ts::createNonce (src/extension.ts:150-159)
- function src/extension/webviewHtml.ts::createWebviewHtml (src/extension/webviewHtml.ts:8-47)

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
#### src/extension.ts:59-59
``\`typescript
  constructor(private readonly context: vscode.ExtensionContext) {}
``\`
#### src/extension.ts:61-92
``\`typescript
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
``\`
#### src/extension.ts:83-85
``\`typescript
      if (message.type === "startTask") {
        this.startRun(message, webviewView.webview);
      }
``\`
#### src/extension.ts:108-110
``\`typescript
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
``\`
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
#### src/extension/agentRunner.ts:28-45
``\`typescript
export function startAgentRun({ task, runner, postMessage, runId = createRunId() }: StartAgentRunOptions): AgentRunHandle {
  const abortController = new AbortController();
  const request: AgentRunRequest = {
    runId,
    task,
    signal: abortController.signal,
  };

  const done = pumpRunMessages(runner, request, postMessage);

  return {
    runId,
    cancel() {
      abortController.abort();
    },
    done,
  };
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
  }
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
#### src/extension.ts:150-159
``\`typescript
function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
``\`
#### src/extension/webviewHtml.ts:8-47
``\`typescript
export function createWebviewHtml({ cspSource, nonce, scriptUri, styleUri }: WebviewHtmlOptions): string {
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource};" />
    <style nonce="${nonce}">
      body {
        background: var(--vscode-editor-background, #1e1e1e);
        color: var(--vscode-editor-foreground, #d4d4d4);
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        margin: 0;
      }
      #root {
        height: 100vh;
      }
      .boot-error {
        color: var(--vscode-errorForeground, #f48771);
        white-space: pre-wrap;
      }
    </style>
    <link rel="stylesheet" href="${styleUri}" />
    <title>LoopAgent</title>
  </head>
  <body>
    <div id="root">Loading LoopAgent...</div>
    <script nonce="${nonce}">
      window.addEventListener("error", (event) => {
        const root = document.getElementById("root"
``\`

### 语义索引预算
- 使用字符: 12000/12000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 extension.ts 里的 LoopAgentChatViewProvider.startRun 如何复用 workspaceIntelligence。
```

### 模型完整回答

```text
在 `LoopAgentChatViewProvider` 构造函数中，`workspaceIntelligence` 被创建为实例属性。`startRun` 方法通过调用 `createConfiguredAgentRunner` 并将 `this.workspaceIntelligence` 作为依赖传入，实现了复用。这样，每次启动任务时都使用同一个工作区智能实例，避免重复创建。
```

## Q3 VS Code workspace 增量刷新

- 模型：`deepseek-chat`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`

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
- function src/extension/intelligence/context/codeIntelligenceContext.ts::createCodeIntelligenceContext (src/extension/intelligence/context/codeIntelligenceContext.ts:34-40)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWatcherCacheKey (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:135-139)
- function src/extension/intelligence/workspaceIntelligence.ts::createWorkspaceIntelligence (src/extension/intelligence/workspaceIntelligence.ts:57-226)
- function src/extension/intelligence/workspaceIntelligence.ts::createParsedSource (src/extension/intelligence/workspaceIntelligence.ts:228-236)
- function src/extension/intelligence/workspaceIntelligence.ts::createContentHash (src/extension/intelligence/workspaceIntelligence.ts:238-244)

### 相关符号
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::markDirty (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:122-126)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::markDeleted (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:128-133)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWorkspaceRoots (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:213-215)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::getWorkspaceRelativePath (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:217-227)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::isIndexableWorkspacePath (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:142-160)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::normalizePathSeparators (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:229-231)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::detectWorkspaceLanguageId (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:162-180)
- function src/extension/intelligence/vscodeWorkspaceIntelligence.ts::readSourceRangeFromText (src/extension/intelligence/vscodeWorkspaceIntelligence.ts:203-211)
- function src/extension/intelligence/languages/typescriptAdapter.ts::createTypeScriptAdapter (src/extension/intelligence/languages/typescriptAdapter.ts:16-25)
- function src/extension/intelligence/languages/pythonAdapter.ts::createPythonAdapter (src/extension/intelligence/languages/pythonAdapter.ts:46-55)
- function src/extension/intelligence/graph/semanticGraph.ts::createSemanticGraph (src/extension/intelligence/graph/semanticGraph.ts:14-121)
- function src/extension/intelligence/graph/searchIndex.ts::createSearchIndex (src/extension/intelligence/graph/searchIndex.ts:8-90)
- function src/extension/intelligence/workspaceIntelligence.ts::markPartial (src/extension/intelligence/workspaceIntelligence.ts:64-69)
- function src/extension/intelligence/workspaceIntelligence.ts::extractWorkspaceFile (src/extension/intelligence/workspaceIntelligence.ts:208-225)
- function src/extension/intelligence/workspaceIntelligence.ts::addEdgeWithinBudget (src/extension/intelligence/workspaceIntelligence.ts:186-198)
- function src/extension/intelligence/resolution/referenceResolver.ts::resolveReferences (src/extension/intelligence/resolution/referenceResolver.ts:10-32)
- function src/extension/intelligence/context/codeIntelligencePrompt.ts::renderCodeIntelligencePrompt (src/extension/intelligence/context/codeIntelligencePrompt.ts:3-47)

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
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:normalizePathSeparators:229 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:136
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRelativePath:217 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:137
- symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWatcherCacheKey:135 --calls/exact--> symbol:src/extension/intelligence/vscodeWorkspaceIntelligence.ts:function:getWorkspaceRoots:213 @src/extension/intelligence/vscodeWorkspaceIntelligence.ts:137
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/languages/typescriptAdapter.ts:function:createTypeScriptAdapter:16 @src/extension/intelligence/workspaceIntelligence.ts:58
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/languages/pythonAdapter.ts:function:createPythonAdapter:46 @src/extension/intelligence/workspaceIntelligence.ts:58
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/graph/semanticGraph.ts:function:createSemanticGraph:14 @src/extension/intelligence/workspaceIntelligence.ts:73
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/graph/searchIndex.ts:function:createSearchIndex:8 @src/extension/intelligence/workspaceIntelligence.ts:74
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:markPartial:64 @src/extension/intelligence/workspaceIntelligence.ts:108
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:markPartial:64 @src/extension/intelligence/workspaceIntelligence.ts:114
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:extractWorkspaceFile:208 @src/extension/intelligence/workspaceIntelligence.ts:119
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:markPartial:64 @src/extension/intelligence/workspaceIntelligence.ts:124
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:addEdgeWithinBudget:186 @src/extension/intelligence/workspaceIntelligence.ts:138
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:markPartial:64 @src/extension/intelligence/workspaceIntelligence.ts:149
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/resolution/referenceResolver.ts:function:resolveReferences:10 @src/extension/intelligence/workspaceIntelligence.ts:158
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/workspaceIntelligence.ts:function:addEdgeWithinBudget:186 @src/extension/intelligence/workspaceIntelligence.ts:159
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligenceContext.ts:function:createCodeIntelligenceContext:34 @src/extension/intelligence/workspaceIntelligence.ts:164
- symbol:src/extension/intelligence/workspaceIntelligence.ts:function:createWorkspaceIntelligence:57 --calls/exact--> symbol:src/extension/intelligence/context/codeIntelligencePrompt.ts:function:renderCodeIntelligencePrompt:3 @src/extension/intelligence/workspaceIntelligence.ts:175

### 源码片段
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
  }
}
``\`
#### src/extension/intelligence/context/codeIntelligenceContext.ts:34-40
``\`typescript
export function createCodeIntelligenceContext({
  query,
  graph,
  searchIndex,
  sourceProvider,
  maxChars = 8_000,
}: CreateCodeIntelligenceContextOptions): CodeIntelligenceResult {
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:135-139
``\`typescript
  function getWatcherCacheKey(uri: WorkspaceUri): string {
    return normalizePathSeparators(
      getWorkspaceRelativePath(vscodeApi, uri, getWorkspaceRoots(vscodeApi.workspace.workspaceFolders)),
    );
  }
``\`
#### src/extension/intelligence/workspaceIntelligence.ts:57-226
``\`typescript
export function createWorkspaceIntelligence(deps: WorkspaceIntelligenceDeps): WorkspaceIntelligence {
  const adapters = [createTypeScriptAdapter(), createPythonAdapter()];
  const budgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  const extractionCacheByFile = new Map<string, CachedExtraction>();
  let status: CodeIndexStatus = "idle";
  let diagnostics: IndexDiagnostic[] = [];

  function markPartial(filePath: string, message: string): void {
    if (status !== "failed") {
      status = "partial";
    }
    diagnostics.push({ filePath, severity: "warning", message });
  }

  return {
    async buildCodeIntelligencePrompt(query) {
      const graph = createSemanticGraph();
      const searchIndex = createSearchIndex();
      const importBindings: ImportBinding[] = [];
      const unresolvedReferences: UnresolvedReference[] = [];
      diagnostics = [];
      status = "indexing";
      let indexedFiles = 0;
      let nodeCount = 0;
      let edgeCount = 0;
      let unresolvedReferenceCount = 0;
      let stopIndexing = false;
      let edgeBudgetExceeded = false;
      let unresolvedReferenceBudgetExceeded = false;

      try {
        const files = await deps.readWorkspaceFiles();
        const currentFilePaths = new Set(files.map((file) => file.path));
        for (const cachedFilePath of extractionCacheByFile.keys()) {
          if (!currentFilePaths.has(cachedFilePath)) {
            extractionCacheByFile.delete(cachedFilePath);
          }
        }

        for (const file of files) {
          if (stopIndexing) {
            break;
          }

          const adapter = adapters.find((candidate) => candidate.languageIds.includes(file.languageId));
          if (!adapter) {
            extractionCacheByFile.delete(file.path);
            continue;
          }

          if (indexedFiles >= budgets.maxFiles) {
            markPartial(file.path, `达到索引文件数上限 ${budgets.maxFiles}，停止继续索引。`);
            break;
          }

          if (Buffer.byteLength(file.text, "utf8") > budgets.maxFileBytes) {
            extractionCacheByFile.delete(file.path);
            markPartial(file.path, `文件超过 ${budgets.maxFileBytes} 字节上限，已跳过解析。`);
            continue;
          }

          indexedFiles += 1;
          const result = await extractWorkspaceFile(file, adapter);
          diagnostics.push(...result.diagnostics);

          for (const node of result.nodes) {
            if (nodeCount >= budgets.maxNodes) {
              markPartial(file.path, `达到节点数上限 ${budgets.maxNodes}，停止继续索引。`);
              stopIndexing = true;
              break;
            }
            graph.upsertNode(node);
            searchIndex.addNode(node);
            nodeCount += 1;
          }

          if (stopIndexing) {
            break;
          }

          for (const edge of result.edges) {
            if (!addEdgeWithinBudget(edge, file.path)) {
              break;
            }
          }

          importBindings.push(...result.importBindings);
          for (const reference of result.unresolvedReferences) {
            if (unresolvedReferenceBudgetExceeded) {
              break;
            }
            if (unresolvedReferenceCount >= budgets.maxUnresolvedReferences) {
              markPartial(file.path, `达到未解析引用数上限 ${budgets.maxUnresolvedReferences}，停止记录新引用。`);
              unresolvedReferenceBudgetExceeded = true;
              break;
            }
            unresolvedReferences.push(reference);
            unresolvedReferenceCount += 1;
          }
        }

        for (const edge of resolveReferences({ graph, references: unresolvedReferences, importBindings })) {
          if (!addEdgeWithinBudget(edge, edge.filePath ?? "<workspace>")) {
            break;
          }
        }

        const result = createCodeIntelligenceContext({
          query,
          graph,
          searchIndex,
          sourceProvider: deps.readSourceRange,
          maxChars: budgets.maxPromptChars,
        });

        if (status === "indexing") {
          status = "ready";
        }
        return renderCodeIntelligencePrompt(result);
      } catch (error) {
        status = "failed";
        diagnostics.push({
          filePath: "<workspace>",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return "";
      }

      function addEdgeWithinBudget(edge: CodeEdge, filePath: string): boolean {
        if (edgeBudgetExceeded) {
          return false;
        }
        if (edgeCount >= budgets.maxEdges) {
          markPartial(filePath, `达到边数上限 ${budgets.maxEdges}，停止新增边。`);
          edgeBudgetExceeded = true;
          return false;
        }
        graph.upsertEdge(edge);
        edgeCount += 1;
        return true;
      }
    },
    getStatus() {
      return status;
    },
    getDiagnostics() {
      return diagnostics.map((diagnostic) => ({ ...diagnostic }));
    },
  };

  async function extractWorkspaceFile(file: WorkspaceSourceFile, adapter: LanguageAdapter): Promise<ExtractionResult> {
    const contentHash = createContentHash(file.text);
    const cached = extractionCacheByFile.get(file.path);
    if (cached?.languageId === file.languageId && cached.contentHash === contentHash) {
      return cached.result;
    }

    const parsed = deps.parserRuntime
      ? await deps.parserRuntime.parse(file.path, file.languageId, file.text)
      : createParsedSource(file.path, file.languageId, file.text);
    const extracted = adapter.extract(parsed);
    const result = {
      ...extracted,
      diagnostics: [...parsed.diagnostics, ...extracted.diagnostics],
    };
    extractionCacheByFile.set(file.path, { languageId: file.languageId, contentHash, result });
    return result;
  }
}
``\`
#### src/extension/intelligence/workspaceIntelligence.ts:228-236
``\`typescript
function createParsedSource(filePath: string, languageId: string, text: string): ParsedSource {
  return {
    filePath,
    languageId,
    text,
    tree: undefined,
    diagnostics: [],
  };
}
``\`
#### src/extension/intelligence/workspaceIntelligence.ts:238-244
``\`typescript
function createContentHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `${text.length}:${hash}`;
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:122-126
``\`typescript
  function markDirty(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    dirtyPaths.add(cacheKey);
    deletedPaths.delete(cacheKey);
  }
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:128-133
``\`typescript
  function markDeleted(uri: WorkspaceUri): void {
    const cacheKey = getWatcherCacheKey(uri);
    sourceCache.delete(cacheKey);
    dirtyPaths.delete(cacheKey);
    deletedPaths.add(cacheKey);
  }
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:213-215
``\`typescript
function getWorkspaceRoots(workspaceFolders: readonly WorkspaceFolder[] | undefined): string[] {
  return workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:217-227
``\`typescript
function getWorkspaceRelativePath(
  vscodeApi: VsCodeWorkspaceApi,
  uri: WorkspaceUri,
  workspaceRoots: readonly string[],
): string {
  const vscodeRelativePath = vscodeApi.workspace.asRelativePath?.(uri, false);
  if (vscodeRelativePath) {
    return normalizePathSeparators(vscodeRelativePath);
  }
  return normalizeWorkspaceRelativePath(uri.fsPath, workspaceRoots);
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:142-160
``\`typescript
export function isIndexableWorkspacePath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";

  if (
    parts.some(
      (part) => part === ".git" || part === "node_modules" || part === "dist" || part.startsWith(".local-vscode-"),
    )
  ) {
    return false;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return false;
  }

  return !/(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i.test(fileName);
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:229-231
``\`typescript
function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:162-180
``\`typescript
export function detectWorkspaceLanguageId(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  if (normalized.endsWith(".tsx")) {
    return "typescriptreact";
  }
  if (normalized.endsWith(".ts")) {
    return "typescript";
  }
  if (normalized.endsWith(".jsx")) {
    return "javascriptreact";
  }
  if (normalized.endsWith(".js")) {
    return "javascript";
  }
  if (normalized.endsWith(".py")) {
    return "python";
  }
  return undefined;
}
``\`
#### src/extension/intelligence/vscodeWorkspaceIntelligence.ts:203-211
``\`typescript
export function readSourceRangeFromText(text: string, startLine: number
``\`

### 语义索引预算
- 使用字符: 12000/12000
- 是否截断: 是
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createVsCodeWorkspaceIntelligence 如何用 watcher 和缓存处理源码增量刷新。
```

### 模型完整回答

```text
createVsCodeWorkspaceIntelligence 通过 `watcher` 监听文件变更（创建/修改触发 `markDirty`，删除触发 `markDeleted`）。读取文件时，优先从 `sourceCache` 获取缓存文本，仅当 `dirtyPaths` 包含该路径时才重新读取并更新缓存，实现增量刷新。
```

## Q4 Tree-sitter 多语言 wasm 加载

- 模型：`deepseek-chat`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`

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
- function src/extension/intelligence/parser/treeSitterRuntime.ts::initializeParser (src/extension/intelligence/parser/treeSitterRuntime.ts:73-86)

### 相关符号
- function src/extension/intelligence/parser/treeSitterRuntime.ts::normalizeLanguageId (src/extension/intelligence/parser/treeSitterRuntime.ts:88-93)

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
#### src/extension/intelligence/parser/treeSitterRuntime.ts:1-118
``\`typescript
import path from "node:path";

import { Language, Parser } from "web-tree-sitter";

import type { IndexDiagnostic } from "../graph/graphTypes";
import type { ParsedSource, ParserRuntime } from "./parserRuntime";

export type TreeSitterLanguageId = "typescript" | "typescriptreact" | "javascript" | "javascriptreact" | "python";

export type TreeSitterParserRuntimeOptions = {
  wasmDirectory?: string;
  parserWasmPath?: string;
  grammarWasmDirectory?: string;
  languageWasmPaths?: Partial<Record<TreeSitterLanguageId, string>>;
};

const LANGUAGE_WASM_BY_ID: Record<TreeSitterLanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

const initPromises = new Map<string, Promise<void>>();

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

function initializeParser(parserWasmPath: string): Promise<void> {
  const existing = initPromises.get(parserWasmPath);
  if (existing) {
    return existing;
  }

  const promise = Parser.init({
    locateFile(scriptName: string) {
      return scriptName.endsWith(".wasm") ? parserWasmPath : scriptName;
    },
  });
  initPromises.set(parserWasmPath, promise);
  return promise;
}

function normalizeLanguageId(languageId: string): TreeSitterLanguageId | undefined {
  if (languageId in LANGUAGE_WASM_BY_ID) {
    return languageId as TreeSitterLanguageId;
  }
  return undefined;
}

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
#### src/extension/intelligence/parser/treeSitterRuntime.ts:73-86
``\`typescript
function initializeParser(parserWasmPath: string): Promise<void> {
  const existing = initPromises.get(parserWasmPath);
  if (existing) {
    return existing;
  }

  const promise = Parser.init({
    locateFile(scriptName: string) {
      return scriptName.endsWith(".wasm") ? parserWasmPath : scriptName;
    },
  });
  initPromises.set(parserWasmPath, promise);
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
- 使用字符: 6823/12000
- 是否截断: 否
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createTreeSitterParserRuntime 如何加载多语言 wasm grammar。
```

### 模型完整回答

```text
`createTreeSitterParserRuntime` 通过 `loadLanguage` 加载多语言 wasm grammar：根据语言 ID 在 `LANGUAGE_WASM_BY_ID` 或 `languageWasmPaths` 中查找对应的 wasm 文件路径，然后调用 `Language.load(wasmPath)` 异步加载并缓存结果。
```

## Q5 OpenAI-compatible SSE 流解析

- 模型：`deepseek-chat`
- 完成状态：`true`
- 索引状态：`ready`
- diagnostics：`[]`
- prompt 缺失项：`[]`

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
- function src/extension/model/openAiCompatibleClient.ts::createOpenAiCompatibleClient (src/extension/model/openAiCompatibleClient.ts:23-31)
- function src/extension/model/openAiCompatibleClient.ts::createHttpError (src/extension/model/openAiCompatibleClient.ts:96-115)
- file src/extension/model/openAiCompatibleClient.ts (src/extension/model/openAiCompatibleClient.ts:1-218)
- function src/extension/model/openAiCompatibleClient.ts::readErrorMessage (src/extension/model/openAiCompatibleClient.ts:117-124)
- function src/extension/model/openAiCompatibleClient.ts::findEventSeparator (src/extension/model/openAiCompatibleClient.ts:161-174)
- function src/extension/model/openAiCompatibleClient.ts::getSeparatorLength (src/extension/model/openAiCompatibleClient.ts:176-178)

### 相关符号
- class src/extension/model/types.ts::ModelProviderError (src/extension/model/types.ts:43-53)
- function src/extension/model/openAiCompatibleClient.ts::extractEventData (src/extension/model/openAiCompatibleClient.ts:180-187)
- function src/extension/model/openAiCompatibleClient.ts::parseChunk (src/extension/model/openAiCompatibleClient.ts:189-195)
- function src/extension/model/openAiCompatibleClient.ts::trimTrailingSlash (src/extension/model/openAiCompatibleClient.ts:215-217)

### 关系
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:readErrorMessage:117 @src/extension/model/openAiCompatibleClient.ts:97
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:101
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:103
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:105
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:107
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:109
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:111
- symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:113
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createOpenAiCompatibleClient:23 @src/extension/model/openAiCompatibleClient.ts:23
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 @src/extension/model/openAiCompatibleClient.ts:96
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:readErrorMessage:117 @src/extension/model/openAiCompatibleClient.ts:117
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:findEventSeparator:161 @src/extension/model/openAiCompatibleClient.ts:161
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:getSeparatorLength:176 @src/extension/model/openAiCompatibleClient.ts:176
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:extractEventData:180 @src/extension/model/openAiCompatibleClient.ts:180
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseChunk:189 @src/extension/model/openAiCompatibleClient.ts:189
- file:src/extension/model/openAiCompatibleClient.ts --contains/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:trimTrailingSlash:215 @src/extension/model/openAiCompatibleClient.ts:215
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:trimTrailingSlash:215 @src/extension/model/openAiCompatibleClient.ts:56
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:createHttpError:96 @src/extension/model/openAiCompatibleClient.ts:73
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/types.ts:class:ModelProviderError:43 @src/extension/model/openAiCompatibleClient.ts:77
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:parseChunk:189 @src/extension/model/openAiCompatibleClient.ts:89
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:findEventSeparator:161 @src/extension/model/openAiCompatibleClient.ts:138
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:getSeparatorLength:176 @src/extension/model/openAiCompatibleClient.ts:142
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:extractEventData:180 @src/extension/model/openAiCompatibleClient.ts:143
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:findEventSeparator:161 @src/extension/model/openAiCompatibleClient.ts:149
- file:src/extension/model/openAiCompatibleClient.ts --calls/exact--> symbol:src/extension/model/openAiCompatibleClient.ts:function:extractEventData:180 @src/extension/model/openAiCompatibleClient.ts:154

### 源码片段
#### src/extension/model/openAiCompatibleClient.ts:23-31
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
#### src/extension/model/openAiCompatibleClient.ts:1-218
``\`typescript
import { ModelProviderError, type ModelMessage, type ModelProvider, type ModelRequest } from "./types";

type OpenAiCompatibleClientOptions = {
  id?: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  body?: Record<string, unknown>;
};

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: unknown;
};

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

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || response.statusText || "request failed";
  } catch {
    return response.statusText || "request failed";
  }
}

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = findEventSeparator(buffer);

    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + getSeparatorLength(buffer, separatorIndex));
      const data = extractEventData(rawEvent);

      if (data.length > 0) {
        yield data;
      }

      separatorIndex = findEventSeparator(buffer);
    }
  }

  buffer += decoder.decode();
  const data = extractEventData(buffer);

  if (data.length > 0) {
    yield data;
  }
}

function findEventSeparator(buffer: string): number {
  const windowsIndex = buffer.indexOf("\r\n\r\n");
  const unixIndex = buffer.indexOf("\n\n");

  if (windowsIndex === -1) {
    return unixIndex;
  }

  if (unixIndex === -1) {
    return windowsIndex;
  }

  return Math.min(windowsIndex, unixIndex);
}

function getSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function extractEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
}

function parseChunk(chunk: string): ChatCompletionChunk {
  try {
    return JSON.parse(chunk) as ChatCompletionChunk;
  } catch (error) {
    throw new ModelProviderError("request_failed", `Could not parse model stream chunk: ${String(error)}`);
  }
}

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

  if (chunk.usage) {
    yield { type: "usage" as const, usage: chunk.usage };
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
#### src/extension/model/openAiCompatibleClient.ts:161-174
``\`typescript
function findEventSeparator(buffer: string): number {
  const windowsIndex = buffer.indexOf("\r\n\r\n");
  const unixIndex = buffer.indexOf("\n\n");

  if (windowsIndex === -1) {
    return unixIndex;
  }

  if (unixIndex === -1) {
    return windowsIndex;
  }

  return Math.min(windowsIndex, unixIndex);
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:176-178
``\`typescript
function getSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}
``\`
#### src/extension/model/types.ts:43-53
``\`typescript
export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly status?: number;

  constructor(code: ModelProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.status = status;
  }
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:180-187
``\`typescript
function extractEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:189-195
``\`typescript
function parseChunk(chunk: string): ChatCompletionChunk {
  try {
    return JSON.parse(chunk) as ChatCompletionChunk;
  } catch (error) {
    throw new ModelProviderError("request_failed", `Could not parse model stream chunk: ${String(error)}`);
  }
}
``\`
#### src/extension/model/openAiCompatibleClient.ts:215-217
``\`typescript
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
``\`

### 语义索引预算
- 使用字符: 8627/12000
- 是否截断: 否
```

#### message[1] role=user

```text
请基于代码上下文，用不超过120字说明 createOpenAiCompatibleClient 如何解析 DeepSeek SSE 流并输出 assistantDelta。
```

### 模型完整回答

```text
`createOpenAiCompatibleClient` 通过 `parseServerSentEvents` 将 DeepSeek SSE 流按分隔符拆分为 data 行，再经 `extractEventData` 和 `parseChunk` 解析为 `ChatCompletionChunk` 对象。最后 `mapChunkEvents` 将 `delta.content` 和 `delta.reasoning_content` 分别输出为 `{ type: "contentDelta" }` 和 `{ type: "reasoningDelta" }` 的 assistantDelta。
```
