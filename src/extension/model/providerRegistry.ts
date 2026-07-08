import type * as vscode from "vscode";

import type { AgentRunner } from "../agentRunner";
import { fakeAgentRunner } from "../fakeRun";
import { createEmptyWorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
import { renderCodeRuntimeContextPrompt } from "../runtime/contextPrompt";
import { collectVsCodeRuntimeContext } from "../runtime/vscodeRuntimeContext";
import type { RunModelSelection } from "../../shared/messages";
import { createModelRunner } from "./modelRunner";
import { getModelRuntimeConfig } from "./modelConfig";
import { createDeepSeekProvider } from "./providers/deepseekProvider";

export async function createConfiguredAgentRunner(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
): Promise<AgentRunner> {
  const config = await getModelRuntimeConfig(context, selection);

  if (config.provider === "fake") {
    return fakeAgentRunner;
  }

  const workspaceIntelligence = createEmptyWorkspaceIntelligence();

  return createModelRunner({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinking: config.thinking,
    }),
    systemPromptProvider: async (request) => {
      const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
      const codePrompt = await workspaceIntelligence.buildCodeIntelligencePrompt(request.task);
      return [runtimePrompt, codePrompt].filter((part) => part.trim().length > 0).join("\n\n");
    },
  });
}
