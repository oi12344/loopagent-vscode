import type * as vscode from "vscode";

import type { AgentRunner } from "../agentRunner";
import type { RunModelSelection } from "../../shared/messages";
import { fakeAgentRunner } from "../fakeRun";
import { createModelRunner } from "./modelRunner";
import { createDeepSeekProvider } from "./providers/deepseekProvider";
import { getModelRuntimeConfig } from "./modelConfig";

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
  });
}
