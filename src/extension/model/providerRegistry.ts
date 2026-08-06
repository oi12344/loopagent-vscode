import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
import { createBrowseSymbolsTool } from "../agent/browseSymbolsTool";
import type { ReactAgentTool } from "../agent/reactTypes";
import type { ToolInvoker } from "../agent/toolRegistry";
import { createOpenAiReactModelTurn } from "../agent/openAiReactModelTurn";
import { createReactAgentRunner } from "../agent/reactAgentRunner";
import { createWorkflowTools } from "../agent/workflowTools";
import { createWorkflowOrchestrator, type WorkflowEvent } from "../agent/workflowOrchestrator";
import type { AgentRunner, AgentRunRequest } from "../agentRunner";
import type { ParserRuntime } from "../intelligence/parser/parserRuntime";
import { createTreeSitterParserRuntime } from "../intelligence/parser/treeSitterRuntime";
import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import { createVsCodeWorkspaceIntelligence, type VsCodeWorkspaceApi } from "../intelligence/vscodeWorkspaceIntelligence";
import type { ProjectMemory } from "../memory/projectMemory";
import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";
import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";
import type { HostToWebviewMessage, RunModelSelection } from "../../shared/messages";
import type { InterruptedRunCheckpoint } from "../../shared/chatTypes";
import { getModelRuntimeConfig } from "./modelConfig";
import { createDeepSeekProvider } from "./providers/deepseekProvider";
import { resolveRole } from "../agent/workflow/roleRegistry";
import type { ImageAnalysisService } from "../vision/imageAnalysisService";
import type { ImageAnalysisContext } from "../vision/imageAnalysisService";
import type { ConversationStore } from "../conversation/conversationStore";

const DIRECT_TOOL_GUIDANCE = [
  // --- Discovery ---
  "When you do not know what symbols exist in the codebase, call browseSymbols with a concept or partial name first to discover actual identifiers. Then use those exact names in exploreCode.",
  "When symbols are already known, call exploreCode directly with a concise, code-oriented query using likely English identifiers.",
  "Trace behavior from current production entry points. Ignore historical documents, tests, and unreferenced legacy modules unless the user explicitly asks about them.",

  // --- Evidence sufficiency ---
  "After each tool result, judge whether the evidence is sufficient to answer the user's question. If it is, answer immediately without calling another tool.",
  "Call exploreCode again only for a concrete fact that is still missing. Use a query focused on that specific gap; do not repeat or overlap prior queries.",
  "Independent read-only lookups may be issued in a single turn.",

  // --- Editing ---
  "Before editing any file, read its current content with readFile.",
  "For changes that touch public interfaces, multiple call sites, or conventions you have not yet seen: use exploreCode to locate the closest existing implementation, then read that implementation, its direct callers, relevant types, and tests before writing.",
  "Follow the discovered structure, naming, and error-handling patterns. If no reliable pattern exists, state the gap instead of inventing a new architecture.",
  "Skip the exploration phase for clearly scoped single-file changes.",
  "Propose all workspace changes through applyEdit. Call applyEdit immediately after reading the relevant files — do not ask the user for textual confirmation first.",
  "Do not claim an edit succeeded until applyEdit reports that it was applied.",
  "Use runCommand to run tests, type checks, or builds when relevant to verify a change. Do not repeat a command the user has rejected.",

  // --- Answer quality ---
  "Answer only from evidence returned by tools. State any material limitation when the evidence is insufficient.",
  "Do not invent repository facts.",
];

const REACT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
  ...DIRECT_TOOL_GUIDANCE,
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
  applyEditTool?: ReactAgentTool;
  runCommandTool?: ReactAgentTool;
  onCheckpoint?: (checkpoint: InterruptedRunCheckpoint) => void | Promise<void>;
  extraTools?: ReactAgentTool[];
  requiredToolNames?: string[];
  projectMemory?: ProjectMemory;
  enableWorkflowTools?: boolean;
  imageAnalysisService?: ImageAnalysisService;
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
  ];
  const parentTools = [
    ...readOnlyTools,
    ...(deps.applyEditTool ? [deps.applyEditTool] : []),
    ...(deps.runCommandTool ? [deps.runCommandTool] : []),
    ...(deps.extraTools ?? []),
  ];
  const memoryGenerationByRunId = new Map<string, number>();

  const runtimeSystemPromptProvider = async (): Promise<string> => {
    let runtimePrompt = "";
    try {
      runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
    } catch {
      // Runtime context is useful but must not block the model/tool loop.
    }
    return runtimePrompt;
  };

  const createSystemPromptProvider = (basePrompt: string) =>
    async (request: AgentRunRequest, imageAnalyses?: ImageAnalysisContext[]): Promise<string> => {
      const runtimePrompt = await runtimeSystemPromptProvider();
      let memoryPrompt = "";
      try {
        const memoryContext = await deps.projectMemory?.loadContext(request.task);
        if (memoryContext) {
          memoryPrompt = memoryContext.prompt;
          memoryGenerationByRunId.set(request.runId, memoryContext.generation);
        }
      } catch {
        // Project memory is best-effort context and must not block the model/tool loop.
      }

      let imagePrompt = "";
      if (imageAnalyses && imageAnalyses.length > 0 && deps.imageAnalysisService) {
        imagePrompt = deps.imageAnalysisService.buildSystemPromptFragment(imageAnalyses);
      }

      return [basePrompt, runtimePrompt, memoryPrompt, imagePrompt].filter(Boolean).join("\n\n");
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
    analyzeImages: deps.imageAnalysisService
      ? async (request) => {
          return await deps.imageAnalysisService!.analyzeAttachments(
            request.attachments,
            request.task,
            request.signal,
          );
        }
      : undefined,
  });

  if (deps.enableWorkflowTools === false) return createParentRunner(parentTools, deps.requiredToolNames, REACT_SYSTEM_PROMPT);

  return {
    async *run(request) {
      const events = createAsyncQueue<HostToWebviewMessage>();
      const orchestrator = createWorkflowOrchestrator({
        signal: request.signal,
        createRunner: ({ tools, role, invokeTool }) => {
          const childTools = [...tools];
          const childProfile = resolveRole(role);
          return createReactAgentRunner({
            providerName: provider.displayName,
            tools: childTools,
            invokeTool,
            modelTurn: createOpenAiReactModelTurn({ provider, tools: childTools }),
            systemPromptProvider: async () => {
              let runtimePrompt = "";
              try {
                runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
              } catch {
                // Runtime context is useful but must not block the model/tool loop.
              }
              return [childProfile.systemPrompt, runtimePrompt].filter(Boolean).join("\n\n");
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
