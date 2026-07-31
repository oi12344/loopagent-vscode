import { describe, it, expect, beforeEach } from "vitest";
import { CycleManager, type CycleEdge, type CycleExitConfig } from "../src/extension/agent/workflow/cycleManager";
import { createDataFlowManager } from "../src/extension/agent/workflow/dataFlowManager";
import type { GraphComputationContext, DynamicNode } from "../src/extension/agent/workflow/dynamicGraphTypes";
import type { SubagentResult } from "../src/extension/agent/workflow/types";

describe("CycleManager - 动态循环退出策略", () => {
	let dataFlowManager: ReturnType<typeof createDataFlowManager>;
	let context: GraphComputationContext;

	beforeEach(() => {
		dataFlowManager = createDataFlowManager();
		context = {
			nodes: new Map(),
			globalData: new Map(),
			executionOrder: [],
		};
	});

	describe("基础循环触发", () => {
		it("应该在起点节点完成时触发循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 3,
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			const result: SubagentResult = {
				status: "completed",
				content: "修复完成",
			};

			const triggered = manager.checkTrigger("fix", result, context);

			expect(triggered).not.toBeNull();
			expect(triggered?.id).toBe("test-cycle");
			expect(triggered?.to).toBe("review");
			expect(manager.getCurrentIteration("test-cycle")).toBe(1);
		});

		it("非起点节点不应触发循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: { hardLimit: 3 },
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);
			const result: SubagentResult = { status: "completed" };

			const triggered = manager.checkTrigger("other-node", result, context);

			expect(triggered).toBeNull();
		});
	});

	describe("硬上限检查", () => {
		it("达到硬上限时应停止循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: { hardLimit: 2 },
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);
			const result: SubagentResult = { status: "completed", content: "修复" };

			// 第 1 轮
			const trigger1 = manager.checkTrigger("fix", result, context);
			expect(trigger1).not.toBeNull();
			expect(manager.getCurrentIteration("test-cycle")).toBe(1);

			// 第 2 轮
			const trigger2 = manager.checkTrigger("fix", result, context);
			expect(trigger2).not.toBeNull();
			expect(manager.getCurrentIteration("test-cycle")).toBe(2);

			// 第 3 轮 - 应该被阻止
			const trigger3 = manager.checkTrigger("fix", result, context);
			expect(trigger3).toBeNull();
			expect(manager.getCurrentIteration("test-cycle")).toBe(2); // 仍然是 2
		});
	});

	describe("表达式退出条件", () => {
		it("当退出条件满足时应停止循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						breakWhen: [
							{
								type: "expression",
								value: "review.content.includes('APPROVED')",
								description: "审查通过",
								priority: "high",
							},
						],
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 添加 review 节点到 context
			const reviewNode: Partial<DynamicNode> = {
				result: {
					status: "completed",
					content: "发现 3 个问题",
				},
			};
			context.nodes.set("review", reviewNode as DynamicNode);

			// 第 1 轮 - 未通过
			const result1: SubagentResult = { status: "completed", content: "修复中" };
			const trigger1 = manager.checkTrigger("fix", result1, context);
			expect(trigger1).not.toBeNull();

			// 更新 review 结果为通过
			reviewNode.result = {
				status: "completed",
				content: "APPROVED: 所有问题已修复",
			};

			// 第 2 轮 - 应该被阻止（条件满足）
			const trigger2 = manager.checkTrigger("fix", result1, context);
			expect(trigger2).toBeNull();
		});
	});

	describe("无进展检测", () => {
		it.skip("连续相似输出应触发无进展检测", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						adaptive: {
							detectNoProgress: true,
							progressWindow: 2,
							similarityThreshold: 0.8,
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1 轮
			const result1: SubagentResult = {
				status: "completed",
				content: "修复了 SQL 注入问题",
			};
			manager.checkTrigger("fix", result1, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "发现 XSS 漏洞",
			});

			// 第 2 轮 - 输出几乎相同
			const result2: SubagentResult = {
				status: "completed",
				content: "修复了 SQL 注入问题", // 相同输出
			};
			manager.checkTrigger("fix", result2, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "发现 XSS 漏洞", // 相同输出
			});

			// 第 3 轮 - 应该被阻止（无进展）
			const result3: SubagentResult = {
				status: "completed",
				content: "修复了 SQL 注入问题",
			};
			const trigger3 = manager.checkTrigger("fix", result3, context);
			expect(trigger3).toBeNull();
		});

		it("不同输出应继续循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						adaptive: {
							detectNoProgress: true,
							progressWindow: 2,
							similarityThreshold: 0.8,
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1 轮
			const result1: SubagentResult = {
				status: "completed",
				content: "修复了 SQL 注入问题",
			};
			manager.checkTrigger("fix", result1, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "发现 XSS 漏洞",
			});

			// 第 2 轮 - 不同输出
			const result2: SubagentResult = {
				status: "completed",
				content: "修复了 XSS 漏洞和 CSRF 问题", // 不同
			};
			manager.checkTrigger("fix", result2, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "发现性能问题", // 不同
			});

			// 第 3 轮 - 应该继续
			const result3: SubagentResult = {
				status: "completed",
				content: "优化了数据库查询性能", // 不同
			};
			const trigger3 = manager.checkTrigger("fix", result3, context);
			expect(trigger3).not.toBeNull();
		});
	});

	describe("成本预算控制", () => {
		it.skip("超出 token 预算应停止循环", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						adaptive: {
							detectNoProgress: false,
							progressWindow: 2,
							costBudget: 5000, // 5000 tokens
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1 轮 - 2000 tokens
			const result1: SubagentResult = {
				status: "completed",
				content: "修复",
				toolCallCount: 2, // 模拟 2 次工具调用
			};
			const trigger1 = manager.checkTrigger("fix", result1, context);
			expect(trigger1).not.toBeNull();

			// 第 2 轮 - 累计 4000 tokens
			const result2: SubagentResult = {
				status: "completed",
				content: "修复",
				toolCallCount: 2,
			};
			const trigger2 = manager.checkTrigger("fix", result2, context);
			expect(trigger2).not.toBeNull();

			// 第 3 轮 - 将超出预算 (6000 tokens)
			const result3: SubagentResult = {
				status: "completed",
				content: "修复",
				toolCallCount: 2,
			};
			const trigger3 = manager.checkTrigger("fix", result3, context);
			expect(trigger3).toBeNull(); // 应该被阻止
		});
	});

	describe("多条件组合", () => {
		it("应该支持多个退出条件", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						breakWhen: [
							{
								type: "expression",
								value: "review.content.includes('APPROVED')",
								description: "审查通过",
								priority: "high",
							},
							{
								type: "expression",
								value: "review.content.includes('GOOD ENOUGH')",
								description: "质量可接受",
								priority: "medium",
							},
						],
						adaptive: {
							detectNoProgress: true,
							progressWindow: 2,
							costBudget: 50000,
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1-4 轮 - 都不满足退出条件
			for (let i = 1; i <= 4; i++) {
				const reviewNode: Partial<DynamicNode> = {
					result: {
						status: "completed",
						content: `第 ${i} 轮审查：发现问题`,
					},
				};
				context.nodes.set("review", reviewNode as DynamicNode);

				const result: SubagentResult = {
					status: "completed",
					content: `第 ${i} 轮修复`,
				};
				const triggered = manager.checkTrigger("fix", result, context);
				expect(triggered).not.toBeNull();
				manager.updateToNodeResult("test-cycle", {
					status: "completed",
					content: `第 ${i} 轮审查`,
				});
			}

			// 第 5 轮 - 满足 "GOOD ENOUGH" 条件
			const reviewNode5: Partial<DynamicNode> = {
				result: {
					status: "completed",
					content: "第 5 轮审查：GOOD ENOUGH",
				},
			};
			context.nodes.set("review", reviewNode5 as DynamicNode);

			const result5: SubagentResult = {
				status: "completed",
				content: "第 5 轮修复",
			};
			const trigger5 = manager.checkTrigger("fix", result5, context);
			expect(trigger5).toBeNull(); // 应该被 GOOD ENOUGH 条件阻止
		});
	});

	describe("统计信息", () => {
		it.skip("应该正确统计循环信息", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: { hardLimit: 5 },
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 运行 3 轮
			for (let i = 1; i <= 3; i++) {
				const result: SubagentResult = {
					status: "completed",
					content: `修复 ${i}`,
					toolCallCount: 2,
				};
				manager.checkTrigger("fix", result, context);
			}

			const stats = manager.getStatistics();
			const cycleStats = stats.get("test-cycle");

			expect(cycleStats).toBeDefined();
			expect(cycleStats?.totalIterations).toBe(3);
			expect(cycleStats?.totalTokens).toBe(6000); // 3 轮 * 2 工具调用 * 1000
			expect(cycleStats?.duration).toBeGreaterThan(0);
		});
	});

	describe("相似度计算", () => {
		it("相同字符串应返回 1.0", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						adaptive: {
							detectNoProgress: true,
							progressWindow: 1,
							similarityThreshold: 0.95,
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1 轮
			manager.checkTrigger("fix", { status: "completed", content: "test" }, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "same content",
			});

			// 第 2 轮 - 完全相同的内容
			manager.checkTrigger("fix", { status: "completed", content: "test" }, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "same content",
			});

			// 第 3 轮 - 应该被阻止（相似度 100%）
			const trigger3 = manager.checkTrigger(
				"fix",
				{ status: "completed", content: "test" },
				context,
			);
			expect(trigger3).toBeNull();
		});

		it("完全不同字符串应返回低相似度", () => {
			const cycles: CycleEdge[] = [
				{
					id: "test-cycle",
					from: "fix",
					to: "review",
					exit: {
						hardLimit: 10,
						adaptive: {
							detectNoProgress: true,
							progressWindow: 1,
							similarityThreshold: 0.3,
						},
					},
				},
			];

			const manager = new CycleManager(cycles, dataFlowManager);

			// 第 1 轮
			manager.checkTrigger("fix", { status: "completed" }, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "completely different text",
			});

			// 第 2 轮 - 完全不同的内容
			manager.checkTrigger("fix", { status: "completed" }, context);
			manager.updateToNodeResult("test-cycle", {
				status: "completed",
				content: "another unrelated content",
			});

			// 第 3 轮 - 应该继续（相似度低）
			const trigger3 = manager.checkTrigger("fix", { status: "completed" }, context);
			expect(trigger3).not.toBeNull();
		});
	});
});
