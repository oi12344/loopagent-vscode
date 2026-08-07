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
const DEFAULT_THINKING: DeepSeekThinkingMode = "enabled";

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

      // 有工具时始终禁用思考模式，避免 DeepSeek 以 DSML 文本格式输出工具调用
      const requestThinking = request.tools && request.tools.length > 0
        ? "disabled"
        : thinking;

      const client = createOpenAiCompatibleClient({
        id: "deepseek",
        displayName: `DeepSeek ${model}`,
        baseUrl,
        apiKey,
        model,
        fetch: fetchImpl,
        body: {
          thinking: { type: requestThinking },
        },
      });

      return client.stream(request);
    },
  };
}
