import type { ReactAgentTool, ReactAgentToolRequest } from "./reactTypes";

export type ReactAgentToolRegistry = {
  invoke(request: ReactAgentToolRequest, signal: AbortSignal): Promise<string>;
};

export function createToolRegistry(tools: ReactAgentTool[] = []): ReactAgentToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async invoke(request, signal) {
      const tool = toolsByName.get(request.name);

      if (!tool) {
        throw new Error(`Unknown tool: ${request.name}`);
      }

      return tool.invoke({ request, input: request.input, signal });
    },
  };
}
