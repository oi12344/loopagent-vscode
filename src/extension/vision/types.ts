import type { ImageAttachment } from "../../shared/messages";

/** DeepSeek Vision API 图片分析请求 */
export type VisionAnalysisRequest = {
  /** 图片附件 */
  attachment: ImageAttachment;
  /** 用户提示词 */
  prompt: string;
  /** 中止信号 */
  signal: AbortSignal;
};

/** DeepSeek Vision API 图片分析结果 */
export type VisionAnalysisResult = {
  /** 分析文本 */
  text: string;
  /** 处理耗时（毫秒） */
  processingTimeMs: number;
};

/** 图片分析上下文（注入系统提示词） */
export type ImageAnalysisContext = {
  /** 文件名 */
  fileName: string;
  /** 分析描述 */
  description: string;
  /** 处理耗时（毫秒） */
  processingTimeMs: number;
};

/** Vision 服务接口 */
export interface VisionService {
  /** 分析单张图片 */
  analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
  /** 释放资源 */
  dispose(): Promise<void>;
}
