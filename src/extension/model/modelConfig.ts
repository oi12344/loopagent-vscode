import * as vscode from "vscode";

import type { RunModelSelection } from "../../shared/messages";
import { createModelRuntimeConfig } from "./modelRuntimeConfig";
import type { DeepSeekThinkingMode } from "./providers/deepseekProvider";

export type ModelProviderId = "deepseek";

export type ModelRuntimeConfig = {
  provider: ModelProviderId;
  model: string;
  baseUrl?: string;
  thinking: DeepSeekThinkingMode;
  apiKey?: string;
  /** 模型上下文窗口大小（token 数），默认 32K */
  contextWindow?: number;
};

/** 已知模型的上下文窗口大小 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4": 1_000_000,
  "deepseek-v3": 32_000,
  "deepseek-v2.5": 32_000,
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

const SECRET_PREFIX = "loopagent.model.apiKey.";

export function getConfiguredProviderId(): ModelProviderId {
  return "deepseek";
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
  const contextWindow = MODEL_CONTEXT_WINDOWS[config.model] ?? DEFAULT_CONTEXT_WINDOW;

  return {
    ...config,
    apiKey,
    contextWindow,
  };
}

export async function getModelApiKey(context: vscode.ExtensionContext, provider: ModelProviderId): Promise<string | undefined> {
  const storedKey = await context.secrets.get(createSecretKey(provider));

  if (storedKey?.trim()) {
    return storedKey;
  }

  return process.env.DEEPSEEK_API_KEY;
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
