import type { SubagentResult } from "./types";
import type { DynamicNodeId, GraphComputationContext } from "./dynamicGraphTypes";
import type { DataFlowManager } from "./dataFlowManager";

/**
 * 循环退出条件
 */
export type CycleExitCondition = {
	/** 条件类型 */
	type: "expression" | "no-progress" | "cost-limit" | "time-limit";
	/** 条件值（取决于类型） */
	value?: any;
	/** 人类可读的描述 */
	description?: string;
	/** 优先级 */
	priority?: "high" | "medium" | "low";
};

/**
 * 循环退出策略配置
 */
export type CycleExitConfig = {
	/** 硬上限（必选）：绝对最大迭代次数 */
	hardLimit: number;

	/** 主要退出条件（可选）：满足任一即退出 */
	breakWhen?: CycleExitCondition[];

	/** 自适应检测（可选） */
	adaptive?: {
		/** 是否检测无进展 */
		detectNoProgress: boolean;
		/** 进展检测窗口（最近 N 轮） */
		progressWindow: number;
		/** 相似度阈值（0-1，超过此值认为无进展） */
		similarityThreshold?: number;
		/** Token 预算限制 */
		costBudget?: number;
	};

	/** 用户交互（可选） */
	interactive?: {
		/** 第 N 轮后开始询问用户 */
		askAfterRound: number;
		/** 是否显示进度摘要 */
		showProgressSummary: boolean;
	};
};

/**
 * 循环边定义
 */
export type CycleEdge = {
	/** 循环边唯一标识 */
	id: string;
	/** 起点节点 */
	from: DynamicNodeId;
	/** 终点节点（重新执行的节点） */
	to: DynamicNodeId;
	/** 退出策略 */
	exit: CycleExitConfig;
};

/**
 * 循环状态（运行时）
 */
export type CycleState = {
	/** 循环边配置 */
	edge: CycleEdge;
	/** 当前迭代次数 */
	currentIteration: number;
	/** 历史记录 */
	history: Array<{
		iteration: number;
		fromNodeResult: SubagentResult;
		toNodeResult?: SubagentResult;
		timestamp: Date;
		tokenCount?: number;
	}>;
	/** 累计 token 数 */
	totalTokens: number;
	/** 开始时间 */
	startedAt: Date;
};

/**
 * 循环决策结果
 */
export type CycleDecision = {
	/** 是否继续循环 */
	continue: boolean;
	/** 决策理由 */
	reason: string;
	/** 严重程度 */
	severity: "success" | "info" | "warning" | "error";
	/** 触发的条件（如果有） */
	triggeredCondition?: CycleExitCondition;
};

/**
 * 循环管理器 - 管理动态循环的执行和退出决策
 */
export class CycleManager {
	private cycles = new Map<string, CycleState>();
	private dataFlowManager: DataFlowManager;

	constructor(
		definition: CycleEdge[],
		dataFlowManager: DataFlowManager,
	) {
		this.dataFlowManager = dataFlowManager;

		for (const edge of definition) {
			this.cycles.set(edge.id, {
				edge,
				currentIteration: 0,
				history: [],
				totalTokens: 0,
				startedAt: new Date(),
			});
		}
	}

	/**
	 * 检查节点完成时是否触发循环边
	 */
	checkTrigger(
		nodeId: DynamicNodeId,
		result: SubagentResult,
		context: GraphComputationContext,
	): CycleEdge | null {
		for (const [cycleId, state] of this.cycles) {
			const edge = state.edge;

			// 检查是否是循环起点
			if (edge.from !== nodeId) continue;

			// 检查是否应该继续（同步决策）
			const decision = this.shouldContinueSync(cycleId, context);
			if (!decision.continue) {
				console.log(`[CycleManager] ${cycleId} 不触发: ${decision.reason}`);
				return null;
			}

			// 记录本轮历史
			state.currentIteration++;
			state.history.push({
				iteration: state.currentIteration,
				fromNodeResult: result,
				timestamp: new Date(),
				tokenCount: result.toolCallCount, // 暂用 toolCallCount 作为 token 估算
			});

			// 更新总 token 数
			if (result.toolCallCount) {
				state.totalTokens += result.toolCallCount * 1000; // 粗略估算
			}

			console.log(
				`[CycleManager] ${cycleId} 触发第 ${state.currentIteration} 轮，从 ${edge.from} 回到 ${edge.to}`,
			);

			return edge;
		}

		return null;
	}

