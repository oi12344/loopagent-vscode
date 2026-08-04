import type { ReactAgentTool, ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";

export type ToolInvoker = (
  request: ReactAgentToolRequest,
  signal: AbortSignal,
) => Promise<ReactAgentToolResult>;

export type ReactAgentToolRegistry = {
  invoke(request: ReactAgentToolRequest, signal: AbortSignal): Promise<ReactAgentToolResult>;
};

export function createToolInvoker(tools: readonly ReactAgentTool[]): ToolInvoker {
  return (request, signal) => invokeRegisteredTool(tools, request, signal);
}

export function invokeRegisteredTool(
  tools: readonly ReactAgentTool[],
  request: ReactAgentToolRequest,
  signal: AbortSignal,
): Promise<ReactAgentToolResult> {
  const tool = tools.find((candidate) => candidate.name === request.name);
  if (!tool) return Promise.reject(new Error(`Unknown tool: ${request.name}`));

  return Promise.resolve(tool.invoke({ request, input: request.input, signal })).then((result) =>
    typeof result === "string" ? { content: result, evidence: [] } : result,
  );
}

export function createToolRegistry(tools: ReactAgentTool[] = []): ReactAgentToolRegistry {
  const invoke = createToolInvoker(tools);
  return { invoke };
}
