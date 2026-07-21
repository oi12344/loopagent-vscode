import type { RunModelSelection } from "../../shared/messages";
import type { ModelRuntimeConfig } from "./modelConfig";

export function createModelRuntimeConfig(
  workspaceConfig: ModelRuntimeConfig,
  selection?: RunModelSelection,
): ModelRuntimeConfig {
  if (!selection) {
    return workspaceConfig;
  }

  return {
    ...workspaceConfig,
    provider: workspaceConfig.provider,
    model: selection.model.trim() || workspaceConfig.model,
    thinking: selection.thinking,
  };
}
