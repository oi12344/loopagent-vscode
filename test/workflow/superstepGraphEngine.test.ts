import { describe, expect, it, vi } from "vitest";
import { compileGeneratedWorkflow } from "../../src/extension/agent/workflow/workflowCompiler";
import { createDynamicGraphEngine } from "../../src/extension/agent/workflow/dynamicGraphEngine";
import type { WorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";

describe("state-driven dynamic graph execution", () => {
	it("routes revise back to the reviewed node and stops on approve", async () => {
		let draftRuns = 0;
		let reviewRuns = 0;
		const orchestrator: WorkflowOrchestrator = {
			createSubagent: vi.fn((config) => {
				const id = `${config.role}-${config.task}-${Math.random()}`;
				return id;
			}),
			waitForSubagents: vi.fn(async (ids) => new Map(ids.map((id) => [id, {
				status: "completed" as const,
				content: id.includes("review") ? (++reviewRuns > 1 ? '{"decision":"approve"}' : '{"decision":"revise"}') : (++draftRuns === 1 ? "draft one" : "draft two"),
			}]))),
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
		engine.onEvent((event) => events.push(event.type));

		const results = await engine.execute();

		expect(draftRuns).toBe(2);
		expect(reviewRuns).toBe(2);
		expect(results.get("draft")?.content).toBe("draft two");
		expect(events.filter((type) => type === "StepStarted")).toHaveLength(4);
		expect(events).toContain("StateCommitted");
		expect(events.at(-1)).toBe("GraphCompleted");
	});
});
