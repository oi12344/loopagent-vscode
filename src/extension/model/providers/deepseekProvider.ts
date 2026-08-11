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

      // 工具调用链始终禁用思考模式，避免收尾请求因历史缺少 reasoning_content 被拒绝
      const hasToolHistory = request.messages.some((message) =>
        message.role === "tool" || (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
      );
      const requestThinking = (request.tools && request.tools.length > 0) || hasToolHistory
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
