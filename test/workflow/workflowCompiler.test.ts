import { describe, expect, it } from "vitest";
import { compileGeneratedWorkflow } from "../../src/extension/agent/workflow/workflowCompiler";

describe("compileGeneratedWorkflow", () => {
	it("compiles review semantics into approve and revise routes", () => {
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "draft", task: "draft" },
				{ id: "review", task: "review", after: ["draft"], reviews: ["draft"] },
			],
		});

		expect(graph.routes).toEqual(expect.arrayContaining([
			expect.objectContaining({ from: "draft", to: "review", type: "dependency" }),
			expect.objectContaining({ from: "review", to: "draft", type: "review", when: "revise" }),
			expect.objectContaining({ from: "review", to: "__end__", type: "review", when: "approve" }),
		]));
	});

	it("routes approval to a dependent node when one exists", () => {
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "draft", task: "draft" },
				{ id: "review", task: "review", after: ["draft"], reviews: ["draft"] },
				{ id: "publish", task: "publish", after: ["review"] },
			],
		});

		expect(graph.routes).toEqual(expect.arrayContaining([
			expect.objectContaining({ from: "review", to: "publish", type: "review", when: "approve" }),
		]));
	});

	it.each([
		["unknown after", { nodes: [{ id: "a", task: "a", after: ["missing"] }] }],
		["unknown context", { nodes: [{ id: "a", task: "a", contextFrom: ["missing"] }] }],
		["unknown review", { nodes: [{ id: "a", task: "a", reviews: ["missing"] }] }],
		["multiple review targets", { nodes: [{ id: "a", task: "a", reviews: ["b", "c"] }, { id: "b", task: "b" }, { id: "c", task: "c" }] }],
	] as const)("rejects %s with a field path", (_name, plan) => {
		expect(() => compileGeneratedWorkflow(plan)).toThrow(/nodes\[/);
	});

	it("does not mutate the plan and emits stable channels and limits", () => {
		const plan = { nodes: [{ id: "a", task: "a" }], maxSteps: 7 };
		const before = JSON.stringify(plan);
		const graph = compileGeneratedWorkflow(plan);

		expect(JSON.stringify(plan)).toBe(before);
		expect(graph.channels).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "outputs.a", mode: "single", producer: "a" }),
		]));
		expect(graph.limits.maxSteps).toBe(7);
		expect(graph.expansionRules).toEqual([]);
	});
});
