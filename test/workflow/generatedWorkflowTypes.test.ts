import { describe, expect, it } from "vitest";
import { parseGeneratedWorkflowPlan } from "../../src/extension/agent/workflow/generatedWorkflowTypes";

describe("parseGeneratedWorkflowPlan", () => {
	it("accepts a semantic plan without cycles or expressions", () => {
		const plan = {
			nodes: [
				{ id: "draft", task: "write draft" },
				{ id: "review", task: "review draft", after: ["draft"], reviews: "draft" },
			],
		};

		expect(parseGeneratedWorkflowPlan(plan).nodes).toHaveLength(2);
		expect(parseGeneratedWorkflowPlan(plan).nodes[1].reviews).toEqual(["draft"]);
	});

	it.each([
		["duplicate node id", { nodes: [{ id: "a", task: "one" }, { id: "a", task: "two" }] }],
		["empty task", { nodes: [{ id: "a", task: "" }] }],
		["unknown field", { nodes: [{ id: "a", task: "one", expression: "x" }] }],
		["cycles", { nodes: [{ id: "a", task: "one" }], cycles: [] }],
		["invalid maxSteps", { nodes: [{ id: "a", task: "one" }], maxSteps: 0 }],
		["unsafe timeout", { nodes: [{ id: "a", task: "one", timeoutMs: Number.MAX_SAFE_INTEGER + 1 }] }],
		["invalid initialState", { nodes: [{ id: "a", task: "one" }], initialState: [] }],
		["non-record initialState", { nodes: [{ id: "a", task: "one" }], initialState: new Date() }],
	] as const)("rejects %s with a path", (_name, input) => {
		expect(() => parseGeneratedWorkflowPlan(input)).toThrow(/\b(plan|nodes)/);
	});

	it("normalizes string relationship fields to arrays", () => {
		const result = parseGeneratedWorkflowPlan({
			nodes: [{ id: "a", task: "one", after: "b", contextFrom: "c", reviews: "d" }],
			entry: "a",
		});
		expect(result.entry).toEqual(["a"]);
		expect(result.nodes[0].after).toEqual(["b"]);
		expect(result.nodes[0].contextFrom).toEqual(["c"]);
		expect(result.nodes[0].reviews).toEqual(["d"]);
	});

	it("preserves a positive timeout for semantic recovery", () => {
		const result = parseGeneratedWorkflowPlan({
			nodes: [{ id: "a", task: "one", timeoutMs: 60_000 }],
		});
		expect(result.nodes[0].timeoutMs).toBe(60_000);
	});

	it("preserves an exact output contract", () => {
		const result = parseGeneratedWorkflowPlan({
			nodes: [{ id: "a", task: "one", outputContract: { exactText: "OK" } }],
		});
		expect(result.nodes[0].outputContract).toEqual({ exactText: "OK" });
	});
});
