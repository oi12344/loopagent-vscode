import type { RunModelSelection } from "../../shared/messages";
import type { ModelRuntimeConfig } from "./modelConfig";

export function createModelRuntimeConfig(
  workspaceConfig: ModelRuntimeConfig,
  selection?: RunModelSelection,
): ModelRuntimeConfig {
  if (!selection) {
    return workspaceConfig;
  }

  const providerChanged = selection.provider !== workspaceConfig.provider;

  return {
    ...workspaceConfig,
    provider: selection.provider,
    model: selection.model.trim() || workspaceConfig.model,
    thinking: selection.thinking,
    apiKey: providerChanged ? undefined : workspaceConfig.apiKey,
  };
}
