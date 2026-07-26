import type { SubagentResult, SubagentRoleId } from "./types";
import type { DataFlowValue } from "./dataFlowManager";

export type DynamicNodeId = string;

export type NodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export type DynamicNodeConfig = {
	id: DynamicNodeId;
	task: string;
	role?: SubagentRoleId;
	toolHints?: string[];
	timeoutMs?: number;
	inputMapping?: Record<string, string>;
	condition?: NodeCondition;
	dependsOn?: DynamicNodeId[];
	/** On completion, writes this node's result.content into globalData under this key, making it readable via "$key" expressions. */
	exportTo?: string;
	retry?: { maxAttempts: number; backoffMs?: number };
};

export type NodeCondition = {
	type: "always" | "onSuccess" | "onFailure" | "custom";
	expression?: string;
};

export type DynamicNode = {
	config: DynamicNodeConfig;
	status: NodeStatus;
	dependencies: Set<DynamicNodeId>;
	dependents: Set<DynamicNodeId>;
	result?: SubagentResult;
	context?: Record<string, unknown>;
	subagentId?: string;
	startedAt?: Date;
	finishedAt?: Date;
	attempts?: number;
};

export type GraphComputationContext = {
	nodes: Map<DynamicNodeId, DynamicNode>;
	globalData: Map<string, DataFlowValue>;
	executionOrder: DynamicNodeId[];
};

export type DependencyResolver = (
	nodeId: DynamicNodeId,
	completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>,
	context: GraphComputationContext,
) => Promise<DynamicNodeConfig[]>;

export type DynamicGraphDefinition = {
	initialNodes: DynamicNodeConfig[];
	resolvers?: Map<DynamicNodeId, DependencyResolver>;
	maxNodes?: number;
	maxDepth?: number;
	initialGlobalData?: Record<string, DataFlowValue>;
};

export type GraphExecutionEvent =
	| { type: "NodeAdded"; nodeId: DynamicNodeId; config: DynamicNodeConfig }
	| { type: "NodeStatusChanged"; nodeId: DynamicNodeId; status: NodeStatus }
	| { type: "NodeCompleted"; nodeId: DynamicNodeId; result: SubagentResult }
	| { type: "DependenciesResolved"; nodeId: DynamicNodeId; newNodes: DynamicNodeConfig[] }
	| { type: "ResolverFailed"; nodeId: DynamicNodeId; error: string }
	| {
			type: "GraphCompleted";
			finalNodes: ReadonlyMap<DynamicNodeId, SubagentResult>;
			failedNodes: DynamicNodeId[];
			unreachedNodes: DynamicNodeId[];
	  }
	| { type: "GraphCancelled"; finalNodes: ReadonlyMap<DynamicNodeId, SubagentResult> };

export type GraphExecutionListener = (event: GraphExecutionEvent) => void;
