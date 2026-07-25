import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { VisionProvider, VisionAnalysisRequest, VisionAnalysisResult, VisionCapability } from "./types";
import { VisionServiceError } from "./types";

/**
 * 本地视觉服务配置
 */
export type LocalVisionServiceOptions = {
  /** Python 可执行文件路径（默认使用 PATH 中的 python） */
  pythonPath?: string;
  /** 服务器端口（默认 8765） */
  port?: number;
  /** 服务器主机（默认 127.0.0.1） */
  host?: string;
  /** 启动超时时间（毫秒，默认 30 秒） */
  startupTimeoutMs?: number;
  /** 健康检查间隔（毫秒，默认 5 秒） */
  healthCheckIntervalMs?: number;
};

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT = 30000;
const DEFAULT_HEALTH_CHECK_INTERVAL = 5000;

/**
 * 本地 Moondream2 视觉服务提供商
 * 通过 Python 子进程运行轻量级视觉模型
 */
export class LocalVisionService implements VisionProvider {
  readonly id = "moondream2";
  readonly displayName = "Moondream2 (Local)";
  readonly capabilities: VisionCapability[] = [
    "ui_understanding",
    "code_screenshot",
    "chart_analysis",
    "ocr",
    "object_detection",
    "vqa",
    "dense_captioning",
  ];
  readonly modelSizeBytes = 1_600_000_000; // ~1.6GB

  private pythonProcess: ChildProcess | null = null;
  private readonly pythonPath: string;
  private readonly port: number;
  private readonly host: string;
  private readonly startupTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isHealthy = false;
  private readonly serverScriptPath: string;

  constructor(
    private readonly extensionPath: string,
    options: LocalVisionServiceOptions = {}
  ) {
    this.pythonPath = options.pythonPath || "python";
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    this.startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs || DEFAULT_HEALTH_CHECK_INTERVAL;
    this.serverScriptPath = path.join(extensionPath, "python", "vision_server.py");
  }

  /**
   * 启动 Python 视觉服务器
   */
  async start(): Promise<void> {
    if (this.pythonProcess) {
      throw new VisionServiceError("service_not_started", "Service already started");
    }

    // 检查 Python 脚本是否存在
    if (!fs.existsSync(this.serverScriptPath)) {
      throw new VisionServiceError(
        "python_process_failed",
        `Vision server script not found: ${this.serverScriptPath}`
      );
    }

    // 启动 Python 子进程
    this.pythonProcess = spawn(
      this.pythonPath,
      [this.serverScriptPath, "--port", String(this.port), "--host", this.host],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      }
    );

    // 监听输出（用于调试）
    this.pythonProcess.stdout?.on("data", (data) => {
      console.log(`[VisionService] ${data.toString().trim()}`);
    });

    this.pythonProcess.stderr?.on("data", (data) => {
      console.error(`[VisionService] ${data.toString().trim()}`);
    });

    this.pythonProcess.on("error", (error) => {
      console.error(`[VisionService] Process error:`, error);
      this.isHealthy = false;
    });

    this.pythonProcess.on("exit", (code, signal) => {
      console.log(`[VisionService] Process exited with code ${code}, signal ${signal}`);
      this.isHealthy = false;
      this.pythonProcess = null;
    });

    // 等待服务就绪
    await this.waitForReady();

    // 启动健康检查
    this.startHealthCheck();
  }

  /**
   * 等待服务器就绪（轮询健康检查端点）
   */
  private async waitForReady(): Promise<void> {
    const startTime = Date.now();
    const url = `http://${this.host}:${this.port}/health`;

    while (Date.now() - startTime < this.startupTimeoutMs) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          const data = await response.json();
          if (data.status === "healthy") {
            this.isHealthy = true;
            console.log(`[VisionService] Service ready at ${url}`);
            return;
          }
        }
      } catch {
        // 忽略连接错误，继续轮询
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new VisionServiceError(
      "service_not_started",
      `Vision service failed to start within ${this.startupTimeoutMs}ms`
    );
  }

  /**
   * 启动定期健康检查
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      this.isHealthy = await this.healthCheck();
    }, this.healthCheckIntervalMs);
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    if (!this.pythonProcess) {
      return false;
    }

    try {
      const response = await fetch(`http://${this.host}:${this.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 分析图片
   */
  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    if (!this.isHealthy) {
      throw new VisionServiceError("service_not_started", "Vision service is not healthy");
    }

    if (request.signal.aborted) {
      throw new VisionServiceError("analysis_timeout", "Request was aborted");
    }

    // 检查图片文件是否存在
    if (!fs.existsSync(request.imagePath)) {
      throw new VisionServiceError("invalid_image_path", `Image not found: ${request.imagePath}`);
    }

    try {
      const response = await fetch(`http://${this.host}:${this.port}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_path: request.imagePath,
          prompt: request.prompt || "Describe this image in detail.",
          output_format: request.outputFormat || "text",
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new VisionServiceError("http_request_failed", `HTTP ${response.status}: ${error}`);
      }

      const result = await response.json();
      return {
        text: result.text,
        data: result.data,
        confidence: result.confidence,
        processingTimeMs: result.processing_time_ms,
      };
    } catch (error) {
      if (error instanceof VisionServiceError) {
        throw error;
      }
      throw new VisionServiceError(
        "http_request_failed",
        `Analysis request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 停止服务并释放资源
   */
  async dispose(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.pythonProcess) {
      this.pythonProcess.kill("SIGTERM");

      // 等待进程退出（最多 5 秒）
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.pythonProcess?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.pythonProcess?.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.pythonProcess = null;
    }

    this.isHealthy = false;
    console.log("[VisionService] Disposed");
  }
}
