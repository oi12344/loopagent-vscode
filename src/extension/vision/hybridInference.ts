import type { VisionProvider, VisionAnalysisRequest } from "./types";
import type { EditOperation } from "../agent/editPreviewService";
import type { ScreenshotResult } from "./screenshotCapture";

/**
 * 混合推理请求
 * 结合视觉模型提取的结构化信息和文本模型的深度分析
 */
export type HybridAnalysisRequest = {
  /** 编辑操作列表 */
  changes: readonly EditOperation[];
  /** 编辑后的截图 */
  screenshot?: ScreenshotResult;
  /** 分析目标 */
  analysisGoal: "verify_changes" | "detect_errors" | "quality_review" | "custom";
  /** 自定义分析提示词（当 analysisGoal 为 custom 时必填） */
  customPrompt?: string;
  /** 取消信号 */
  signal: AbortSignal;
};

/**
 * 混合推理结果
 */
export type HybridAnalysisResult = {
  /** 视觉模型提取的信息 */
  visualInsights: {
    /** 可见的代码改动 */
    visibleChanges: string[];
    /** 检测到的错误标记 */
    errorMarkers: string[];
    /** UI 状态变化 */
    uiChanges: string[];
    /** 原始视觉模型输出 */
    rawOutput: string;
  };
  /** 文本模型的深度分析 */
  deepAnalysis: {
    /** 改动是否正确应用 */
    changesAppliedCorrectly: boolean;
    /** 发现的问题列表 */
    issues: Array<{
      severity: "error" | "warning" | "info";
      description: string;
      file?: string;
    }>;
    /** 代码质量评估 */
    qualityScore?: number;
    /** 改进建议 */
    suggestions: string[];
    /** 完整分析文本 */
    fullAnalysis: string;
  };
  /** 处理耗时（毫秒） */
  processingTimeMs: number;
};

/**
 * 混合推理服务
 * 协调视觉模型和文本模型完成复杂的编辑分析任务
 */
export class HybridInferenceService {
  constructor(
    private readonly visionProvider: VisionProvider,
    private readonly textModelInference: (prompt: string, signal: AbortSignal) => Promise<string>
  ) {}

  /**
   * 执行混合推理分析
   */
  async analyze(request: HybridAnalysisRequest): Promise<HybridAnalysisResult> {
    const startTime = Date.now();

    // 步骤 1：使用视觉模型提取截图信息
    const visualInsights = request.screenshot
      ? await this.extractVisualInsights(request.screenshot, request.signal)
      : this.createEmptyVisualInsights();

    if (request.signal.aborted) {
      throw new Error("Analysis aborted");
    }

    // 步骤 2：构造上下文化的提示词
    const prompt = this.buildAnalysisPrompt(request, visualInsights);

    // 步骤 3：使用文本模型进行深度分析
    const analysisText = await this.textModelInference(prompt, request.signal);

    // 步骤 4：解析分析结果
    const deepAnalysis = this.parseAnalysisResult(analysisText);

    const processingTimeMs = Date.now() - startTime;

    return {
      visualInsights,
      deepAnalysis,
      processingTimeMs,
    };
  }

  /**
   * 使用视觉模型提取截图中的关键信息
   */
  private async extractVisualInsights(
    screenshot: ScreenshotResult,
    signal: AbortSignal
  ): Promise<HybridAnalysisResult["visualInsights"]> {
    const visionRequest: VisionAnalysisRequest = {
      imagePath: screenshot.filePath,
      prompt: `分析这个代码编辑器截图，提取以下信息（使用 JSON 格式）：
1. "visible_changes": 可见的代码改动（新增/删除/修改的行）
2. "error_markers": 所有红色波浪线或错误图标标记的问题
3. "ui_changes": UI 元素的变化（按钮状态、颜色、布局等）

请尽可能具体，包括行号和错误类型。`,
      outputFormat: "json",
      signal,
    };

    const result = await this.visionProvider.analyze(visionRequest);

    // 尝试解析 JSON，失败则回退到文本解析
    let parsedData: any = {};
    try {
      parsedData = JSON.parse(result.text);
    } catch {
      // 文本模式解析
      parsedData = this.parseVisualOutputText(result.text);
    }

    return {
      visibleChanges: this.normalizeArray(parsedData.visible_changes || parsedData.visibleChanges),
      errorMarkers: this.normalizeArray(parsedData.error_markers || parsedData.errorMarkers),
      uiChanges: this.normalizeArray(parsedData.ui_changes || parsedData.uiChanges),
      rawOutput: result.text,
    };
  }