	/**
	 * 同步判断是否应该继续循环（在触发前调用）
	 */
	private shouldContinueSync(
		cycleId: string,
		context: GraphComputationContext,
	): CycleDecision {
		const state = this.cycles.get(cycleId);
		if (!state) {
			return {
				continue: false,
				reason: "循环状态不存在",
				severity: "error",
			};
		}

		const config = state.edge.exit;

		// 1. 硬上限检查
		if (state.currentIteration >= config.hardLimit) {
			return {
				continue: false,
				reason: `达到硬上限 ${config.hardLimit} 轮`,
				severity: "info",
			};
		}

		// 2. 主要退出条件检查
		if (config.breakWhen) {
			for (const condition of config.breakWhen) {
				const decision = this.evaluateCondition(condition, state, context);
				if (decision && !decision.continue) {
					return decision;
				}
			}
		}

		// 3. 自适应检测 - 无进展
		if (config.adaptive?.detectNoProgress && state.history.length >= 2) {
			const hasProgress = this.detectProgress(state, config.adaptive);
			if (!hasProgress) {
				return {
					continue: false,
					reason: `连续 ${config.adaptive.progressWindow} 轮无明显进展`,
					severity: "warning",
				};
			}
		}

		// 4. 成本检查
		if (config.adaptive?.costBudget) {
			if (state.totalTokens > config.adaptive.costBudget) {
				return {
					continue: false,
					reason: `超出 token 预算 (${state.totalTokens}/${config.adaptive.costBudget})`,
					severity: "warning",
				};
			}
		}

		return { continue: true, reason: "继续优化", severity: "info" };
	}

	/**
	 * 评估单个退出条件
	 */
	private evaluateCondition(
		condition: CycleExitCondition,
		state: CycleState,
		context: GraphComputationContext,
	): CycleDecision | null {
		switch (condition.type) {
			case "expression": {
				if (typeof condition.value !== "string") return null;

				try {
					// 表达式上下文只支持节点引用（nodeId.content/status/error）、globalData（$key）
					// 与字面量/比较/逻辑运算。注意：不要在此注入 cycleState —— DataFlowManager 的
					// ExpressionContext 不识别它，任何引用 cycleState 的表达式都会抛 Unsupported
					// expression 错误并落入下面的 catch，导致该 breakWhen 条件静默失效。如需基于轮数
					// 或成本退出，改用 cost-limit / time-limit 条件类型。
					const nodes = new Map<DynamicNodeId, SubagentResult>();
					for (const [id, node] of context.nodes) {
						if (node.result) nodes.set(id, node.result);
					}
					const expressionContext = { nodes, globalData: context.globalData };

					const result = this.dataFlowManager.evaluateExpression(
						condition.value,
						expressionContext,
					);
					if (result) {
						return {
							continue: false,
							reason: condition.description ?? "退出条件满足",
							severity:
								condition.priority === "high"
									? "success"
									: condition.priority === "medium"
										? "info"
										: "info",
							triggeredCondition: condition,
						};
					}
				} catch (error) {
					// 表达式不支持时会走到这里（例如引用了未声明的节点或不支持的语法）。
					// 显式提示可行的替代方案，避免该退出条件被静默吞掉。
					console.error(
						`[CycleManager] 评估 breakWhen 表达式失败，该条件将不生效: "${condition.value}"。` +
							`表达式仅支持节点引用（如 someNode.content.includes('APPROVED')）、$globalKey、字面量与比较/逻辑运算；` +
							`如需按成本/时间退出，请改用 cost-limit / time-limit 条件类型。`,
						error,
					);
				}
				break;
			}

			case "cost-limit": {
				if (typeof condition.value === "number") {
					if (state.totalTokens > condition.value) {
						return {
							continue: false,
							reason:
								condition.description ??
								`超出成本限制 (${state.totalTokens}/${condition.value})`,
							severity: "warning",
							triggeredCondition: condition,
						};
					}
				}
				break;
			}

			case "time-limit": {
				if (typeof condition.value === "number") {
					const elapsed = Date.now() - state.startedAt.getTime();
					if (elapsed > condition.value) {
						return {
							continue: false,
							reason:
								condition.description ??
								`超出时间限制 (${Math.floor(elapsed / 1000)}s)`,
							severity: "warning",
							triggeredCondition: condition,
						};
					}
				}
				break;
			}
		}

		return null;
	}

