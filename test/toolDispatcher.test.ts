import { describe, expect, it } from "vitest";

import { createToolDispatcher } from "../src/extension/agent/toolDispatcher";
import type { ReactAgentToolRequest } from "../src/extension/agent/reactTypes";

describe("createToolDispatcher", () => {
  it("dispatches a parallel batch with normalized tool requests", async () => {
    const requests: ReactAgentToolRequest[] = [];
    const dispatcher = createToolDispatcher([{
      name: "echo",
      description: "Echo input",
      inputSchema: {},
      invoke: async ({ request }) => {
        requests.push(request);
        return JSON.stringify(request.input);
      },
    }]);

    const results = await dispatcher.dispatchBatch([
      { toolName: "echo", input: { value: 1 } },
      { toolName: "echo", input: { value: 2 } },
    ], "parallel");

    expect(results.map((result) => result.success)).toEqual([true, true]);
    expect(requests).toEqual([
      { id: "req-1", name: "echo", rawArguments: '{"value":1}', input: { value: 1 } },
      { id: "req-2", name: "echo", rawArguments: '{"value":2}', input: { value: 2 } },
    ]);
  });
});
