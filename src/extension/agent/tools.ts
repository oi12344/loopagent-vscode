import type { ReactAgentTool } from "./reactTypes";

export function createDefaultReactTools(): ReactAgentTool[] {
  return [
    {
      name: "echoObservation",
      invoke({ input }) {
        return String(input);
      },
    },
  ];
}
