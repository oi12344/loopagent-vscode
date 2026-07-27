/**
 * 工具调度系统 - 统一管理所有工具的执行、优先级、并发和监控
 */

import type { ReactAgentTool, ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";

// ============================================================
// 类型定义
// ============================================================

export type ToolPriority = "critical" | "high" | "normal" | "low";
export type ToolCost = "expensive" | "moderate" | "cheap";
export type ExecutionMode = "serial" | "parallel" | "adaptive";

export interface ToolMetadata {
  name: string;
  priority: ToolPriority;
  cost: ToolCost;
  concurrent: boolean; // 是否支持并发执行
  timeout?: number; // 超时时间（ms）
  conflictsWith?: string[]; // 冲突的工具列表
}

export interface DispatchRequest {
  toolName: string;
  input: unknown;
  priority?: ToolPriority;
  signal?: AbortSignal;
  metadata?: Partial<ToolMetadata>;
}

export interface DispatchResult {
  success: boolean;
  result?: ReactAgentToolResult;
  error?: string;
  duration: number;
  retriedCount: number;
}

export interface DispatchStrategy {
  mode: ExecutionMode;
  maxConcurrent: number;
  priorityStrategy: "fifo" | "priority-based" | "cost-aware";
  retryPolicy?: {
    maxAttempts: number;
    backoff: "linear" | "exponential";
    retryableErrors?: RegExp[];
  };
}

export interface ToolExecutionEvent {
  type: "started" | "completed" | "failed" | "queued" | "retry";
  toolName: string;
  requestId: string;
  timestamp: number;
  duration?: number;
  error?: string;
  retryCount?: number;
}

export type ToolExecutionListener = (event: ToolExecutionEvent) => void;

// ============================================================
// 执行统计
// ============================================================

interface ExecutionStats {
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  totalDuration: number;
  averageDuration: number;
  byTool: Map<string, {
    executions: number;
    failures: number;
    totalDuration: number;
    avgDuration: number;
  }>;
}

// ============================================================
// 队列项
// ============================================================

interface QueuedTask {
  id: string;
  request: DispatchRequest;
  priority: ToolPriority;
  cost: ToolCost;
  queuedAt: number;
  resolve: (result: DispatchResult) => void;
  reject: (error: Error) => void;
}

// ============================================================
// 工具调度器
// ============================================================

export interface ToolDispatcher {
  /**
   * 注册工具及其元数据
   */
  register(tool: ReactAgentTool, metadata: ToolMetadata): void;

  /**
   * 单个工具调度
   */
  dispatch(request: DispatchRequest): Promise<DispatchResult>;

  /**
   * 批量调度
   */
  dispatchBatch(requests: DispatchRequest[], mode?: ExecutionMode): Promise<DispatchResult[]>;

  /**
   * 获取执行统计
   */
  getStats(): ExecutionStats;

  /**
   * 订阅执行事件
   */
  on(listener: ToolExecutionListener): () => void;

  /**
   * 清空队列
   */
  clearQueue(): void;

  /**
   * 获取队列状态
   */
  getQueueStatus(): {
    size: number;
    running: number;
    byPriority: Record<ToolPriority, number>;
  };
}

// ============================================================
// 实现
// ============================================================

const PRIORITY_VALUES: Record<ToolPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const COST_WEIGHT: Record<ToolCost, number> = {
  expensive: 3,
  moderate: 2,
  cheap: 1,
};

export function createToolDispatcher(
  tools: ReactAgentTool[],
  strategy: DispatchStrategy = {
    mode: "adaptive",
    maxConcurrent: 5,
    priorityStrategy: "cost-aware",
  }
): ToolDispatcher {
  const toolRegistry = new Map<string, ReactAgentTool>();
  const metadataRegistry = new Map<string, ToolMetadata>();
  const queue: QueuedTask[] = [];
  const running = new Map<string, QueuedTask>();
  const listeners = new Set<ToolExecutionListener>();

  // 统计数据
  const stats: ExecutionStats = {
    totalExecutions: 0,
    successCount: 0,
    failureCount: 0,
    totalDuration: 0,
    averageDuration: 0,
    byTool: new Map(),
  };

  let nextRequestId = 1;

  // ============================================================
  // 事件发射
  // ============================================================

  function emit(event: ToolExecutionEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 忽略监听器错误
      }
    }
  }

  // ============================================================
  // 工具注册
  // ============================================================

  function register(tool: ReactAgentTool, metadata: ToolMetadata): void {
    toolRegistry.set(tool.name, tool);
    metadataRegistry.set(tool.name, metadata);
  }

  // 初始化已有工具
  for (const tool of tools) {
    register(tool, {
      name: tool.name,
      priority: "normal",
      cost: "moderate",
      concurrent: tool.isConcurrencySafe?.(undefined) ?? false,
    });
  }

  // ============================================================
  // 优先级计算
  // ============================================================

  function calculateScore(task: QueuedTask): number {
    const priorityScore = PRIORITY_VALUES[task.priority];
    const costPenalty = COST_WEIGHT[task.cost];
    const ageBonus = Math.min((Date.now() - task.queuedAt) / 1000, 5); // 等待时间加成

    if (strategy.priorityStrategy === "fifo") {
      return task.queuedAt;
    } else if (strategy.priorityStrategy === "priority-based") {
      return priorityScore * 100 + ageBonus;
    } else {
      // cost-aware: 优先级高且成本低的优先
      return priorityScore * 100 - costPenalty * 10 + ageBonus;
    }
  }

  // ============================================================
  // 冲突检测
  // ============================================================

  function hasConflict(task: QueuedTask): boolean {
    const metadata = metadataRegistry.get(task.request.toolName);
    if (!metadata?.conflictsWith) return false;

    for (const runningTask of running.values()) {
      if (metadata.conflictsWith.includes(runningTask.request.toolName)) {
        return true;
      }
    }

    return false;
  }

  // ============================================================
  // 调度逻辑
  // ============================================================

  function schedule(): void {
    while (running.size < strategy.maxConcurrent && queue.length > 0) {
      // 按优先级排序
      queue.sort((a, b) => calculateScore(b) - calculateScore(a));

      // 找第一个无冲突的任务
      const taskIndex = queue.findIndex((task) => !hasConflict(task));
      if (taskIndex === -1) break;

      const task = queue.splice(taskIndex, 1)[0];
      void executeTask(task);
    }
  }

  // ============================================================
  // 任务执行
  // ============================================================

  async function executeTask(task: QueuedTask): Promise<void> {
    const { id, request } = task;
    const tool = toolRegistry.get(request.toolName);

    if (!tool) {
      task.reject(new Error(`Tool not found: ${request.toolName}`));
      return;
    }

    running.set(id, task);
    const startTime = Date.now();

    emit({
      type: "started",
      toolName: request.toolName,
      requestId: id,
      timestamp: startTime,
    });

    let attempts = 0;
    const maxAttempts = strategy.retryPolicy?.maxAttempts ?? 1;
    let lastError: Error | undefined;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        const toolRequest: ReactAgentToolRequest = {
          id,
          name: request.toolName,
          rawArguments: JSON.stringify(request.input ?? null),
          input: request.input,
        };

        const result = await tool.invoke({
          request: toolRequest,
          input: request.input,
          signal: request.signal ?? new AbortController().signal,
        });

        const duration = Date.now() - startTime;

        // 更新统计
        updateStats(request.toolName, duration, true);

        emit({
          type: "completed",
          toolName: request.toolName,
          requestId: id,
          timestamp: Date.now(),
          duration,
        });

        task.resolve({
          success: true,
          result: typeof result === "string" ? { content: result, evidence: [] } : result,
          duration,
          retriedCount: attempts - 1,
        });

        running.delete(id);
        schedule();
        return;
      } catch (error) {
        lastError = error as Error;

        if (attempts < maxAttempts) {
          const delay = calculateBackoff(attempts);
          emit({
            type: "retry",
            toolName: request.toolName,
            requestId: id,
            timestamp: Date.now(),
            retryCount: attempts,
            error: lastError.message,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 所有重试失败
    const duration = Date.now() - startTime;
    updateStats(request.toolName, duration, false);

    emit({
      type: "failed",
      toolName: request.toolName,
      requestId: id,
      timestamp: Date.now(),
      duration,
      error: lastError?.message,
    });

    task.resolve({
      success: false,
      error: lastError?.message ?? "Unknown error",
      duration,
      retriedCount: attempts - 1,
    });

    running.delete(id);
    schedule();
  }

  function calculateBackoff(attempt: number): number {
    if (strategy.retryPolicy?.backoff === "exponential") {
      return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    }
    return 1000 * attempt; // linear
  }

  // ============================================================
  // 统计更新
  // ============================================================

  function updateStats(toolName: string, duration: number, success: boolean): void {
    stats.totalExecutions++;
    stats.totalDuration += duration;
    stats.averageDuration = stats.totalDuration / stats.totalExecutions;

    if (success) {
      stats.successCount++;
    } else {
      stats.failureCount++;
    }

    if (!stats.byTool.has(toolName)) {
      stats.byTool.set(toolName, {
        executions: 0,
        failures: 0,
        totalDuration: 0,
        avgDuration: 0,
      });
    }

    const toolStats = stats.byTool.get(toolName)!;
    toolStats.executions++;
    toolStats.totalDuration += duration;
    toolStats.avgDuration = toolStats.totalDuration / toolStats.executions;
    if (!success) {
      toolStats.failures++;
    }
  }

  // ============================================================
  // 公共 API
  // ============================================================

  return {
    register,

    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      const id = `req-${nextRequestId++}`;
      const metadata = metadataRegistry.get(request.toolName);
      const priority = request.priority ?? metadata?.priority ?? "normal";
      const cost = metadata?.cost ?? "moderate";

      return new Promise((resolve, reject) => {
        const task: QueuedTask = {
          id,
          request,
          priority,
          cost,
          queuedAt: Date.now(),
          resolve,
          reject,
        };

        queue.push(task);

        emit({
          type: "queued",
          toolName: request.toolName,
          requestId: id,
          timestamp: Date.now(),
        });

        schedule();
      });
    },

    async dispatchBatch(requests: DispatchRequest[], mode?: ExecutionMode): Promise<DispatchResult[]> {
      const batchMode = mode ?? strategy.mode;

      if (batchMode === "serial") {
        const results: DispatchResult[] = [];
        for (const req of requests) {
          results.push(await this.dispatch(req));
        }
        return results;
      } else {
        // parallel or adaptive
        return Promise.all(requests.map((req) => this.dispatch(req)));
      }
    },

    getStats(): ExecutionStats {
      return {
        ...stats,
        byTool: new Map(stats.byTool),
      };
    },

    on(listener: ToolExecutionListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clearQueue(): void {
      for (const task of queue) {
        task.reject(new Error("Queue cleared"));
      }
      queue.length = 0;
    },

    getQueueStatus() {
      const byPriority: Record<ToolPriority, number> = {
        critical: 0,
        high: 0,
        normal: 0,
        low: 0,
      };

      for (const task of queue) {
        byPriority[task.priority]++;
      }

      return {
        size: queue.length,
        running: running.size,
        byPriority,
      };
    },
  };

}
