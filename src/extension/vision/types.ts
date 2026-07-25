/**
 * 视觉模型能力标识
 */
export type VisionCapability =
  | "ui_understanding"      // UI/界面元素识别
  | "code_screenshot"       // 代码截图理解
  | "chart_analysis"        // 图表/数据可视化
  | "ocr"                   // 光学字符识别
  | "object_detection"      // 对象检测与定位
  | "vqa"                   // 视觉问答
  | "dense_captioning";     // 密集描述

/**
 * 视觉模型提供商标识
 */
export type VisionProviderId = "moondream2" | "florence2" | "tesseract";

/**
 * 视觉分析请求
 */
export type VisionAnalysisRequest = {
  /** 图片路径（本地文件系统） */
  imagePath: string;
  /** 分析提示词（可选，某些模型支持开放式提问） */
  prompt?: string;
  /** 期望的输出格式（可选） */
  outputFormat?: "text" | "json" | "markdown";
  /** 取消信号 */
  signal: AbortSignal;
};

/**
 * 视觉分析结果
 */
export type VisionAnalysisResult = {
  /** 分析文本结果 */
  text: string;
  /** 结构化数据（如果模型支持） */
  data?: Record<string, unknown>;
  /** 置信度分数 (0-1) */
  confidence?: number;
  /** 处理耗时（毫秒） */
  processingTimeMs: number;
};

/**
 * 视觉模型提供商接口
 */
export type VisionProvider = {
  /** 提供商唯一标识 */
  id: VisionProviderId;
  /** 显示名称 */
  displayName: string;
  /** 支持的能力集合 */
  capabilities: VisionCapability[];
  /** 模型大小（字节） */
  modelSizeBytes?: number;
  /** 分析图片 */
  analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
  /** 释放资源 */
  dispose(): Promise<void>;
};

/**
 * 视觉服务错误码
 */
export type VisionServiceErrorCode =
  | "service_not_started"
  | "model_not_loaded"
  | "invalid_image_path"
  | "analysis_timeout"
  | "python_process_failed"
  | "http_request_failed";

/**
 * 视觉服务错误
 */
export class VisionServiceError extends Error {
  readonly code: VisionServiceErrorCode;

  constructor(code: VisionServiceErrorCode, message: string) {
    super(message);
    this.name = "VisionServiceError";
    this.code = code;
  }
}
