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

	it("gives every node a separate error channel so a failure cannot fake downstream input", () => {
		const graph = compileGeneratedWorkflow({ nodes: [{ id: "read", task: "read" }] });

		expect(graph.nodes[0]).toMatchObject({ outputChannel: "outputs.read", errorChannel: "errors.read" });
		// append 而非 single：失败节点会被恢复流程重跑，覆盖前几次证据就没法判断"同一个错误又来了"。
		expect(graph.channels).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "errors.read", mode: "append" }),
			expect.objectContaining({ name: "recovery", mode: "append" }),
		]));
	});

	it("restricts an executor node to reconciling instead of retrying", () => {
		const graph = compileGeneratedWorkflow({
			nodes: [
				{ id: "read", task: "read", role: "explorer" },
				{ id: "write", task: "write", role: "executor", after: ["read"] },
			],
		});
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));

		// 副作用能力由角色静态判定（只有 executor 拿到 applyEdit/runCommand），编译期就定下来。
		expect(byId.get("write")).toMatchObject({
			hasSideEffect: true,
			recoveryActions: ["reconcile_side_effect", "compensate", "request_input", "wait_external"],
		});
		expect(byId.get("read")?.hasSideEffect).toBe(false);
		expect(byId.get("read")?.recoveryActions).toContain("retry");
		// 只读节点拿不到对账和补偿：它不会留下副作用证据，对账一件没发生的写操作只是白烧预算。
		expect(byId.get("read")?.recoveryActions).not.toContain("reconcile_side_effect");
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
