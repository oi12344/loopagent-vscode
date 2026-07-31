import { describe, expect, it, vi } from "vitest";
import { compileGeneratedWorkflow } from "../../src/extension/agent/workflow/workflowCompiler";
import { createDynamicGraphEngine } from "../../src/extension/agent/workflow/dynamicGraphEngine";
import type { WorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";
import type { GraphExecutionEvent } from "../../src/extension/agent/workflow/dynamicGraphTypes";
import type { SubagentResult } from "../../src/extension/agent/workflow/types";

// 状态驱动路径（compiledGraph）此前把 GraphCompleted 的 failedNodes / unreachedNodes 硬编码为
// 空数组，且只把 completed 结果放进 results。结果是：节点失败后父智能体既看不到哪个节点失败，
// 也拿不到失败原因，只能凭“有结果就是成功”继续输出总结。本文件锁死失败证据必须可见。
describe("状态驱动图的失败可见性", () => {
	function orchestratorWith(resultOf: (task: string) => SubagentResult): WorkflowOrchestrator {
		const tasks = new Map<string, string>();
		return {
			createSubagent: vi.fn((config) => {
				const id = `${config.role}-${tasks.size}-${Math.random()}`;
				tasks.set(id, config.task);
				return id;
			}),
			waitForSubagents: vi.fn(async (ids) => new Map(ids.map((id) => [id, resultOf(tasks.get(id) ?? "")]))),
			getSubagent: vi.fn(),
			cancelSubagent: vi.fn(),
			cancelAll: vi.fn(),
			onEvent: vi.fn(() => () => {}),
		} as unknown as WorkflowOrchestrator;
	}

	function completedEventOf(events: GraphExecutionEvent[]) {
		const event = events.find((candidate) => candidate.type === "GraphCompleted");
		if (!event || event.type !== "GraphCompleted") throw new Error("GraphCompleted 未发出");
		return event;
	}

	it("失败节点出现在 failedNodes，被它阻塞的后继出现在 unreachedNodes", async () => {
		const orchestrator = orchestratorWith((task) =>
			task.includes("读取")
				? { status: "failed", error: "ENOENT: missing.ts 不存在" }
				: { status: "completed", content: "ok" },
		);
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "read", task: "读取 missing.ts", role: "explorer" },
				{ id: "summarize", task: "汇总", role: "planner", after: ["read"] },
			],
			entry: ["read"],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});
		const events: GraphExecutionEvent[] = [];
		engine.onEvent((event) => events.push(event));

		await engine.execute();

		const completed = completedEventOf(events);
		expect(completed.failedNodes).toEqual(["read"]);
		expect(completed.unreachedNodes).toEqual(["summarize"]);
	});

	it("失败节点的结果保留在 results 中，携带错误原文", async () => {
		const orchestrator = orchestratorWith((task) =>
			task.includes("读取")
				? { status: "failed", error: "ENOENT: missing.ts 不存在" }
				: { status: "completed", content: "ok" },
		);
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "read", task: "读取 missing.ts", role: "explorer" },
				{ id: "summarize", task: "汇总", role: "planner", after: ["read"] },
			],
			entry: ["read"],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});

		const results = await engine.execute();

		expect(results.get("read")?.status).toBe("failed");
		expect(results.get("read")?.error).toContain("ENOENT");
	});

	it("失败节点的输出不写入 outputs 通道，下游拿不到伪造上下文", async () => {
		const orchestrator = orchestratorWith((task) =>
			task.includes("读取")
				? { status: "failed", error: "boom" }
				: { status: "completed", content: "ok" },
		);
		const graph = compileGeneratedWorkflow({
			nodes: [{ id: "read", task: "读取 x", role: "explorer" }],
			entry: ["read"],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});

		await engine.execute();

		expect(engine.getStateSnapshot()?.values.get("outputs.read")).toBeUndefined();
	});

	it("全部成功时 failedNodes 与 unreachedNodes 为空", async () => {
		const orchestrator = orchestratorWith(() => ({ status: "completed", content: "ok" }));
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "read", task: "读取", role: "explorer" },
				{ id: "summarize", task: "汇总", role: "planner", after: ["read"] },
			],
			entry: ["read"],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});
		const events: GraphExecutionEvent[] = [];
		engine.onEvent((event) => events.push(event));

		await engine.execute();

		const completed = completedEventOf(events);
		expect(completed.failedNodes).toEqual([]);
		expect(completed.unreachedNodes).toEqual([]);
	});

	it("多个节点失败时全部列出", async () => {
		const orchestrator = orchestratorWith((task) =>
			task.includes("ok") ? { status: "completed", content: "ok" } : { status: "failed", error: "boom" },
		);
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "a", task: "ok a", role: "explorer" },
				{ id: "b", task: "bad b", role: "explorer" },
				{ id: "c", task: "bad c", role: "explorer" },
			],
			entry: ["a", "b", "c"],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});
		const events: GraphExecutionEvent[] = [];
		engine.onEvent((event) => events.push(event));

		await engine.execute();

		const completed = completedEventOf(events);
		expect(completed.failedNodes.slice().sort()).toEqual(["b", "c"]);
	});
});
