import type { SubagentResult } from "./types";
import type { DynamicNodeId } from "./dynamicGraphTypes";

export type DataFlowValue = string | number | boolean | null | object | unknown[];

export type DataFlowRecord = {
	nodeId: DynamicNodeId;
	timestamp: Date;
	data: Record<string, DataFlowValue>;
	source: "input" | "output" | "intermediate";
};

export type ExpressionContext = {
	nodes: ReadonlyMap<DynamicNodeId, SubagentResult>;
	globalData: ReadonlyMap<string, DataFlowValue>;
	currentNode?: DynamicNodeId;
};

type ComparisonOperator = "===" | "!==" | ">=" | "<=" | ">" | "<";

// 长度降序：三字符的 === / !== 必须先于 >= / <=，两字符的 >= / <= 必须先于 > / <。
const COMPARISON_OPERATORS: readonly ComparisonOperator[] = ["===", "!==", ">=", "<=", ">", "<"];

// runDynamicGraph 工具描述的 "NOT supported" 清单中，会被 JSON path 正则误吞的 JS 成员名。
const UNSUPPORTED_MEMBERS: ReadonlySet<string> = new Set([
	"length", "match", "trim", "split", "toLowerCase", "toUpperCase",
	"startsWith", "endsWith", "replace", "slice", "indexOf", "test",
]);

export type DataFlowManager = {
	recordInput(nodeId: DynamicNodeId, data: Record<string, DataFlowValue>): void;
	recordOutput(nodeId: DynamicNodeId, result: SubagentResult): void;
	recordIntermediate(nodeId: DynamicNodeId, data: Record<string, DataFlowValue>): void;
	getNodeData(nodeId: DynamicNodeId): DataFlowRecord[];
	evaluateExpression(expression: string, context: ExpressionContext): DataFlowValue;
	mapInputs(mapping: Record<string, string>, context: ExpressionContext): Record<string, DataFlowValue>;
	getFlowHistory(): ReadonlyArray<DataFlowRecord>;
	clear(): void;
};

