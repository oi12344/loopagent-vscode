import { describe, expect, it, vi } from "vitest";
import { compileGeneratedWorkflow } from "../../src/extension/agent/workflow/workflowCompiler";
import { createDynamicGraphEngine } from "../../src/extension/agent/workflow/dynamicGraphEngine";
import type { WorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";

/**
 * 验证修复：当 review 节点输出无法解析（既非合法 JSON 决策、又不含 APPROVED）时，
 * getReviewDecision 返回 undefined，路由不应默认 "revise" 把流程推回去造成死循环，
 * 而应让图自然收敛结束并暴露该 review 结果。
 */
describe("review decision fallback on unparseable output", () => {
	it("does not route revise when review output is unparseable, and the graph terminates cleanly", async () => {
		let draftRuns = 0;
		const orchestrator: WorkflowOrchestrator = {
			createSubagent: vi.fn((config) => {
				const id = `${config.role}-${config.task}-${Math.random()}`;
				return id;
			}),
			waitForSubagents: vi.fn(async (ids) => new Map(ids.map((id) => [
				id,
				// review 输出：非法 JSON，且不含 APPROVED —— getReviewDecision 应返回 undefined
				id.includes("review")
					? { status: "completed" as const, content: "the draft looks fine overall, no blockers" }
					: { status: "completed" as const, content: `draft ${++draftRuns}` },
			]))),
			getSubagent: vi.fn(),
			cancelSubagent: vi.fn(),
			cancelAll: vi.fn(),
			onEvent: vi.fn(() => () => {}),
		};
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "draft", task: "draft", role: "planner" },
				{ id: "review", task: "review", role: "reviewer", after: ["draft"], reviews: ["draft"] },
			],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});
		const events: string[] = [];
		let terminal: { type: "GraphCompleted"; failedNodes: string[]; unreachedNodes: string[] } | undefined;
		engine.onEvent((event) => {
			events.push(event.type);
			if (event.type === "GraphCompleted") terminal = event as typeof terminal;
		});

		const results = await engine.execute();

		// review 决策未知 → 不回退 draft（不会跑第 2 轮）
		expect(draftRuns).toBe(1);

		// review 节点本身执行成功，结果被保留
		expect(results.get("review")?.status).toBe("completed");
		expect(results.get("review")?.content).toBe("the draft looks fine overall, no blockers");

		// 图正常结束（而非撞 maxSteps 或被取消）
		expect(events.at(-1)).toBe("GraphCompleted");
		expect(terminal?.failedNodes).not.toContain("review");
	});

	it("still treats explicit JSON {\"decision\":\"revise\"} as revise and routes back", async () => {
		// 回归保护：合法的 revise 决策仍要正常回退，确保上述修复没有误伤正常路径。
		let draftRuns = 0;
		let reviewRuns = 0;
		const orchestrator: WorkflowOrchestrator = {
			createSubagent: vi.fn((config) => `${config.role}-${config.task}-${Math.random()}`),
			waitForSubagents: vi.fn(async (ids) => new Map(ids.map((id) => [
				id,
				id.includes("review")
					? { status: "completed" as const, content: ++reviewRuns === 1 ? '{"decision":"revise"}' : '{"decision":"approve"}' }
					: { status: "completed" as const, content: `draft ${++draftRuns}` },
			]))),
			getSubagent: vi.fn(),
			cancelSubagent: vi.fn(),
			cancelAll: vi.fn(),
			onEvent: vi.fn(() => () => {}),
		};
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "draft", task: "draft", role: "planner" },
				{ id: "review", task: "review", role: "reviewer", after: ["draft"], reviews: ["draft"] },
			],
		});
		const engine = createDynamicGraphEngine({
			definition: { initialNodes: [], compiledGraph: graph },
			orchestrator,
			availableTools: [],
		});

		await engine.execute();

		expect(reviewRuns).toBe(2);
		expect(draftRuns).toBe(2);
	});
});
