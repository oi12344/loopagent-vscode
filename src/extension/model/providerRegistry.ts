import type * as vscode from "vscode";

import { createExploreCodeTool } from "../agent/exploreCodeTool";
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
  "Do not invent repository facts when the tool does not provide enough evidence.",
].join("\n");

export type CreateConfiguredAgentRunnerDeps = {
  vscodeApi?: VsCodeWorkspaceApi;
  workspaceIntelligence?: WorkspaceIntelligence;
  parserRuntime?: ParserRuntime;
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

  const tools = [createExploreCodeTool(workspaceIntelligence)];
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