export function createDataFlowManager(): DataFlowManager {
	const flowHistory: DataFlowRecord[] = [];
	const nodeDataIndex = new Map<DynamicNodeId, DataFlowRecord[]>();

	function record(nodeId: DynamicNodeId, data: Record<string, DataFlowValue>, source: "input" | "output" | "intermediate"): void {
		const record: DataFlowRecord = {
			nodeId,
			timestamp: new Date(),
			data: structuredClone(data),
			source,
		};

		flowHistory.push(record);

		if (!nodeDataIndex.has(nodeId)) {
			nodeDataIndex.set(nodeId, []);
		}
		nodeDataIndex.get(nodeId)!.push(record);
	}

	// 递归下降求值，优先级从低到高：&& -> 比较 -> 一元 ! -> .includes() -> 基础项。
	// 这里支持的形式必须与 runDynamicGraph 工具描述的 EXPRESSION LANGUAGE 段逐条对应：
	// 描述里出现但此处不支持的形式，会让模型写出永远静默失效的 breakWhen / condition。
	function evaluateExpression(expression: string, context: ExpressionContext): DataFlowValue {
		const trimmed = expression.trim();
		if (!trimmed) throw new Error(`Unsupported expression: ${expression}`);

		// 逻辑与，短路求值。右侧不合法时左侧为假就不会被求值，与 JS 一致。
		const and = findTopLevelOperator(trimmed, ["&&"]);
		if (and) {
			if (!isTruthy(evaluateExpression(trimmed.slice(0, and.index), context))) return false;
			return isTruthy(evaluateExpression(trimmed.slice(and.index + and.operator.length), context));
		}

		const comparison = findTopLevelOperator(trimmed, COMPARISON_OPERATORS);
		if (comparison) {
			const left = evaluateExpression(trimmed.slice(0, comparison.index), context);
			const right = evaluateExpression(trimmed.slice(comparison.index + comparison.operator.length), context);
			return compareValues(left, right, comparison.operator);
		}

		// 一元取反。比较运算已在上一层切分，因此走到这里的开头 "!" 一定是取反而非 "!==" 的残片。
		if (trimmed.startsWith("!")) {
			return !isTruthy(evaluateExpression(trimmed.slice(1), context));
		}

		// 子串测试。必须早于下方的 JSON path 分支：JSON path 的正则会把 "includes('x')"
		// 当成 content 下的嵌套路径吞掉，JSON.parse 失败后静默返回 null，条件永不触发。
		const includesMatch = trimmed.match(/^(.+?)\.includes\(\s*(['"])([\s\S]*)\2\s*\)$/);
		if (includesMatch) {
			const [, target, , needle] = includesMatch;
			const value = evaluateExpression(target, context);
			// 节点不存在或无输出时视为“不包含”，不抛错——缺输出本身就是合法的中间状态。
			if (value === null || value === undefined) return false;
			return String(value).includes(needle);
		}

		// Literal values
		if (trimmed === "null") return null;
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
		if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
			return trimmed.slice(1, -1);
		}

		// Node reference: nodeId.field or nodeId.field[index]
		const nodeRefMatch = trimmed.match(/^([A-Za-z0-9_-]+)\.(content|status|error)(?:\[(\d+)\])?$/);
		if (nodeRefMatch) {
			const [, nodeId, field, indexStr] = nodeRefMatch;
			const nodeResult = context.nodes.get(nodeId);
			if (!nodeResult) return null;

			const value = field === "content" ? nodeResult.content : field === "status" ? nodeResult.status : nodeResult.error;
			if (indexStr !== undefined) return Array.isArray(value) ? value[Number(indexStr)] ?? null : null;
			return value ?? null;
		}

		// Global data reference: $variableName
		const globalRefMatch = trimmed.match(/^\$([A-Za-z0-9_.-]+)$/);
		if (globalRefMatch) {
			const [, varName] = globalRefMatch;
			return context.globalData.get(varName) ?? null;
		}

		// JSON path: nodeId.content.nested.field
		const jsonPathMatch = trimmed.match(/^([A-Za-z0-9_-]+)\.content\.(.+)$/);
		if (jsonPathMatch) {
			const [, nodeId, path] = jsonPathMatch;
			// 工具描述把这些 JS 成员明确列为不支持。它们作为 JSON 字段名极罕见，作为模型笔误
			// 却很常见，所以宁可抛错给出指引，也不要沿 JSON path 静默返回 null —— 后者会让
			// 条件永远为假且不留任何诊断痕迹。
			const lastSegment = path.split(".").pop() ?? "";
			if (UNSUPPORTED_MEMBERS.has(lastSegment.replace(/\(.*\)$/, ""))) {
				throw new Error(
					`Unsupported expression: ${expression}. `
					+ `".${lastSegment}" is not available; use <nodeId>.content.includes('text') for substring tests `
					+ `or compare <nodeId>.content directly.`,
				);
			}
			const nodeResult = context.nodes.get(nodeId);
			if (!nodeResult?.content) return null;

			try {
				const content = typeof nodeResult.content === "string" ? JSON.parse(nodeResult.content) : nodeResult.content;
				return getNestedValue(content, path.split("."));
			} catch {
				return null;
			}
		}

		throw new Error(`Unsupported expression: ${expression}`);
	}

	// 扫描顶层（引号外）的第一个操作符。candidates 必须按长度降序排列，否则 ">" 会先匹配到
	// ">=" 的第一个字符，把 "a >= 5" 切成 "a" 和 "= 5"。
	function findTopLevelOperator<T extends string>(expression: string, candidates: readonly T[]): { index: number; operator: T } | null {
		let quote: string | undefined;
		for (let index = 0; index < expression.length; index += 1) {
			const char = expression[index];
			if (quote) {
				if (char === "\\") index += 1;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}
			for (const operator of candidates) {
				if (!expression.startsWith(operator, index)) continue;
				// "!" 开头的取反不能被误认成 "!==" 的一部分：只有紧跟 "==" 才是比较操作符。
				if (operator === "!==" && expression.slice(index, index + 3) !== "!==") continue;
				return { index, operator };
			}
		}
		return null;
	}

	function isTruthy(value: DataFlowValue): boolean {
		return Boolean(value);
	}

	// === / !== 保持严格比较；数值比较先转数字，无法转换时返回 false 而不抛错，
	// 避免一个写坏的阈值条件把整张图打挂。
	function compareValues(left: DataFlowValue, right: DataFlowValue, operator: ComparisonOperator): boolean {
		if (operator === "===") return left === right;
		if (operator === "!==") return left !== right;

		const leftNumber = toNumber(left);
		const rightNumber = toNumber(right);
		if (leftNumber === null || rightNumber === null) return false;

		switch (operator) {
			case ">=": return leftNumber >= rightNumber;
			case "<=": return leftNumber <= rightNumber;
			case ">": return leftNumber > rightNumber;
			case "<": return leftNumber < rightNumber;
		}
	}

	function toNumber(value: DataFlowValue): number | null {
		if (typeof value === "number") return Number.isFinite(value) ? value : null;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) return null;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	function getNestedValue(obj: any, path: string[]): DataFlowValue {
		let current = obj;
		for (const key of path) {
			if (current === null || current === undefined) return null;
			if (typeof current !== "object") return null;
			const arrayAccessMatch = key.match(/^(.+)\[(\d+)\]$/);
			current = arrayAccessMatch ? current[arrayAccessMatch[1]]?.[Number(arrayAccessMatch[2])] : current[key];
		}
		return current ?? null;
	}

	function mapInputs(mapping: Record<string, string>, context: ExpressionContext): Record<string, DataFlowValue> {
		const result: Record<string, DataFlowValue> = {};

		for (const [targetKey, sourceExpr] of Object.entries(mapping)) {
			result[targetKey] = evaluateExpression(sourceExpr, context);
		}

		return result;
	}

	return {
		recordInput(nodeId, data) {
			record(nodeId, data, "input");
		},

		recordOutput(nodeId, result) {
			const data: Record<string, DataFlowValue> = {
				status: result.status,
			};

			if (result.content !== undefined) {
				data.content = result.content;
			}

			if (result.error !== undefined) {
				data.error = result.error;
			}

			if (result.toolCallCount !== undefined) {
				data.toolCallCount = result.toolCallCount;
			}

			record(nodeId, data, "output");
		},

		recordIntermediate(nodeId, data) {
			record(nodeId, data, "intermediate");
		},

		getNodeData(nodeId) {
			return nodeDataIndex.get(nodeId) ?? [];
		},

		evaluateExpression,
		mapInputs,

		getFlowHistory() {
			return Object.freeze([...flowHistory]);
		},

		clear() {
			flowHistory.length = 0;
			nodeDataIndex.clear();
		},
	};
}
