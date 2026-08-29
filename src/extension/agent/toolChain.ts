import type { ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";

export type ToolInvoker = (
  request: ReactAgentToolRequest,
  signal: AbortSignal,
  context?: string,
) => Promise<ReactAgentToolResult>;

export type ToolChainStep = {
  request: ReactAgentToolRequest;
  result?: ReactAgentToolResult;
};

/**
 * 工具链执行器：在同一步骤内顺序执行工具，并将前一个工具的输出传递给下一个工具
 */
export class ToolChainExecutor {
  private readonly invokeTool: ToolInvoker;
  private steps: ToolChainStep[] = [];

  constructor(invokeTool: ToolInvoker) {
    this.invokeTool = invokeTool;
  }

  addStep(request: ReactAgentToolRequest): void {
    this.steps.push({ request });
  }

  async execute(signal: AbortSignal): Promise<ReactAgentToolResult[]> {
    const results: ReactAgentToolResult[] = [];
    let previousOutput: string | undefined;

    for (const step of this.steps) {
      const result = await this.invokeTool(step.request, signal, previousOutput);
      step.result = result;
      results.push(result);
      previousOutput = result.content;
    }

    return results;
  }

  getContextForStep(index: number): string | undefined {
    if (index <= 0) return undefined;
    return this.steps[index - 1]?.result?.content;
  }

  clear(): void {
    this.steps = [];
  }
}
