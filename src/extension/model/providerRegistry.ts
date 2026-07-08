import type * as vscode from "vscode";

import type { AgentRunner } from "../agentRunner";
import { fakeAgentRunner } from "../fakeRun";
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

  return createModelRunner({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinking: config.thinking,
    }),
    systemPromptProvider: async (_request) => renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext()),
  });
}
