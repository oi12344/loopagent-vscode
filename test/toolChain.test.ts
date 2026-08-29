import { describe, it, expect, vi } from "vitest";
import { ToolChainExecutor, type ToolInvoker } from "../src/extension/agent/toolChain";
import type { ReactAgentToolRequest, ReactAgentToolResult } from "../src/extension/agent/reactTypes";

function makeRequest(id: string, name: string): ReactAgentToolRequest {
  return { id, name, rawArguments: "", input: {} };
}

function makeResult(content: string): ReactAgentToolResult {
  return { content, evidence: [] };
}

describe("ToolChainExecutor", () => {
  it("tools execute in order with context passing", async () => {
    const calls: string[] = [];
    const invokeTool: ToolInvoker = async (request, _signal, context) => {
      calls.push(request.id);
      return makeResult(`result-${request.id}`);
    };

    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("step-1", "toolA"));
    chain.addStep(makeRequest("step-2", "toolB"));
    chain.addStep(makeRequest("step-3", "toolC"));

    const results = await chain.execute(new AbortController().signal);

    expect(calls).toEqual(["step-1", "step-2", "step-3"]);
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("result-step-1");
    expect(results[1].content).toBe("result-step-2");
    expect(results[2].content).toBe("result-step-3");
  });

  it("each step receives previous step's output as context", async () => {
    const contexts: (string | undefined)[] = [];
    const invokeTool: ToolInvoker = async (request, _signal, context) => {
      contexts.push(context);
      return makeResult(`output-${request.id}`);
    };

    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("a", "toolA"));
    chain.addStep(makeRequest("b", "toolB"));
    chain.addStep(makeRequest("c", "toolC"));

    await chain.execute(new AbortController().signal);

    expect(contexts).toEqual([undefined, "output-a", "output-b"]);
  });

  it("getContextForStep returns previous tool's output", async () => {
    const invokeTool: ToolInvoker = async (request) => {
      return makeResult(`result-${request.id}`);
    };

    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("first", "toolA"));
    chain.addStep(makeRequest("second", "toolB"));

    await chain.execute(new AbortController().signal);

    expect(chain.getContextForStep(0)).toBeUndefined();
    expect(chain.getContextForStep(1)).toBe("result-first");
  });

  it("first step has no context", async () => {
    const invokeTool: ToolInvoker = async (request, _signal, context) => {
      expect(context).toBeUndefined();
      return makeResult("ok");
    };

    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("only", "toolA"));

    await chain.execute(new AbortController().signal);
  });

  it("clear resets all steps", async () => {
    const invokeTool: ToolInvoker = async () => makeResult("ok");
    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("a", "toolA"));
    chain.addStep(makeRequest("b", "toolB"));

    chain.clear();

    expect(chain.getContextForStep(0)).toBeUndefined();
    expect(chain.getContextForStep(1)).toBeUndefined();

    const results = await chain.execute(new AbortController().signal);
    expect(results).toHaveLength(0);
  });

  it("propagates abort signal to tool invoker", async () => {
    const receivedSignals: AbortSignal[] = [];
    const invokeTool: ToolInvoker = async (_request, signal) => {
      receivedSignals.push(signal);
      return makeResult("ok");
    };

    const controller = new AbortController();
    const chain = new ToolChainExecutor(invokeTool);
    chain.addStep(makeRequest("a", "toolA"));

    await chain.execute(controller.signal);

    expect(receivedSignals[0]).toBe(controller.signal);
  });
});
