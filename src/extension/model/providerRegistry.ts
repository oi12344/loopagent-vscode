import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
import type { ReactAgentTool } from "../agent/reactTypes";
import { createOpenAiReactModelTurn } from "../agent/openAiReactModelTurn";
import { createReactAgentRunner } from "../agent/reactAgentRunner";
import type { AgentRunner } from "../agentRunner";
import { fakeAgentRunner } from "../fakeRun";
import type { ParserRuntime } from "../intelligence/parser/parserRuntime";
import { createTreeSitterParserRuntime } from "../intelligence/parser/treeSitterRuntime";
import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import { createVsCodeWorkspaceIntelligence, type VsCodeWorkspaceApi } from "../intelligence/vscodeWorkspaceIntelligence";
import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";
import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";
import type { RunModelSelection } from "../../shared/messages";
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
};

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

  const tools = [
    createExploreCodeTool(workspaceIntelligence),
    ...(deps.readFileTool ? [deps.readFileTool] : []),
    ...(deps.applyEditTool ? [deps.applyEditTool] : []),
    ...(deps.runCommandTool ? [deps.runCommandTool] : []),
  ];
  return createReactAgentRunner({
    providerName: provider.displayName,
    tools,
    modelTurn: createOpenAiReactModelTurn({ provider, tools }),
    systemPromptProvider: async () => {
      let runtimePrompt = "";
      try {
        runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
      } catch {
        // Runtime context is useful but must not block the model/tool loop.
      }
      return [REACT_SYSTEM_PROMPT, runtimePrompt].filter(Boolean).join("\n\n");
    },
  });
}

function requireVsCodeApi(): VsCodeWorkspaceApi {
  return require("vscode") as VsCodeWorkspaceApi;
}
