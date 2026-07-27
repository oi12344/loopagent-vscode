import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { LocalVisionService } from "../src/extension/vision/localVisionService";
import { HybridInferenceService } from "../src/extension/vision/hybridInference";
import type { EditOperation } from "../src/extension/agent/editPreviewService";

/**
 * 视觉模型集成测试
 *
 * 注意：这些测试需要：
 * 1. Python 3.10+ 已安装
 * 2. 依赖已安装：pip install -r python/requirements.txt
 * 3. 足够的磁盘空间（约 2GB 用于模型下载）
 */

describe("Vision Service Integration", () => {
  let visionService: LocalVisionService;
  const testExtensionPath = path.resolve(__dirname, "..");
  const testScreenshotPath = path.join(__dirname, "fixtures", "test-screenshot.png");

  beforeAll(async () => {
    // 创建测试截图目录
    const fixturesDir = path.join(__dirname, "fixtures");
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // 创建简单的测试图片（如果不存在）
    if (!fs.existsSync(testScreenshotPath)) {
      console.log("⚠️  Test screenshot not found. Please add a test image at:", testScreenshotPath);
    }

    // 初始化视觉服务
    visionService = new LocalVisionService(testExtensionPath, {
      port: 8766, // 使用不同端口避免冲突
      startupTimeoutMs: 60000, // 首次启动需要下载模型
    });

    console.log("🚀 Starting vision service (may take 30-60s on first run)...");
    await visionService.start();
    console.log("✅ Vision service started");
  }, 120000); // 2 分钟超时

  afterAll(async () => {
    if (visionService) {
      await visionService.dispose();
    }
  });

  it("should pass health check", async () => {
    const isHealthy = await visionService.healthCheck();
    expect(isHealthy).toBe(true);
  });

  it("should analyze a screenshot", async () => {
    if (!fs.existsSync(testScreenshotPath)) {
      console.log("⏭️  Skipping screenshot analysis test (no test image)");
      return;
    }

    const result = await visionService.analyze({
      imagePath: testScreenshotPath,
      prompt: "Describe what you see in this code editor screenshot.",
      signal: new AbortController().signal,
    });

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(10);
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    console.log("📊 Analysis result:", result.text);
    console.log("⏱️  Processing time:", result.processingTimeMs, "ms");
  }, 30000);

  it("should detect code errors in screenshot", async () => {
    if (!fs.existsSync(testScreenshotPath)) {
      console.log("⏭️  Skipping error detection test (no test image)");
      return;
    }

    const result = await visionService.analyze({
      imagePath: testScreenshotPath,
      prompt: "List all error markers (red squiggly lines) and warnings in this code editor screenshot.",
      signal: new AbortController().signal,
    });

    expect(result.text).toBeTruthy();
    console.log("🔍 Error detection:", result.text);
  }, 30000);
});

describe("Hybrid Inference Service", () => {
  let visionService: LocalVisionService;
  let hybridService: HybridInferenceService;
  const testExtensionPath = path.resolve(__dirname, "..");

  beforeAll(async () => {
    visionService = new LocalVisionService(testExtensionPath, {
      port: 8767,
      startupTimeoutMs: 60000,
    });

    await visionService.start();

    // 创建混合推理服务（使用模拟的文本模型）
    hybridService = new HybridInferenceService(
      visionService,
      async (prompt: string, signal: AbortSignal) => {
        // 模拟 DeepSeek 响应
        return `{
          "changes_applied_correctly": true,
          "issues": [
            {"severity": "warning", "description": "变量名可以更具描述性", "file": "test.ts"}
          ],
          "quality_score": 85,
          "suggestions": ["考虑添加类型注解", "添加单元测试"],
          "full_analysis": "代码改动整体正确，但有改进空间。"
        }`;
      }
    );
  }, 120000);

  afterAll(async () => {
    if (visionService) {
      await visionService.dispose();
    }
  });

  it("should perform hybrid analysis without screenshot", async () => {
    const changes: EditOperation[] = [
      {
        kind: "replace",
        path: "src/test.ts",
        oldText: "function getUserName() { return 'John'; }",
        newText: "function getUsername() { return 'John'; }",
      },
    ];

    const result = await hybridService.analyze({
      changes,
      analysisGoal: "verify_changes",
      signal: new AbortController().signal,
    });

    expect(result.deepAnalysis.changesAppliedCorrectly).toBe(true);
    expect(result.deepAnalysis.fullAnalysis).toBeTruthy();
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    console.log("📝 Hybrid analysis result:", result);
  }, 30000);

  it("should handle analysis timeout", async () => {
    const changes: EditOperation[] = [
      { kind: "create", path: "test.ts", content: "console.log('hello');" },
    ];

    const controller = new AbortController();
    controller.abort(); // 立即取消

    await expect(
      hybridService.analyze({
        changes,
        analysisGoal: "detect_errors",
        signal: controller.signal,
      })
    ).rejects.toThrow("aborted");
  });
});

describe("Performance Benchmarks", () => {
  let visionService: LocalVisionService;
  const testExtensionPath = path.resolve(__dirname, "..");
  const testScreenshotPath = path.join(__dirname, "fixtures", "test-screenshot.png");

  beforeAll(async () => {
    visionService = new LocalVisionService(testExtensionPath, {
      port: 8768,
      startupTimeoutMs: 60000,
    });
    await visionService.start();
  }, 120000);

  afterAll(async () => {
    if (visionService) {
      await visionService.dispose();
    }
  });

  it("should analyze image in under 3 seconds (CPU)", async () => {
    if (!fs.existsSync(testScreenshotPath)) {
      console.log("⏭️  Skipping performance benchmark (no test image)");
      return;
    }

    const iterations = 3;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await visionService.analyze({
        imagePath: testScreenshotPath,
        prompt: "Describe this image briefly.",
        signal: new AbortController().signal,
      });
      times.push(result.processingTimeMs);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`⏱️  Average processing time: ${avgTime.toFixed(0)}ms (${iterations} iterations)`);
    console.log(`   Min: ${Math.min(...times)}ms, Max: ${Math.max(...times)}ms`);

    // CPU 模式下，期望在 3 秒内完成
    expect(avgTime).toBeLessThan(3000);
  }, 60000);
});
