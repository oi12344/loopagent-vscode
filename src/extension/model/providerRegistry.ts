import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
import { createBrowseSymbolsTool } from "../agent/browseSymbolsTool";
import type { ReactAgentTool } from "../agent/reactTypes";
import type { ToolInvoker } from "../agent/toolRegistry";
import { createOpenAiReactModelTurn } from "../agent/openAiReactModelTurn";
import { createReactAgentRunner } from "../agent/reactAgentRunner";
import { createWorkflowTools } from "../agent/workflowTools";
import { createWorkflowOrchestrator, type WorkflowEvent } from "../agent/workflowOrchestrator";
import { classifyTask, getExecutionGuidance } from "../agent/taskClassifier";
import { createLayeredSystemPrompt, renderLayeredPrompt, compressLayeredPrompt } from "../agent/layeredSystemPrompt";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ParserRuntime } from "../intelligence/parser/parserRuntime";
import { createTreeSitterParserRuntime } from "../intelligence/parser/treeSitterRuntime";
import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import { createVsCodeWorkspaceIntelligence, type VsCodeWorkspaceApi } from "../intelligence/vscodeWorkspaceIntelligence";
import type { ProjectMemory } from "../memory/projectMemory";
import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";
import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";
import type { HostToWebviewMessage, RunMode, RunModelSelection } from "../../shared/messages";
import type { InterruptedRunCheckpoint } from "../../shared/chatTypes";
import { getModelRuntimeConfig } from "./modelConfig";
import { createDeepSeekProvider } from "./providers/deepseekProvider";
import { resolveRole } from "../agent/workflow/roleRegistry";
import type { ConversationStore } from "../conversation/conversationStore";
import type { ImageAnalysisService } from "../vision/imageAnalysisService";
import { createVisionAnalysisTool } from "../vision/visionAnalysisTool";
import type { VisionService } from "../vision/types";

const DIRECT_TOOL_GUIDANCE = [
  // --- Discovery ---
  "When you do not know what symbols exist in the codebase, call browseSymbols with a concept or partial name first to discover actual identifiers. Then use those exact names in exploreCode.",
  "When symbols are already known, call exploreCode directly with a concise, code-oriented query using likely English identifiers.",
  "Trace behavior from current production entry points. Ignore historical documents, tests, and unreferenced legacy modules unless the user explicitly asks about them.",

  // --- Directory Exploration ---
  "When exploring directory structure (finding modules, locating configuration files, understanding project layout), use listDirectory instead of runCommand('dir') or runCommand('ls').",
  "listDirectory returns structured output and is faster than shell commands for directory listing.",
  "For code-level queries (finding functions, classes, interfaces), prefer browseSymbols and exploreCode over directory traversal.",

  // --- Evidence sufficiency ---
  "After each tool result, judge whether the evidence is sufficient to answer the user's question. If it is, answer immediately without calling another tool.",
  "Call exploreCode again only for a concrete fact that is still missing. Use a query focused on that specific gap; do not repeat or overlap prior queries.",
  "Independent read-only lookups may be issued in a single turn.",

  // --- Editing ---
  "Before editing any file, read its current content with readFile.",
  "For changes that touch public interfaces, multiple call sites, or conventions you have not yet seen: use exploreCode to locate the closest existing implementation, then read that implementation, its direct callers, relevant types, and tests before writing.",
  "For single-file changes: if the file exports functions, types, or classes, search for their usages with exploreCode before editing. If the change is to private implementation details only, direct editing may suffice.",
  "Follow the discovered structure, naming, and error-handling patterns. If no reliable pattern exists, state the gap instead of inventing a new architecture.",
  "Propose all workspace changes through applyEdit. When evidence is insufficient (unfamiliar codebase, missing context, unclear impact), present your understanding and proposed approach first. When the change is well-scoped and you have verified all affected code, call applyEdit directly.",
  "Do not claim an edit succeeded until applyEdit reports that it was applied.",
  "Use runCommand to run tests, type checks, or builds when relevant to verify a change. Do not repeat a command the user has rejected.",

  // --- runCommand Auto-Recovery & Background Mode ---
  "runCommand returns structured JSON with alternatives when commands fail. Parse the JSON response to access:",
  "  - success: boolean indicating if the command succeeded",
  "  - error.type: categorized error (not_found, execution_failure, timeout, permission, buffer_overflow)",
  "  - error.alternatives: array of recovery strategies ranked by successProbability",
  "When runCommand fails, immediately parse error.alternatives and execute the first action where automation='auto' and successProbability>0.7.",
  "Do NOT ask the user for permission when alternatives have automation='auto' and risk='low' — execute them directly.",
  "Do NOT retry the same command more than 3 times. Switch strategies using the alternatives array instead.",
  "Example: mvn fails with 'command not found' → alternatives suggest './mvnw' with 0.95 probability → execute './mvnw' immediately.",
  "For long-running processes (servers, services, build tasks), use runCommand with background:true to prevent timeout termination. The process will detach and return immediately with its PID.",

  // --- Answer quality ---
  "Answer only from evidence returned by tools. State any material limitation when the evidence is insufficient.",
  "Do not invent repository facts.",
];

