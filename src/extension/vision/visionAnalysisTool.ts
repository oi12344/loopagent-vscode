import type { ReactAgentTool, ReactAgentToolResult } from "../agent/reactTypes";
import type { VisionService } from "./types";
import type { ImageAttachment } from "../../shared/messages";

const DEFAULT_PROMPT = "请详细描述这张图片的内容，包括文字、UI 元素、布局和关键信息。";

export type CreateVisionAnalysisToolOptions = {
  visionService: VisionService;
  /** 获取当前请求的图片附件 */
  getAttachments: () => ImageAttachment[] | undefined;
};

export function createVisionAnalysisTool({
  visionService,
  getAttachments,
}: CreateVisionAnalysisToolOptions): ReactAgentTool {
  return {
    name: "analyzeImage",
    description:
      "分析用户上传的图片。当用户发送了图片附件，或你需要查看截图、UI 设计、图表、错误信息截图时使用此工具。可以传入自定义提示词来询问图片的特定方面。",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "要分析的图片索引（从 0 开始）。如果只有一张图片，传 0。",
        },
        prompt: {
          type: "string",
          description: "可选的分析提示词。例如：'这段代码有什么错误？' 或 '这个 UI 的布局是什么？'",
        },
      },
      required: ["index"],
    },
    async invoke({ input, signal }): Promise<ReactAgentToolResult> {
      const { index, prompt } = input as { index: number; prompt?: string };
      const attachments = getAttachments();

      if (!attachments || attachments.length === 0) {
        return {
          content: "没有可用的图片附件。请让用户先上传图片。",
          evidence: [],
          productive: false,
        };
      }

      if (index < 0 || index >= attachments.length) {
        return {
          content: `图片索引 ${index} 超出范围。共有 ${attachments.length} 张图片（索引 0-${attachments.length - 1}）。`,
          evidence: [],
          productive: false,
        };
      }

      const attachment = attachments[index];
      const analysisPrompt = prompt?.trim() || DEFAULT_PROMPT;

      try {
        const result = await visionService.analyze({
          attachment,
          prompt: analysisPrompt,
          signal,
        });

        return {
          content: `[图片 ${attachment.name}] 分析结果：\n${result.text}\n\n（处理耗时: ${result.processingTimeMs}ms）`,
          evidence: [],
          productive: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: `图片分析失败：${message}`,
          evidence: [],
          productive: false,
        };
      }
    },
  };
}
