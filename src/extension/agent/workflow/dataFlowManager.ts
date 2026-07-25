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

		// Literal values
		if (trimmed === "null") return null;
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
		if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
			return trimmed.slice(1, -1);
		}

		// Node reference: nodeId.field
		const nodeRefMatch = trimmed.match(/^(\w+)\.(\w+)$/);
		if (nodeRefMatch) {
			const [, nodeId, field] = nodeRefMatch;
			const nodeResult = context.nodes.get(nodeId);
			if (!nodeResult) return null;

			if (field === "content") return nodeResult.content ?? null;
			if (field === "status") return nodeResult.status;
			if (field === "error") return nodeResult.error ?? null;
			return null;
		}

		// Global data reference: $variableName
		if (trimmed.startsWith("$")) {
			const varName = trimmed.slice(1);
			return context.globalData.get(varName) ?? null;
		}

		// Array access: nodeId.field[index]
		const arrayAccessMatch = trimmed.match(/^(\w+)\.(\w+)\[(\d+)\]$/);
		if (arrayAccessMatch) {
			const [, nodeId, field, indexStr] = arrayAccessMatch;
			const nodeResult = context.nodes.get(nodeId);
			if (!nodeResult) return null;

			const value = field === "content" ? nodeResult.content : null;
			if (Array.isArray(value)) {
				const index = parseInt(indexStr, 10);
				return value[index] ?? null;
			}
			return null;
		}

		// JSON path: nodeId.content.nested.field
		const jsonPathMatch = trimmed.match(/^(\w+)\.content\.(.+)$/);
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

		return null;
	}

	function getNestedValue(obj: any, path: string[]): DataFlowValue {
		let current = obj;
		for (const key of path) {
			if (current === null || current === undefined) return null;
			if (typeof current !== "object") return null;
			current = current[key];
		}
		return current;
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
