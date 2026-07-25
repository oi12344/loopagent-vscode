import { describe, it, expect, beforeEach, vi } from "vitest";
import { ImageAnalysisService } from "../src/extension/vision/imageAnalysisService";
import type { VisionProvider, VisionAnalysisRequest, VisionAnalysisResult } from "../src/extension/vision/types";
import type { MessageAttachment } from "../src/shared/messages";

describe("ImageAnalysisService", () => {
  let mockVisionProvider: VisionProvider;
  let imageAnalysisService: ImageAnalysisService;

  beforeEach(() => {
    mockVisionProvider = {
      id: "moondream2",
      displayName: "Moondream2",
      capabilities: ["ui_understanding", "code_screenshot"],
      analyze: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    imageAnalysisService = new ImageAnalysisService(mockVisionProvider);
  });

  describe("analyzeAttachments", () => {
    it("应该返回空数组当没有附件时", async () => {
      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments(undefined, "test message", controller.signal);

      expect(result).toEqual([]);
      expect(mockVisionProvider.analyze).not.toHaveBeenCalled();
    });

    it("应该返回空数组当附件为空数组时", async () => {
      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments([], "test message", controller.signal);

      expect(result).toEqual([]);
      expect(mockVisionProvider.analyze).not.toHaveBeenCalled();
    });

    it("应该过滤并分析图片附件", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "image",
          path: "/path/to/image.png",
          name: "image.png",
          sizeBytes: 1024,
        },
        {
          type: "file",
          path: "/path/to/document.pdf",
          name: "document.pdf",
          sizeBytes: 2048,
        },
      ];

      const mockAnalysisResult: VisionAnalysisResult = {
        text: "这是一个登录页面",
        processingTimeMs: 150,
      };

      vi.mocked(mockVisionProvider.analyze).mockResolvedValue(mockAnalysisResult);

      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments(attachments, "实现这个页面", controller.signal);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        imagePath: "/path/to/image.png",
        fileName: "image.png",
        description: "这是一个登录页面",
        processingTimeMs: 150,
      });

      expect(mockVisionProvider.analyze).toHaveBeenCalledTimes(1);
      expect(mockVisionProvider.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          imagePath: "/path/to/image.png",
          prompt: expect.stringContaining("UI 设计图"),
        }),
      );
    });

    it("应该根据文件扩展名识别图片", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "file",
          path: "/path/to/screenshot.jpg",
          name: "screenshot.jpg",
          sizeBytes: 1024,
        },
      ];

      const mockAnalysisResult: VisionAnalysisResult = {
        text: "错误截图内容",
        processingTimeMs: 100,
      };

      vi.mocked(mockVisionProvider.analyze).mockResolvedValue(mockAnalysisResult);

      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments(attachments, "这个错误怎么解决", controller.signal);

      expect(result).toHaveLength(1);
      expect(mockVisionProvider.analyze).toHaveBeenCalledTimes(1);
    });

    it("应该并发分析多张图片", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "image",
          path: "/path/to/image1.png",
          name: "image1.png",
          sizeBytes: 1024,
        },
        {
          type: "image",
          path: "/path/to/image2.png",
          name: "image2.png",
          sizeBytes: 2048,
        },
      ];

      vi.mocked(mockVisionProvider.analyze)
        .mockResolvedValueOnce({
          text: "第一张图片描述",
          processingTimeMs: 100,
        })
        .mockResolvedValueOnce({
          text: "第二张图片描述",
          processingTimeMs: 150,
        });

      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments(attachments, "分析这些图片", controller.signal);

      expect(result).toHaveLength(2);
      expect(mockVisionProvider.analyze).toHaveBeenCalledTimes(2);
    });

    it("应该处理图片分析失败的情况", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "image",
          path: "/path/to/image.png",
          name: "image.png",
          sizeBytes: 1024,
        },
      ];

      vi.mocked(mockVisionProvider.analyze).mockRejectedValue(new Error("分析失败"));

      const controller = new AbortController();
      const result = await imageAnalysisService.analyzeAttachments(attachments, "test", controller.signal);

      expect(result).toEqual([]);
    });
  });

  describe("buildAnalysisPrompt", () => {
    it("应该为 UI 实现请求生成正确的提示词", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "image",
          path: "/path/to/design.png",
          name: "design.png",
          sizeBytes: 1024,
        },
      ];

      vi.mocked(mockVisionProvider.analyze).mockResolvedValue({
        text: "UI 描述",
        processingTimeMs: 100,
      });

      const controller = new AbortController();
      await imageAnalysisService.analyzeAttachments(attachments, "帮我实现这个页面", controller.signal);

      expect(mockVisionProvider.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("UI 设计图"),
        }),
      );
    });

    it("应该为错误诊断请求生成正确的提示词", async () => {
      const attachments: MessageAttachment[] = [
        {
          type: "image",
          path: "/path/to/error.png",
          name: "error.png",
          sizeBytes: 1024,
        },
      ];

      vi.mocked(mockVisionProvider.analyze).mockResolvedValue({
        text: "错误描述",
        processingTimeMs: 100,
      });

      const controller = new AbortController();
      await imageAnalysisService.analyzeAttachments(attachments, "这个错误怎么解决", controller.signal);

      expect(mockVisionProvider.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("错误截图"),
        }),
      );
    });
  });

  describe("buildSystemPromptFragment", () => {
    it("应该返回空字符串当没有分析结果时", () => {
      const fragment = imageAnalysisService.buildSystemPromptFragment([]);
      expect(fragment).toBe("");
    });

    it("应该生成正确的系统提示词片段", () => {
      const analyses = [
        {
          imagePath: "/path/to/image.png",
          fileName: "design.png",
          description: "这是一个登录页面设计",
          processingTimeMs: 150,
        },
      ];

      const fragment = imageAnalysisService.buildSystemPromptFragment(analyses);

      expect(fragment).toContain("📸 用户上传的图片分析");
      expect(fragment).toContain("design.png");
      expect(fragment).toContain("这是一个登录页面设计");
      expect(fragment).toContain("150ms");
    });

    it("应该处理多张图片的分析结果", () => {
      const analyses = [
        {
          imagePath: "/path/to/image1.png",
          fileName: "design1.png",
          description: "登录页面",
          processingTimeMs: 100,
        },
        {
          imagePath: "/path/to/image2.png",
          fileName: "design2.png",
          description: "注册页面",
          processingTimeMs: 120,
        },
      ];

      const fragment = imageAnalysisService.buildSystemPromptFragment(analyses);

      expect(fragment).toContain("图片 1");
      expect(fragment).toContain("图片 2");
      expect(fragment).toContain("design1.png");
      expect(fragment).toContain("design2.png");
    });
  });
});
