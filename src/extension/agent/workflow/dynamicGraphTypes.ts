import type { SubagentResult, SubagentRoleId } from "./types";

export type DynamicNodeId = string;

export type NodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped";

export type DynamicNodeConfig = {
	id: DynamicNodeId;
	task: string;
	role?: SubagentRoleId;
	toolHints?: string[];
	timeoutMs?: number;
	inputMapping?: Record<string, string>;
	condition?: NodeCondition;
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
};

export type GraphComputationContext = {
	nodes: Map<DynamicNodeId, DynamicNode>;
	globalData: Map<string, unknown>;
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
};

export type GraphExecutionEvent =
	| { type: "NodeAdded"; nodeId: DynamicNodeId; config: DynamicNodeConfig }
	| { type: "NodeStatusChanged"; nodeId: DynamicNodeId; status: NodeStatus }
	| { type: "NodeCompleted"; nodeId: DynamicNodeId; result: SubagentResult }
	| { type: "DependenciesResolved"; nodeId: DynamicNodeId; newNodes: DynamicNodeConfig[] }
	| { type: "GraphCompleted"; finalNodes: ReadonlyMap<DynamicNodeId, SubagentResult> };

export type GraphExecutionListener = (event: GraphExecutionEvent) => void;
