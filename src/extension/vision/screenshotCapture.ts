import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "node:crypto";

/**
 * 截图捕获选项
 */
export type ScreenshotCaptureOptions = {
  /** 截图保存目录（默认使用临时目录） */
  outputDir?: string;
  /** 文件名前缀（默认 "edit-preview"） */
  filenamePrefix?: string;
  /** 图片格式（默认 "png"） */
  format?: "png" | "jpeg";
  /** 延迟捕获时间（毫秒，默认 500ms，等待 UI 更新） */
  delayMs?: number;
};

/**
 * 截图结果
 */
export type ScreenshotResult = {
  /** 截图文件路径 */
  filePath: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 捕获时间戳 */
  timestamp: number;
};

/**
 * 编辑器截图捕获服务
 *
 * 使用 VSCode 内置的 Chrome DevTools Protocol (CDP) 捕获编辑器窗口截图
 * 用于视觉模型分析代码编辑结果
 */
export class ScreenshotCaptureService {
  private readonly outputDir: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputDir = path.join(context.globalStorageUri.fsPath, "screenshots");
    this.ensureOutputDir();
  }

  private ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 捕获当前活动编辑器的截图
   */
  async captureActiveEditor(options: ScreenshotCaptureOptions = {}): Promise<ScreenshotResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("No active editor to capture");
    }

    const delay = options.delayMs ?? 500;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // 生成唯一文件名
    const prefix = options.filenamePrefix ?? "edit-preview";
    const format = options.format ?? "png";
    const timestamp = Date.now();
    const filename = `${prefix}-${randomUUID()}-${timestamp}.${format}`;
    const outputPath = path.join(options.outputDir ?? this.outputDir, filename);

    // 使用 VSCode 内置命令捕获截图
    // 注意：这是一个实验性 API，可能需要回退到其他方案
    try {
      await this.captureViaCommand(outputPath);
    } catch (error) {
      // 回退方案：使用外部工具或通知用户
      console.warn("[ScreenshotCapture] CDP capture failed, using fallback:", error);
      await this.captureFallback(outputPath);
    }

    const stats = fs.statSync(outputPath);
    return {
      filePath: outputPath,
      sizeBytes: stats.size,
      timestamp,
    };
  }

  /**
   * 使用 VSCode 内置命令捕获（需要 CDP 支持）
   */
  private async captureViaCommand(outputPath: string): Promise<void> {
    // 方案 1：尝试使用 workbench.action.screenshot（如果可用）
    try {
      await vscode.commands.executeCommand("workbench.action.screenshot", {
        path: outputPath,
      });
      return;
    } catch {
      // 命令不存在，继续尝试其他方案
    }

    // 方案 2：TODO - 集成 CDP 直接调用（更可靠但复杂）
    throw new Error("CDP screenshot not implemented");
  }

  /**
   * 回退方案：保存编辑器文本内容为渲染预览
   */
  private async captureFallback(outputPath: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("No active editor");
    }

    // 生成 HTML 预览（包含语法高亮）
    const html = await this.generateEditorPreviewHtml(editor);

    // 使用无头浏览器渲染（需要额外依赖，这里先抛出错误）
    // TODO: 集成 playwright 或类似工具进行渲染
    throw new Error(
      "Screenshot capture requires Chrome DevTools Protocol support. " +
      "Please ensure VSCode is running with --inspect-extensions flag or use a supported environment."
    );
  }

  /**
   * 生成编辑器 HTML 预览（用于回退方案）
   */
  private async generateEditorPreviewHtml(editor: vscode.TextEditor): Promise<string> {
    const document = editor.document;
    const languageId = document.languageId;
    const content = document.getText();

    // 简化版 HTML，实际应使用 VSCode 的语法高亮引擎
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 14px;
      line-height: 1.5;
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 20px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <pre><code class="language-${languageId}">${this.escapeHtml(content)}</code></pre>
</body>
</html>
    `.trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * 清理旧截图（保留最近 N 个）
   */
  async cleanupOldScreenshots(keepCount: number = 10): Promise<void> {
    const files = fs.readdirSync(this.outputDir);
    const screenshots = files
      .filter((file) => file.startsWith("edit-preview-"))
      .map((file) => ({
        name: file,
        path: path.join(this.outputDir, file),
        mtime: fs.statSync(path.join(this.outputDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // 删除超过保留数量的截图
    for (const screenshot of screenshots.slice(keepCount)) {
      fs.unlinkSync(screenshot.path);
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    // 清理所有截图
    try {
      const files = fs.readdirSync(this.outputDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.outputDir, file));
      }
    } catch (error) {
      console.warn("[ScreenshotCapture] Cleanup failed:", error);
    }
  }
}

/**
 * 简化的截图捕获函数（用于快速集成）
 */
export async function captureEditorScreenshot(
  context: vscode.ExtensionContext,
  options?: ScreenshotCaptureOptions
): Promise<ScreenshotResult> {
  const service = new ScreenshotCaptureService(context);
  return service.captureActiveEditor(options);
}
