import { describe, expect, it, vi } from "vitest";

import { createDynamicWorkflowTools } from "../../src/extension/agent/dynamicWorkflowTools";
import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";
import type { CreateSubagentConfig, SubagentResult } from "../../src/extension/agent/workflow/types";
import type { WorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";

// runDynamicGraph 的返回值是父智能体判断“这张图到底成了没有”的唯一依据。此前它只返回
// completedNodes / statusCounts，失败节点既不在返回值里、错误原文也拿不到，父智能体只要看到
// 有结果就会输出总结。本文件锁死失败节点、错误原文和未到达节点必须出现在工具返回值中。
describe("runDynamicGraph 返回值的失败可见性", () => {
	function orchestratorWith(resultOf: (task: string) => SubagentResult): WorkflowOrchestrator {
		const configs = new Map<string, CreateSubagentConfig>();
		let nextId = 1;
		return {
			createSubagent: vi.fn((config) => {
				const id = `subagent-${nextId++}`;
				configs.set(id, config);
				return id;
			}),
			waitForSubagents: vi.fn(async (ids) =>
				new Map(ids.map((id) => [id, resultOf(configs.get(id)?.task ?? "")]))),
			getSubagent: vi.fn(),
			cancelSubagent: vi.fn(() => true),
			cancelAll: vi.fn(),
			onEvent: vi.fn(() => () => {}),
		} as unknown as WorkflowOrchestrator;
	}

	function failOn(marker: string) {
		return (task: string): SubagentResult =>
			task.includes(marker)
				? { status: "failed", error: `ENOENT: ${marker} 不存在` }
				: { status: "completed", content: "ok" };
	}

	async function run(orchestrator: WorkflowOrchestrator, input: Record<string, unknown>): Promise<any> {
		const tools = createDynamicWorkflowTools({ orchestrator, availableTools: [] });
		const tool = tools.find((candidate) => candidate.name === "runDynamicGraph")!;
		const output = await tool.invoke({
			request: { id: "request-1", name: "runDynamicGraph", rawArguments: JSON.stringify(input), input },
			input,
			signal: new AbortController().signal,
		} as Parameters<ReactAgentTool["invoke"]>[0]);
		return JSON.parse(String(output));
	}

	// 图里必须有一个独立成功的节点：伪成功的真实形态是“部分成功、部分失败”，此时工具不会撞上
	// “零节点完成”的兜底抛错，返回值就是父智能体判断成败的唯一依据。
	describe("语义路径（nodes / after）", () => {
		const plan = {
			nodes: [
				{ id: "probe", task: "独立探查", role: "explorer" },
				{ id: "read", task: "读取 missing 文件", role: "explorer" },
				{ id: "summarize", task: "汇总结果", role: "planner", after: ["read"] },
			],
			entry: ["probe", "read"],
		};

		it("失败节点带错误原文出现在 failedNodes", async () => {
			const result = await run(orchestratorWith(failOn("missing")), plan);

			expect(result.failedNodes).toEqual([
				expect.objectContaining({ nodeId: "read", error: expect.stringContaining("ENOENT") }),
			]);
		});

		it("被阻塞的后继出现在 unreachedNodes", async () => {
			const result = await run(orchestratorWith(failOn("missing")), plan);

			expect(result.unreachedNodes).toEqual(["summarize"]);
		});

		it("workflowStatus 在存在失败时不是 completed", async () => {
			const result = await run(orchestratorWith(failOn("missing")), plan);

			expect(result.workflowStatus).not.toBe("completed");
		});

		it("全部成功时 workflowStatus 为 completed 且失败列表为空", async () => {
			const result = await run(orchestratorWith(() => ({ status: "completed", content: "ok" })), plan);

			expect(result.workflowStatus).toBe("completed");
			expect(result.failedNodes).toEqual([]);
			expect(result.unreachedNodes).toEqual([]);
		});

		it("失败节点的结果保留在 results 中", async () => {
			const result = await run(orchestratorWith(failOn("missing")), plan);

			expect(result.results.read.status).toBe("failed");
		});
	});

	describe("legacy 路径（initialNodes / dependsOn）", () => {
		const plan = {
			initialNodes: [
				{ id: "probe", task: "独立探查", role: "explorer" },
				{ id: "read", task: "读取 missing 文件", role: "explorer" },
				{ id: "summarize", task: "汇总结果", role: "planner", dependsOn: ["read"] },
			],
		};

		it("同样暴露 failedNodes 与 workflowStatus", async () => {
			const result = await run(orchestratorWith(failOn("missing")), plan);

			expect(result.failedNodes).toEqual([
				expect.objectContaining({ nodeId: "read", error: expect.stringContaining("ENOENT") }),
			]);
			expect(result.workflowStatus).not.toBe("completed");
		});
	});
});