const REACT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
  ...DIRECT_TOOL_GUIDANCE,
].join("\n");

const PLAN_SYSTEM_PROMPT = [
  "You are LoopAgent in plan mode, a coding assistant working in the current VS Code workspace.",
  "Produce an ordered implementation plan grounded in the available read-only evidence.",
  "For each step, name the affected files and the verification command that should be run during execution.",
  "Do not edit files or run commands. Do not claim that changes or verification have been completed.",
  ...DIRECT_TOOL_GUIDANCE.slice(0, 10),
  "Answer only from evidence returned by tools. State any material limitation when the evidence is insufficient.",
].join("\n");

const AGENT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
  "When a task has independent parts that can be explored or executed concurrently, use spawnSubagent to delegate work:",
  "- explorer role: locate source code, symbols, call paths (read-only)",
  "- reviewer role: inspect code for defects and risks (read-only)",
  "- planner role: break work into ordered steps (read-only)",
  "- executor role: implement changes with applyEdit and runCommand",
  "Use waitForSubagents to collect results. Each subagent runs independently with its own tool access based on role.",
  ...DIRECT_TOOL_GUIDANCE,
].join("\n");

export type CreateConfiguredAgentRunnerDeps = {
  vscodeApi?: VsCodeWorkspaceApi;
  workspaceIntelligence?: WorkspaceIntelligence;
  parserRuntime?: ParserRuntime;
  readFileTool?: ReactAgentTool;
  listDirectoryTool?: ReactAgentTool;
  applyEditTool?: ReactAgentTool;
  runCommandTool?: ReactAgentTool;
  onCheckpoint?: (checkpoint: InterruptedRunCheckpoint) => void | Promise<void>;
  extraTools?: ReactAgentTool[];
  requiredToolNames?: string[];
  projectMemory?: ProjectMemory;
  enableWorkflowTools?: boolean;
  imageAnalysisService?: ImageAnalysisService;
  visionService?: VisionService;
  mode?: RunMode;
};

