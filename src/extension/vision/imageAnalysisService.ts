import type { ImageAttachment } from "../../shared/messages";
import type { VisionService, ImageAnalysisContext, VisionAnalysisRequest } from "./types";

const DEFAULT_PROMPT = "请详细描述这张图片的内容，包括文字、UI 元素、布局和关键信息。";

export type ImageAnalysisServiceOptions = {
  /** 自定义提示词 */
  prompt?: string;
};

export class ImageAnalysisService {
  private readonly visionService: VisionService;
  private readonly prompt: string;

  constructor(visionService: VisionService, options: ImageAnalysisServiceOptions = {}) {
    this.visionService = visionService;
    this.prompt = options.prompt ?? DEFAULT_PROMPT;
  }

  /** 分析单张图片 */
  async analyzeImage(
    attachment: ImageAttachment,
    signal: AbortSignal,
  ): Promise<ImageAnalysisContext> {
    const result = await this.visionService.analyze({
      attachment,
      prompt: this.prompt,
      signal,
    });

    return {
      fileName: attachment.name,
      description: result.text,
      processingTimeMs: result.processingTimeMs,
    };
  }

  /** 批量分析图片附件 */
  async analyzeAttachments(
    attachments: ImageAttachment[] | undefined,
    signal: AbortSignal,
  ): Promise<ImageAnalysisContext[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const results = await Promise.all(
      attachments.map((attachment) => this.analyzeImage(attachment, signal)),
    );

    return results;
  }

  /** 构建注入系统提示词的文本片段 */
  buildSystemPromptFragment(analyses: ImageAnalysisContext[]): string {
    if (analyses.length === 0) {
      return "";
    }

    const parts = analyses.map(
      (a) => `[图片 ${a.fileName}] ${a.description}`,
    );

    return `## 用户上传的图片分析\n\n${parts.join("\n\n")}`;
  }
}
