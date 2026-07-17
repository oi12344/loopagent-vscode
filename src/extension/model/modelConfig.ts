import * as vscode from "vscode";

import type { RunModelSelection } from "../../shared/messages";
import { createModelRuntimeConfig } from "./modelRuntimeConfig";
import type { DeepSeekThinkingMode } from "./providers/deepseekProvider";

export type ModelProviderId = "fake" | "deepseek";

export type ModelRuntimeConfig = {
  provider: ModelProviderId;
  model: string;
  baseUrl?: string;
  thinking: DeepSeekThinkingMode;
  apiKey?: string;
};

const SECRET_PREFIX = "loopagent.model.apiKey.";

export function getConfiguredProviderId(): ModelProviderId {
  const configuredProvider = vscode.workspace.getConfiguration("loopagent.model").get<string>("provider", "fake");
  return configuredProvider === "deepseek" ? "deepseek" : "fake";
}

export async function getModelRuntimeConfig(
  context: vscode.ExtensionContext,
  selection?: RunModelSelection,
): Promise<ModelRuntimeConfig> {
  const configuration = vscode.workspace.getConfiguration("loopagent.model");
  const provider = getConfiguredProviderId();
  const model = configuration.get<string>("model", "deepseek-v4-flash");
  const baseUrl = configuration.get<string>("baseUrl", "").trim() || undefined;
  const thinking = normalizeThinkingMode(configuration.get<string>("thinking", "enabled"));
  const config = createModelRuntimeConfig({
    provider,
    model,
    baseUrl,
    thinking,
  }, selection);
  const apiKey = await getModelApiKey(context, config.provider);

  return {
    ...config,
    apiKey,
  };
}

export async function getModelApiKey(context: vscode.ExtensionContext, provider: ModelProviderId): Promise<string | undefined> {
  const storedKey = await context.secrets.get(createSecretKey(provider));

  if (storedKey?.trim()) {
    return storedKey;
  }

  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_KEY;
  }

  return undefined;
}

export async function setModelApiKey(
  context: vscode.ExtensionContext,
  provider: ModelProviderId,
  apiKey: string,
): Promise<void> {
  await context.secrets.store(createSecretKey(provider), apiKey);
}

export async function clearModelApiKey(context: vscode.ExtensionContext, provider: ModelProviderId): Promise<void> {
  await context.secrets.delete(createSecretKey(provider));
}

function createSecretKey(provider: ModelProviderId): string {
  return `${SECRET_PREFIX}${provider}`;
}

function normalizeThinkingMode(value: string): DeepSeekThinkingMode {
  return value === "enabled" ? "enabled" : "disabled";
}
