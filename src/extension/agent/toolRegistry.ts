import type { ReactAgentTool, ReactAgentToolRequest, ReactAgentToolResult } from "./reactTypes";

export type ReactAgentToolRegistry = {
  invoke(request: ReactAgentToolRequest, signal: AbortSignal): Promise<ReactAgentToolResult>;
};

export function createToolRegistry(tools: ReactAgentTool[] = []): ReactAgentToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async invoke(request, signal) {
      const tool = toolsByName.get(request.name);

      if (!tool) {
        throw new Error(`Unknown tool: ${request.name}`);
      }

      const result = await tool.invoke({ request, input: request.input, signal });
      return typeof result === "string" ? { content: result, evidence: [] } : result;
    },
  };
}
