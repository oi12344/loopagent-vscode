import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
import type { ReactAgentTool } from "../agent/reactTypes";
import { createOpenAiReactModelTurn } from "../agent/openAiReactModelTurn";
import { createReactAgentRunner } from "../agent/reactAgentRunner";
import { createWorkflowOrchestrator, type WorkflowEvent } from "../agent/workflowOrchestrator";
import { createWorkflowTools } from "../agent/workflowTools";
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
import { createSkillCatalog } from "../superpowers/skillCatalog";
import { getModelRuntimeConfig } from "./modelConfig";
import { createDeepSeekProvider } from "./providers/deepseekProvider";

const REACT_SYSTEM_PROMPT = [
  "You are LoopAgent, a coding assistant working in the current VS Code workspace.",
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
  superpowersResourceRoot?: string;
  superpowersRunner?: AgentRunner;
  validateSuperpowers?: () => Promise<void>;
  projectMemory?: ProjectMemory;
  enableWorkflowTools?: boolean;
};

export async function createConfiguredAgentRunner(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
  deps: CreateConfiguredAgentRunnerDeps = {},
  mode: "ask" | "edit" = "ask",
): Promise<AgentRunner> {
  if (mode === "edit") {
    try {
      if (deps.validateSuperpowers) await deps.validateSuperpowers();
      else if (deps.superpowersResourceRoot) await createSkillCatalog(deps.superpowersResourceRoot);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`Superpowers resources unavailable at ${deps.superpowersResourceRoot ?? "configured resource root"}${detail}`);
    }
    if (deps.superpowersRunner) return deps.superpowersRunner;
    throw new Error(`Superpowers resources unavailable at ${deps.superpowersResourceRoot ?? "configured resource root"}`);
  }

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
    return [REACT_SYSTEM_PROMPT, runtimePrompt].filter(Boolean).join("\n\n");
  };

  const systemPromptProvider = async (request: AgentRunRequest): Promise<string> => {
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
    return [runtimePrompt, memoryPrompt].filter(Boolean).join("\n\n");
  };

  const createParentRunner = (tools: ReactAgentTool[]): AgentRunner => createReactAgentRunner({
    providerName: provider.displayName,
    tools,
    modelTurn: createOpenAiReactModelTurn({ provider, tools }),
    systemPromptProvider,
    recordMemoryRunOutcome: async (outcome) => {
      const expectedGeneration = memoryGenerationByRunId.get(outcome.runId);
      memoryGenerationByRunId.delete(outcome.runId);
      if (expectedGeneration !== undefined && deps.projectMemory) {
        await deps.projectMemory.recordOutcome(outcome, expectedGeneration);
      }
    },
    onCheckpoint: deps.onCheckpoint,
    requiredToolNames: deps.requiredToolNames,
  });

  if (deps.enableWorkflowTools === false) return createParentRunner(parentTools);

  return {
    async *run(request) {
      const events = createAsyncQueue<HostToWebviewMessage>();
      const orchestrator = createWorkflowOrchestrator({
        signal: request.signal,
        createRunner: ({ tools }) => {
          const childTools = [...tools];
          return createReactAgentRunner({
            providerName: provider.displayName,
            tools: childTools,
            modelTurn: createOpenAiReactModelTurn({ provider, tools: childTools }),
            systemPromptProvider: runtimeSystemPromptProvider,
          });
        },
      });
      const unsubscribe = orchestrator.onEvent((event) => events.push(toHostMessage(event, request.runId)));
      const tools = [...parentTools, ...createWorkflowTools({ orchestrator, availableTools: readOnlyTools })];
      const parentRunner = createParentRunner(tools);

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
    return { type: "subagentStateChanged", runId, agentId: event.subagentId, status: "pending" };
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
