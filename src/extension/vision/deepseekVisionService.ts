import type { VisionAnalysisRequest, VisionAnalysisResult, VisionService } from "./types";

const VISION_MODEL = "deepseek-v4-flash-vision-exp";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

export type DeepSeekVisionServiceOptions = {
  /** API key，或返回 API key 的函数（运行时从 secrets 获取） */
  apiKey?: string | (() => string | Promise<string | undefined>);
  baseUrl?: string;
  fetch?: typeof fetch;
};

export class DeepSeekVisionService implements VisionService {
  private readonly apiKeySource: string | (() => string | Promise<string | undefined>) | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekVisionServiceOptions = {}) {
    this.apiKeySource = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async getApiKey(): Promise<string | undefined> {
    if (typeof this.apiKeySource === "function") {
      return this.apiKeySource();
    }
    return this.apiKeySource;
  }

  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey?.trim()) {
      throw new Error("DeepSeek API key is not configured");
    }

    const startTime = Date.now();

    const body = {
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${request.attachment.mimeType};base64,${request.attachment.base64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 2048,
    };

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`DeepSeek Vision API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const processingTimeMs = Date.now() - startTime;

    return { text, processingTimeMs };
  }

  async healthCheck(): Promise<boolean> {
    const apiKey = await this.getApiKey();
    if (!apiKey?.trim()) {
      return false;
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    // 无需清理资源
  }
}