  /**
   * 解析视觉模型的文本输出（当 JSON 解析失败时）
   */
  private parseVisualOutputText(text: string): any {
    const result: any = {
      visible_changes: [],
      error_markers: [],
      ui_changes: [],
    };

    // 简单的关键词匹配
    const lines = text.split("\n");
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes("error") || lower.includes("red") || lower.includes("warning")) {
        result.error_markers.push(line.trim());
      } else if (lower.includes("add") || lower.includes("delete") || lower.includes("change")) {
        result.visible_changes.push(line.trim());
      } else if (lower.includes("button") || lower.includes("ui") || lower.includes("layout")) {
        result.ui_changes.push(line.trim());
      }
    }

    return result;
  }

  /**
   * 创建空的视觉洞察（当没有截图时）
   */
  private createEmptyVisualInsights(): HybridAnalysisResult["visualInsights"] {
    return {
      visibleChanges: [],
      errorMarkers: [],
      uiChanges: [],
      rawOutput: "(无截图)",
    };
  }

  /**
   * 构造发送给文本模型的分析提示词
   */
  private buildAnalysisPrompt(
    request: HybridAnalysisRequest,
    visualInsights: HybridAnalysisResult["visualInsights"]
  ): string {
    const changesDescription = request.changes
      .map((change, index) => {
        if (change.kind === "replace") {
          return `${index + 1}. 替换 ${change.path}:\n   旧内容: ${this.truncate(change.oldText, 200)}\n   新内容: ${this.truncate(change.newText, 200)}`;
        } else if (change.kind === "create") {
          return `${index + 1}. 创建 ${change.path}:\n   内容: ${this.truncate(change.content, 200)}`;
        } else if (change.kind === "rename") {
          return `${index + 1}. 重命名: ${change.from} -> ${change.to}`;
        } else {
          return `${index + 1}. 删除 ${change.path}`;
        }
      })
      .join("\n\n");

    const visualContext = request.screenshot
      ? `
## 编辑器截图分析
视觉模型从截图中提取的信息：

### 可见改动
${visualInsights.visibleChanges.length > 0 ? visualInsights.visibleChanges.map((c) => `- ${c}`).join("\n") : "（无）"}

### 错误标记
${visualInsights.errorMarkers.length > 0 ? visualInsights.errorMarkers.map((e) => `- ${e}`).join("\n") : "（无）"}

### UI 变化
${visualInsights.uiChanges.length > 0 ? visualInsights.uiChanges.map((u) => `- ${u}`).join("\n") : "（无）"}
`
      : "（未提供截图）";

    const goalPrompt = this.getGoalPrompt(request.analysisGoal, request.customPrompt);

    return `
# 代码编辑分析任务

## 应用的改动
${changesDescription}

${visualContext}

## 分析目标
${goalPrompt}

## 输出格式
请以 JSON 格式返回分析结果：
\`\`\`json
{
  "changes_applied_correctly": true/false,
  "issues": [
    {"severity": "error/warning/info", "description": "问题描述", "file": "文件路径(可选)"}
  ],
  "quality_score": 0-100,
  "suggestions": ["改进建议1", "改进建议2"],
  "full_analysis": "完整的分析说明"
}
\`\`\`
`.trim();
  }

  /**
   * 获取分析目标的提示词
   */
  private getGoalPrompt(goal: HybridAnalysisRequest["analysisGoal"], customPrompt?: string): string {
    switch (goal) {
      case "verify_changes":
        return "验证改动是否正确应用，检查是否有遗漏或意外的副作用。";
      case "detect_errors":
        return "检测改动中的错误、警告和潜在问题，包括语法错误、类型错误、逻辑问题等。";
      case "quality_review":
        return "评估代码质量，包括可读性、可维护性、性能、安全性等方面，并提供改进建议。";
      case "custom":
        return customPrompt || "分析代码改动。";
    }
  }

  /**
   * 解析文本模型的分析结果
   */
  private parseAnalysisResult(text: string): HybridAnalysisResult["deepAnalysis"] {
    // 尝试从文本中提取 JSON
    const jsonMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          changesAppliedCorrectly: parsed.changes_applied_correctly ?? true,
          issues: this.normalizeArray(parsed.issues).map((issue: any) => ({
            severity: issue.severity || "info",
            description: issue.description || String(issue),
            file: issue.file,
          })),
          qualityScore: parsed.quality_score,
          suggestions: this.normalizeArray(parsed.suggestions),
          fullAnalysis: parsed.full_analysis || text,
        };
      } catch {
        // JSON 解析失败，回退到文本解析
      }
    }

    // 回退：简单的文本解析
    return {
      changesAppliedCorrectly: !text.toLowerCase().includes("error") && !text.toLowerCase().includes("问题"),
      issues: [],
      suggestions: [],
      fullAnalysis: text,
    };
  }

  /**
   * 工具函数：标准化数组
   */
  private normalizeArray(value: any): string[] {
    if (Array.isArray(value)) {
      return value.map(String);
    }
    if (typeof value === "string") {
      return [value];
    }
    return [];
  }

  /**
   * 工具函数：截断长文本
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength) + "...";
  }
}
