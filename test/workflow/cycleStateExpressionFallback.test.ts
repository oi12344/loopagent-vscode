import { describe, expect, it, vi } from "vitest";
import { CycleManager } from "../../src/extension/agent/workflow/cycleManager";
import { createDataFlowManager } from "../../src/extension/agent/workflow/dataFlowManager";
import type { CycleEdge } from "../../src/extension/agent/workflow/cycleManager";
import type { GraphComputationContext, DynamicNode } from "../../src/extension/agent/workflow/dynamicGraphTypes";
import type { SubagentResult } from "../../src/extension/agent/workflow/types";

/**
 * 验证修复：breakWhen 表达式若引用了 cycleState（ExpressionContext 不支持的字段），
 * 应优雅失败并记录原因，而不应抛错崩溃，也不应静默"触发"导致循环异常退出。
 * 修复后表达式上下文不再注入 cycleState，这类表达式走 Unsupported -> catch 兜底。
 */
describe("CycleManager breakWhen expression with unsupported cycleState reference", () => {
	function buildContext(nodeResults: Record<string, SubagentResult>): GraphComputationContext {
		const nodes = new Map<string, DynamicNode>();
		for (const [id, result] of Object.entries(nodeResults)) {
			nodes.set(id, {
				config: { id, task: id },
				status: "completed",
				dependencies: new Set(),
				dependents: new Set(),
				result,
			});
		}
		return { nodes, globalData: new Map(), executionOrder: Object.keys(nodeResults) };
	}

	it("an expression referencing cycleState fails gracefully and does not stop the cycle", () => {
		const dataFlowManager = createDataFlowManager();
		const edge: CycleEdge = {
			id: "loop-1",
			from: "fix",
			to: "review",
			exit: {
				hardLimit: 5,
				breakWhen: [
					{
						type: "expression",
						// 故意引用 cycleState.iteration —— ExpressionContext 不识别，应被 catch 吞掉
						value: "cycleState.iteration >= 2",
						description: "达到指定轮数退出",
						priority: "high",
					},
				],
			},
		};
		const manager = new CycleManager([edge], dataFlowManager);
		const ctx = buildContext({
			review: { status: "completed", content: "发现问题", toolCallCount: 1 },
			fix: { status: "completed", content: "已修复", toolCallCount: 1 },
		});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const triggered = manager.checkTrigger("fix", ctx.nodes.get("fix")!.result!, ctx);

		// 关键断言：含 cycleState 的表达式不会"触发"退出（decision.continue 仍为 true），
		// 循环照常推进 —— 即该条件优雅失败而非静默生效或抛错崩溃。
		expect(triggered).not.toBeNull();
		expect(triggered?.id).toBe("loop-1");
		expect(manager.getCurrentIteration("loop-1")).toBe(1);

		// 且失败被显式记录（改进后的日志），便于排查
		expect(errorSpy).toHaveBeenCalled();
		const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("cycleState.iteration >= 2");
		expect(logged).toContain("cost-limit"); // 提示替代方案
		errorSpy.mockRestore();
	});

	it("a normal node-reference expression still works and stops the cycle", () => {
		// 回归保护：纯节点引用表达式（修复未触碰的路径）仍正常触发退出。
		const dataFlowManager = createDataFlowManager();
		const edge: CycleEdge = {
			id: "loop-2",
			from: "fix",
			to: "review",
			exit: {
				hardLimit: 5,
				breakWhen: [
					{
						type: "expression",
						value: "review.content === 'APPROVED'",
						description: "审查通过",
						priority: "high",
					},
				],
			},
		};
		const manager = new CycleManager([edge], dataFlowManager);
		const ctx = buildContext({
			review: { status: "completed", content: "APPROVED", toolCallCount: 1 },
			fix: { status: "completed", content: "已修复", toolCallCount: 1 },
		});

		const triggered = manager.checkTrigger("fix", ctx.nodes.get("fix")!.result!, ctx);

		// 退出条件满足 → 循环不再触发
		expect(triggered).toBeNull();
		expect(manager.getCurrentIteration("loop-2")).toBe(0);
	});
});
