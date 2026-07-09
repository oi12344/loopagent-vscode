import type * as vscode from "vscode";

import type { AgentRunner } from "../agentRunner";
import { fakeAgentRunner } from "../fakeRun";
import type { ParserRuntime } from "../intelligence/parser/parserRuntime";
import { createTreeSitterParserRuntime } from "../intelligence/parser/treeSitterRuntime";
import type { WorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import { createVsCodeWorkspaceIntelligence, type VsCodeWorkspaceApi } from "../intelligence/vscodeWorkspaceIntelligence";
import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";
import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";
import type { RunModelSelection } from "../../shared/messages";
import { createModelRunner } from "./modelRunner";
import { getModelRuntimeConfig } from "./modelConfig";
import { createDeepSeekProvider } from "./providers/deepseekProvider";

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

  return createModelRunner({
    provider,
    systemPromptProvider: async (request) => {
      const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
      const codePrompt = await workspaceIntelligence.buildCodeIntelligencePrompt(request.task);
      return [runtimePrompt, codePrompt].filter(Boolean).join("\n\n");
    },
  });
}

function requireVsCodeApi(): VsCodeWorkspaceApi {
  return require("vscode") as VsCodeWorkspaceApi;
}
