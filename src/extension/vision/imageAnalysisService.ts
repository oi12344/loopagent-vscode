import type { MessageAttachment } from "../../shared/messages";
import type { VisionProvider, VisionAnalysisResult } from "./types";

/**
 * 图片分析上下文
 */
export type ImageAnalysisContext = {
  /** 图片附件路径 */
  imagePath: string;
  /** 图片文件名 */
  fileName: string;
  /** 视觉模型分析结果 */
  description: string;
  /** 分析耗时（毫秒） */
  processingTimeMs: number;
};

/**
 * 图片分析服务
 * 负责检测用户上传的图片并调用视觉模型分析
 */
export class ImageAnalysisService {
  constructor(private visionProvider: VisionProvider) {}

  /**
   * 分析消息中的所有图片附件
   */
  async analyzeAttachments(
    attachments: MessageAttachment[] | undefined,
    userMessage: string,
    signal: AbortSignal,
  ): Promise<ImageAnalysisContext[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    // 筛选图片类型附件
    const imageAttachments = attachments.filter((attachment) => {
      return (
        attachment.type === "image" ||
        /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(attachment.name)
      );
    });

    if (imageAttachments.length === 0) {
      return [];
    }

    console.log(`[ImageAnalysis] Found ${imageAttachments.length} image(s) in user message`);

    // 并发分析所有图片
    const analysisPromises = imageAttachments.map((attachment) =>
      this.analyzeImage(attachment, userMessage, signal),
    );

    const results = await Promise.all(analysisPromises);
    return results.filter((result): result is ImageAnalysisContext => result !== null);
  }

  /**
   * 分析单张图片
   */
  private async analyzeImage(
    attachment: MessageAttachment,
    userMessage: string,
    signal: AbortSignal,
  ): Promise<ImageAnalysisContext | null> {
    try {
      const prompt = this.buildAnalysisPrompt(userMessage);

      console.log(`[ImageAnalysis] Analyzing image: ${attachment.name}`);
      console.log(`[ImageAnalysis] Prompt: ${prompt}`);

      const result = await this.visionProvider.analyze({
        imagePath: attachment.path,
        prompt,
        outputFormat: "text",
        signal,
      });

      console.log(`[ImageAnalysis] Analysis completed in ${result.processingTimeMs}ms`);

      return {
        imagePath: attachment.path,
        fileName: attachment.name,
        description: result.text,
        processingTimeMs: result.processingTimeMs,
      };
    } catch (error) {
      console.error(`[ImageAnalysis] Failed to analyze ${attachment.name}:`, error);
      return null;
    }
  }

  /**
   * 根据用户消息内容构建分析提示词
   */
  private buildAnalysisPrompt(userMessage: string): string {
    const lowerMessage = userMessage.toLowerCase();

    // UI 设计/实现相关
    if (
      lowerMessage.includes("实现") ||
      lowerMessage.includes("开发") ||
      lowerMessage.includes("创建") ||
      lowerMessage.includes("设计") ||
      lowerMessage.includes("页面") ||
      lowerMessage.includes("界面") ||
      lowerMessage.includes("布局")
    ) {
      return "详细描述这个 UI 设计图，包括：整体布局结构、颜色方案、各个组件及其位置、文字内容、尺寸比例、样式特征（圆角、阴影、边框等）。";
    }

    // 错误诊断相关
    if (
      lowerMessage.includes("错误") ||
      lowerMessage.includes("bug") ||
      lowerMessage.includes("报错") ||
      lowerMessage.includes("问题") ||
      lowerMessage.includes("异常") ||
      lowerMessage.includes("失败")
    ) {
      return "这是一张错误截图，请识别：错误类型、错误消息内容、堆栈跟踪信息、文件路径和行号、相关代码片段。";
    }

    // 文档/API 相关
    if (
      lowerMessage.includes("文档") ||
      lowerMessage.includes("api") ||
      lowerMessage.includes("接口") ||
      lowerMessage.includes("参数") ||
      lowerMessage.includes("示例")
    ) {
      return "这是技术文档截图，请提取：API 名称、函数签名、参数说明、返回值类型、使用示例、注意事项。";
    }

    // 图表/数据相关
    if (
      lowerMessage.includes("图表") ||
      lowerMessage.includes("数据") ||
      lowerMessage.includes("可视化") ||
      lowerMessage.includes("统计")
    ) {
      return "详细描述这个图表，包括：图表类型、坐标轴标签、数据系列、数值范围、趋势特征、图例说明。";
    }

    // 代码截图相关
    if (
      lowerMessage.includes("代码") ||
      lowerMessage.includes("函数") ||
      lowerMessage.includes("类") ||
      lowerMessage.includes("方法")
    ) {
      return "这是代码截图，请识别：编程语言、代码内容、关键函数或类、代码结构、注释说明。";
    }

    // 通用场景：详细描述图片内容
    return "详细描述这张图片的内容，包括：主要元素、布局结构、文字内容、颜色、视觉特征、可能的用途或场景。";
  }

  /**
   * 构建系统提示词片段
   * 将图片分析结果格式化为可注入 AI 上下文的文本
   */
  buildSystemPromptFragment(analyses: ImageAnalysisContext[]): string {
    if (analyses.length === 0) {
      return "";
    }

    let fragment = "\n\n## 📸 用户上传的图片分析\n\n";
    fragment += "用户在消息中上传了以下图片，这些图片已由视觉模型（Moondream2）分析：\n\n";

    analyses.forEach((analysis, index) => {
      fragment += `### 图片 ${index + 1}：${analysis.fileName}\n\n`;
      fragment += `${analysis.description}\n\n`;
      fragment += `*分析耗时：${analysis.processingTimeMs}ms*\n\n`;
    });

    fragment += "请根据上述图片内容回答用户的问题。如果用户要求实现 UI，请基于图片描述生成完整的代码。\n";

    return fragment;
  }
}
