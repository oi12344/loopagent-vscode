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

	function evaluateExpression(expression: string, context: ExpressionContext): DataFlowValue {
		const trimmed = expression.trim();
		if (!trimmed) throw new Error(`Unsupported expression: ${expression}`);
		const comparison = findStrictComparison(trimmed);
		if (comparison) {
			const left = evaluateExpression(trimmed.slice(0, comparison.index), context);
			const right = evaluateExpression(trimmed.slice(comparison.index + comparison.operator.length), context);
			return comparison.operator === "===" ? left === right : left !== right;
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

	function findStrictComparison(expression: string): { index: number; operator: "===" | "!==" } | null {
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
			const operator = expression.slice(index, index + 3);
			if (operator === "===" || operator === "!==") return { index, operator };
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
