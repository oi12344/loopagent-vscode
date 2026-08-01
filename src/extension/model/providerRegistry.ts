import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
import type { ReactAgentTool } from "../agent/reactTypes";
import { createOpenAiReactModelTurn } from "../agent/openAiReactModelTurn";
import { createReactAgentRunner } from "../agent/reactAgentRunner";
import { createDynamicWorkflowTools } from "../agent/dynamicWorkflowTools";
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
  "Use exploreCode when answering questions about repository implementation, symbol locations, call paths, or project facts.",
  "Prefer concise code-oriented search queries with likely English identifiers, then answer from the returned observation.",
  "Trace behavior from current production entry points; ignore historical documents, tests, and unreferenced legacy modules unless the user asks for them.",
  "Before answering, verify every claimed call edge against the current source returned by exploreCode.",
  "After each exploreCode observation, decide whether the available source evidence is sufficient to answer the user's question.",
  "If the available source evidence is sufficient, answer immediately without calling another tool.",
  "Only call exploreCode again for a concrete missing fact required to answer the user; use a focused query that does not overlap previous queries.",
  "When separate read-only searches are needed, you may request them in one assistant turn.",
  "Do not request an exact duplicate search or search again for facts already supported by source evidence.",
  "Do not keep searching for completeness or to reconfirm facts already supported by source evidence.",
  "Before editing, read the relevant file content with readFile.",
  "For non-local changes, public behavior changes, or unclear conventions, first use exploreCode to find the closest existing implementation.",
  "Read that implementation, its direct callers, relevant types or data definitions, and tests before applying changes.",
  "Follow the discovered structure, naming, error handling, and boundaries; if no reliable example exists, state the missing convention instead of inventing a new architecture.",
  "Skip this exploration for clearly scoped single-file changes.",
  "Propose all workspace changes only through applyEdit.",
  "After reading the relevant files, call applyEdit immediately with the complete change proposal.",
  "Do not ask the user for textual confirmation before calling applyEdit; applyEdit opens the review interface and handles confirmation.",
  "Do not claim an edit succeeded until applyEdit reports that it was applied.",
  "Use runCommand when tests, type checks, or builds are relevant to verify a change.",
  "If the user rejects a command, do not request the same command again.",
  "Answer only from supported evidence and state any material limitation.",
  "Do not invent repository facts when the tool does not provide enough evidence.",
];

const GRAPH_TOOL_GUIDANCE = [
  "You have direct tools (exploreCode, readFile, applyEdit, runCommand) and one graph tool (runDynamicGraph).",
  "For a single, well-defined task whose evidence fits in one context (one call path, one file, one straightforward edit), use the direct tools yourself. Do not build a graph for it.",
  "Only call runDynamicGraph when the task genuinely needs multiple independent, parallelizable explorations, or exceeds what a single tool-call budget can cover.",
  "runDynamicGraph creates and executes the graph in a single call. Keep each node narrowly focused on one call path or decision; never ask a node to recursively enumerate or read the whole repository.",
  "For model-backed nodes, set timeoutMs to 60000. Prefer one graph and report node failures instead of repeatedly rebuilding equivalent graphs.",
  "For parallel exploration, create only independent read-only nodes and aggregate their results yourself after runDynamicGraph returns.",
  "Do not add a reviewer unless the user explicitly asks for an independent review.",
  "Do not create a preliminary discovery graph. When the user explicitly requests parallel analyses followed by independent review, omit dependencies from the analysis nodes and make one reviewer depend on all of them.",
  "dependsOn only controls scheduling; it does not forward upstream output. When a reviewer aggregates dependency results, map every dependency's <node-id>.content through inputMapping.",
  "toolHints must name available tools. For read-only nodes use exploreCode and readFile; never invent listFiles or glob tools.",
  "Use the resolvers field when the task needs fanout, conditional expansion, or bounded iterative review; every resolver nodeId must name an initial node.",
  "Graph nodes do not have access to runDynamicGraph and cannot create nested workflows.",
];

const REACT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
  ...DIRECT_TOOL_GUIDANCE,
].join("\n");

const AGENT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
  ...GRAPH_TOOL_GUIDANCE,
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
  workflowCheckpointStore?: Pick<ConversationStore, "claimWorkflowCheckpoint" | "saveWorkflowCheckpoint" | "loadWorkflowCheckpoint" | "getWorkflowCheckpointRunId" | "clearWorkflowCheckpoint">;
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

  const readOnlyTools = [
    createExploreCodeTool(workspaceIntelligence),
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
        createRunner: ({ tools, role }) => {
          const childTools = [...tools];
          const childProfile = resolveRole(role);
          return createReactAgentRunner({
            providerName: provider.displayName,
            tools: childTools,
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
      const graphTools = createDynamicWorkflowTools({
        orchestrator,
        availableTools: parentTools,
        signal: request.signal,
        conversationId: request.conversationId,
        runId: request.runId,
        checkpointStore: deps.workflowCheckpointStore,
      });
      const tools = [...parentTools, ...graphTools];
      const parentRunner = createParentRunner(
        tools,
        undefined,
        AGENT_SYSTEM_PROMPT,
        tools.map((tool) => tool.name),
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