export async function createConfiguredAgentRunner(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
  deps: CreateConfiguredAgentRunnerDeps = {},
): Promise<AgentRunner> {
  const config = await getModelRuntimeConfig(context, selection);
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

  const browseSymbolsTool = createBrowseSymbolsTool(workspaceIntelligence);
  const readOnlyTools = [
    createExploreCodeTool(workspaceIntelligence),
    ...(browseSymbolsTool ? [browseSymbolsTool] : []),
    ...(deps.readFileTool ? [deps.readFileTool] : []),
    ...(deps.listDirectoryTool ? [deps.listDirectoryTool] : []),
  ];

  // 视觉子智能体：通过闭包访问当前请求的附件
  let currentAttachments: import("../../shared/messages").ImageAttachment[] | undefined;
  const visionTool = deps.visionService
    ? createVisionAnalysisTool({
        visionService: deps.visionService,
        getAttachments: () => currentAttachments,
      })
    : undefined;

  const parentTools = [
    ...readOnlyTools,
    ...(deps.applyEditTool ? [deps.applyEditTool] : []),
    ...(deps.runCommandTool ? [deps.runCommandTool] : []),
    ...(visionTool ? [visionTool] : []),
    ...(deps.extraTools ?? []),
  ];
  const mode = normalizeRunMode(deps.mode);
  const memoryGenerationByRunId = new Map<string, number>();

  // --- 缓存：runtime context 和 task classification 变化频率低，可复用 ---
  let cachedRuntimePrompt = "";
  let cachedRuntimePromptAt = 0;
  const RUNTIME_CACHE_TTL_MS = 5_000; // 5 秒内复用

  const cachedTaskGuidance = new Map<string, string>();

  const getRuntimePrompt = async (): Promise<string> => {
    const now = Date.now();
    if (now - cachedRuntimePromptAt < RUNTIME_CACHE_TTL_MS) {
      return cachedRuntimePrompt;
    }
    let prompt = "";
    try {
      prompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
    } catch {
      // Runtime context is useful but must not block the model/tool loop.
    }
    cachedRuntimePrompt = prompt;
    cachedRuntimePromptAt = now;
    return prompt;
  };

  const getTaskGuidance = (task: string): string => {
    const cached = cachedTaskGuidance.get(task);
    if (cached !== undefined) return cached;
    let guidance = "";
    try {
      const classification = classifyTask(task);
      const text = getExecutionGuidance(classification);
      guidance = [
        `# Task Complexity Analysis`,
        `Complexity: ${classification.complexity} (confidence: ${classification.confidence})`,
        `Reasoning: ${classification.reasoning}`,
        ``,
        `# Execution Guidance`,
        text,
        ``,
        `Note: This is a suggestion based on pattern matching. You may choose a different approach if you have strong evidence that the task requires it.`,
      ].join("\n");
    } catch {
      // Task classification is advisory only and must not block execution.
    }
    cachedTaskGuidance.set(task, guidance);
    return guidance;
  };

  const createSystemPromptProvider = (basePrompt: string) =>
    async (request: AgentRunRequest): Promise<string> => {
      // 并行采集：runtime context 和 memory 互不依赖，可同时执行
      const [runtimePrompt, memoryContext] = await Promise.all([
        getRuntimePrompt(),
        deps.projectMemory?.loadContext(request.task).catch(() => undefined),
      ]);

      if (memoryContext) {
        memoryGenerationByRunId.set(request.runId, memoryContext.generation);
      }

      const taskGuidance = getTaskGuidance(request.task);

      const layered = createLayeredSystemPrompt(
        [basePrompt, taskGuidance].filter(Boolean).join("\n\n"),
        runtimePrompt,
        memoryContext?.prompt ?? "",
        "",
      );
      return renderLayeredPrompt(layered);
    };

  const createParentRunner = (
    tools: ReactAgentTool[],
    requiredToolNames: string[] | undefined,
    basePrompt: string,
    requiredAnyOfToolNames?: string[],
    invokeTool?: ToolInvoker,
  ): AgentRunner => createReactAgentRunner({
    providerName: provider.displayName,
    tools,
    unhandledErrorMode: "summarize-and-finish",
    modelTurn: createOpenAiReactModelTurn({ provider, tools }),
    systemPromptProvider: createSystemPromptProvider(basePrompt),
    recordMemoryRunOutcome: async (outcome) => {
      const expectedGeneration = memoryGenerationByRunId.get(outcome.runId);
      memoryGenerationByRunId.delete(outcome.runId);
      if (expectedGeneration !== undefined && deps.projectMemory) {
        await deps.projectMemory.recordOutcome(outcome, expectedGeneration);
      }
    },
    onCheckpoint: deps.onCheckpoint,
    requiredToolNames,
    requiredAnyOfToolNames,
    invokeTool,
    contextWindow: config.contextWindow,
    visionService: deps.visionService,
  });

  if (mode === "plan") return createParentRunner(readOnlyTools, undefined, PLAN_SYSTEM_PROMPT);
  if (deps.enableWorkflowTools === false) return createParentRunner(parentTools, deps.requiredToolNames, REACT_SYSTEM_PROMPT);

  return {
    async *run(request) {
      // 设置当前请求的附件，供视觉子智能体使用
      currentAttachments = request.attachments;

      const events = createAsyncQueue<HostToWebviewMessage>();
      const orchestrator = createWorkflowOrchestrator({
        signal: request.signal,
        createRunner: ({ tools, role, invokeTool }) => {
          const childTools = [...tools];
          const childProfile = resolveRole(role);
          return createReactAgentRunner({
            providerName: provider.displayName,
            tools: childTools,
            unhandledErrorMode: "summarize-and-fail",
            invokeTool,
            contextWindow: config.contextWindow,
            modelTurn: createOpenAiReactModelTurn({ provider, tools: childTools }),
            systemPromptProvider: async (childRequest) => {
              const childTask = childRequest?.task ?? "";
              const [runtimePrompt, memoryContext] = await Promise.all([
                getRuntimePrompt(),
                deps.projectMemory?.loadContext(childTask).catch(() => undefined),
              ]);
              const layered = createLayeredSystemPrompt(
                childProfile.systemPrompt,
                runtimePrompt,
                memoryContext?.prompt ?? "",
                "",
              );
              return renderLayeredPrompt(layered);
            },
          });
        },
      });
      const unsubscribe = orchestrator.onEvent((event) => events.push(toHostMessage(event, request.runId)));
      const workflowTools = createWorkflowTools({
        orchestrator,
        availableTools: parentTools,
      });
      const tools = [...parentTools, ...workflowTools];
      const parentRunner = createParentRunner(
        tools,
        undefined,
        AGENT_SYSTEM_PROMPT,
        tools.map((tool) => tool.name),
        (request, signal) => orchestrator.invokeTool(tools, request, signal),
      );

      let parentError: unknown;
      const parentDone = (async () => {
        try {
          for await (const message of parentRunner.run(request)) events.push(message);
        } catch (error) {
          parentError = error;
        } finally {
          orchestrator.cancelAll();
          unsubscribe();
          events.close();
        }
      })();

      for await (const message of events) yield message;
      await parentDone;
      if (parentError) throw parentError;
    },
  };
}

function normalizeRunMode(mode: unknown): RunMode {
  return mode === "plan" ? "plan" : "execute";
}

function toHostMessage(event: WorkflowEvent, runId: string): HostToWebviewMessage {
  if (event.type === "SubagentCreated") {
    return {
      type: "subagentPlanCreated",
      runId,
      agentId: event.subagentId,
      task: event.task,
      role: event.role,
      dependsOn: [...event.dependsOn],
    };
  }
  if (event.type === "SubagentStatusChanged") {
    return { type: "subagentStateChanged", runId, agentId: event.subagentId, status: event.status };
  }
  return {
    type: "agentEvent",
    runId,
    message: `[${event.subagentId}] ${summarizeMessage(event.message)}`,
  };
}

function summarizeMessage(message: HostToWebviewMessage): string {
  const summary = "message" in message ? message.message : "content" in message ? message.content : message.type;
  return summary.replace(/\s+/g, " ").trim().slice(0, 500) || message.type;
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value: T): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) return Promise.resolve({ value: values.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function requireVsCodeApi(): VsCodeWorkspaceApi {
  return require("vscode") as VsCodeWorkspaceApi;
}