	/**
	 * 检测是否有进展（比较最近几轮的输出相似度）
	 */
	private detectProgress(
		state: CycleState,
		config: NonNullable<CycleExitConfig["adaptive"]>,
	): boolean {
		const window = config.progressWindow ?? 2;
		const threshold = config.similarityThreshold ?? 0.9;

		if (state.history.length < window + 1) return true; // 样本不足，认为有进展

		const recent = state.history.slice(-window);
		const previous = state.history.slice(-window - 1, -1);

		// 计算输出内容的相似度
		const recentContents = recent
			.map((h) => h.toNodeResult?.content ?? "")
			.join("\n");
		const previousContents = previous
			.map((h) => h.toNodeResult?.content ?? "")
			.join("\n");

		const similarity = this.calculateSimilarity(
			recentContents,
			previousContents,
		);

		console.log(
			`[CycleManager] 进展检测: 相似度 ${(similarity * 100).toFixed(1)}%, 阈值 ${(threshold * 100).toFixed(1)}%`,
		);

		return similarity < threshold;
	}

	/**
	 * 计算两个字符串的相似度（简单实现：Jaccard 相似度）
	 */
	private calculateSimilarity(a: string, b: string): number {
		if (a === b) return 1.0;
		if (!a || !b) return 0.0;

		// 分词（简单按空格和标点分割）
		const tokensA = new Set(a.toLowerCase().split(/[\s,.;:!?]+/));
		const tokensB = new Set(b.toLowerCase().split(/[\s,.;:!?]+/));

		// Jaccard 相似度: 交集大小 / 并集大小
		const intersection = new Set(
			[...tokensA].filter((token) => tokensB.has(token)),
		);
		const union = new Set([...tokensA, ...tokensB]);

		return union.size > 0 ? intersection.size / union.size : 0;
	}

	/**
	 * 更新目标节点的结果（用于历史记录）
	 */
	updateToNodeResult(cycleId: string, result: SubagentResult): void {
		const state = this.cycles.get(cycleId);
		if (!state || state.history.length === 0) return;

		const lastEntry = state.history[state.history.length - 1];
		lastEntry.toNodeResult = result;
	}

	/**
	 * 获取当前迭代次数
	 */
	getCurrentIteration(cycleId: string): number {
		return this.cycles.get(cycleId)?.currentIteration ?? 0;
	}

	/**
	 * 获取循环状态快照
	 */
	getState(cycleId: string): Readonly<CycleState> | undefined {
		return this.cycles.get(cycleId);
	}

	/**
	 * 获取所有循环的统计信息
	 */
	getStatistics(): Map<
		string,
		{
			totalIterations: number;
			totalTokens: number;
			duration: number;
			averageIterationTime: number;
		}
	> {
		const stats = new Map();

		for (const [cycleId, state] of this.cycles) {
			const duration = Date.now() - state.startedAt.getTime();
			const avgIterationTime =
				state.currentIteration > 0
					? duration / state.currentIteration
					: 0;

			stats.set(cycleId, {
				totalIterations: state.currentIteration,
				totalTokens: state.totalTokens,
				duration,
				averageIterationTime: avgIterationTime,
			});
		}

		return stats;
	}
}
