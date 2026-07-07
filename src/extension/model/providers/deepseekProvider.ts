import { createOpenAiCompatibleClient } from "../openAiCompatibleClient";
import { ModelProviderError, type ModelProvider, type ModelRequest } from "../types";

export type DeepSeekThinkingMode = "enabled" | "disabled";

export type DeepSeekProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinking?: DeepSeekThinkingMode;
  fetch?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_THINKING: DeepSeekThinkingMode = "disabled";

export function createDeepSeekProvider({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  thinking = DEFAULT_THINKING,
  fetch: fetchImpl,
}: DeepSeekProviderOptions): ModelProvider {
  return {
    id: "deepseek",
    displayName: `DeepSeek ${model}`,
    stream(request: ModelRequest) {
      if (!apiKey?.trim()) {
        throw new ModelProviderError("missing_api_key", "DeepSeek API key is not configured");
      }

      const client = createOpenAiCompatibleClient({
        id: "deepseek",
        displayName: `DeepSeek ${model}`,
        baseUrl,
        apiKey,
        model,
        fetch: fetchImpl,
        body: {
          thinking: { type: thinking },
        },
      });

      return client.stream(request);
    },
  };
}
