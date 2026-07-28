import type { ReactAgentTool } from "../agent/reactTypes";
import type { HybridInferenceService, HybridAnalysisRequest } from "./hybridInference";
import type { ScreenshotCaptureService } from "./screenshotCapture";
import type { EditOperation } from "../agent/editPreviewService";

/**
 * 创建视觉增强的编辑分析工具
 * 允许 AI Agent 使用视觉模型理解代码编辑结果
 */
export function createAnalyzeEditWithVisionTool(
  hybridService: HybridInferenceService,
  screenshotService: ScreenshotCaptureService
): ReactAgentTool {
  return {
    name: "analyzeEditWithVision",
    description: `使用视觉模型和深度推理分析代码编辑结果。

适用场景：
- 验证编辑是否正确应用
- 检测引入的语法错误或警告
- 评估代码质量
- 理解 UI 变化

注意：此工具会捕获编辑器截图并使用本地视觉模型分析，处理时间约 1-3 秒。`,
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "已应用的编辑操作列表",
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["replace"] },
                  path: { type: "string" },
                  oldText: { type: "string" },
                  newText: { type: "string" },
                },
                required: ["kind", "path", "oldText", "newText"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["create"] },
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["kind", "path", "content"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["rename"] },
                  from: { type: "string" },
                  to: { type: "string" },
                },
                required: ["kind", "from", "to"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["delete"] },
                  path: { type: "string" },
                },
                required: ["kind", "path"],
              },
            ],
          },
        },
        captureScreenshot: {
          type: "boolean",
          description: "是否捕获编辑器截图进行视觉分析（默认 true）",
          default: true,
        },
        analysisGoal: {
          type: "string",
          enum: ["verify_changes", "detect_errors", "quality_review", "custom"],
          description: "分析目标",
          default: "detect_errors",
        },
        customPrompt: {
          type: "string",
          description: "自定义分析提示词（当 analysisGoal 为 custom 时使用）",
        },
      },
      required: ["changes"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      const changes = parseChanges(input);
      const options = input as Record<string, unknown>;
      const captureScreenshot = options.captureScreenshot !== false;
      const analysisGoal = (options.analysisGoal as HybridAnalysisRequest["analysisGoal"]) || "detect_errors";
      const customPrompt = typeof options.customPrompt === "string" ? options.customPrompt : undefined;

      // 捕获截图（如果启用）
      let screenshot;
      if (captureScreenshot) {
        try {
          screenshot = await screenshotService.captureActiveEditor({
            delayMs: 500, // 等待编辑器更新
          });
        } catch (error) {
          console.warn("[AnalyzeEditWithVision] Screenshot capture failed:", error);
          // 继续执行，但不使用截图
        }
      }

      // 执行混合推理
      const result = await hybridService.analyze({
        changes,
        screenshot,
        analysisGoal,
        customPrompt,
        signal,
      });

      // 格式化返回结果
      return formatAnalysisResult(result);
    },
  };
}

/**
 * 解析输入的 changes 参数
 */
function parseChanges(input: unknown): EditOperation[] {
  if (!isRecord(input) || !Array.isArray(input.changes)) {
    throw new Error("Invalid analyzeEditWithVision input: changes must be an array");
  }

  return input.changes.map((change: unknown) => {
    if (!isRecord(change) || typeof change.kind !== "string") {
      throw new Error("Invalid edit operation");
    }

    if (change.kind === "replace" && hasOnlyStrings(change, ["kind", "path", "oldText", "newText"])) {
      return { kind: "replace", path: change.path, oldText: change.oldText, newText: change.newText };
    } else if (change.kind === "create" && hasOnlyStrings(change, ["kind", "path", "content"])) {
      return { kind: "create", path: change.path, content: change.content };
    } else if (change.kind === "rename" && hasOnlyStrings(change, ["kind", "from", "to"])) {
      return { kind: "rename", from: change.from, to: change.to };
    } else if (change.kind === "delete" && hasOnlyStrings(change, ["kind", "path"])) {
      return { kind: "delete", path: change.path };
    }

    throw new Error("Invalid edit operation");
  });
}

/**
 * 格式化分析结果为 Agent 可读的文本
 */
function formatAnalysisResult(result: any): string {
  const sections: string[] = [];

  // 视觉洞察
  if (result.visualInsights && result.visualInsights.rawOutput !== "(无截图)") {
    sections.push("## 📸 视觉分析");
    if (result.visualInsights.visibleChanges.length > 0) {
      sections.push("**可见改动：**");
      sections.push(result.visualInsights.visibleChanges.map((c: string) => `- ${c}`).join("\n"));
    }
    if (result.visualInsights.errorMarkers.length > 0) {
      sections.push("\n**错误标记：**");
      sections.push(result.visualInsights.errorMarkers.map((e: string) => `- ⚠️ ${e}`).join("\n"));
    }
    if (result.visualInsights.uiChanges.length > 0) {
      sections.push("\n**UI 变化：**");
      sections.push(result.visualInsights.uiChanges.map((u: string) => `- ${u}`).join("\n"));
    }
  }

  // 深度分析
  sections.push("\n## 🔍 深度分析");
  sections.push(
    `**改动应用状态：** ${result.deepAnalysis.changesAppliedCorrectly ? "✅ 正确应用" : "❌ 存在问题"}`
  );

  if (result.deepAnalysis.issues.length > 0) {
    sections.push("\n**发现的问题：**");
    result.deepAnalysis.issues.forEach((issue: any) => {
      const icon = issue.severity === "error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
      sections.push(`${icon} ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    });
  } else {
    sections.push("\n✅ 未发现问题");
  }

  if (result.deepAnalysis.qualityScore !== undefined) {
    sections.push(`\n**代码质量评分：** ${result.deepAnalysis.qualityScore}/100`);
  }

  if (result.deepAnalysis.suggestions.length > 0) {
    sections.push("\n**改进建议：**");
    result.deepAnalysis.suggestions.forEach((s: string) => {
      sections.push(`- ${s}`);
    });
  }

  if (result.deepAnalysis.fullAnalysis) {
    sections.push(`\n**完整分析：**\n${result.deepAnalysis.fullAnalysis}`);
  }

  sections.push(`\n---\n⏱️ 处理耗时: ${result.processingTimeMs}ms`);

  return sections.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyStrings(value: Record<string, unknown>, keys: readonly string[]): value is Record<string, string> {
  return Object.keys(value).length === keys.length && keys.every((key) => typeof value[key] === "string");
}
