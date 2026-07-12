import type { ReactAgentTool } from "./reactTypes";

export function createDefaultReactTools(): ReactAgentTool[] {
  return [
    {
      name: "echoObservation",
      description: "Echo an observation.",
      inputSchema: {},
      invoke({ input }) {
        return String(input);
      },
    },
  ];
}
