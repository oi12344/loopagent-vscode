import type { SubagentResult, SubagentRoleId } from "./types";
import type { DataFlowValue } from "./dataFlowManager";
import type { CycleEdge } from "./cycleManager";

export type DynamicNodeId = string;

export type NodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled"
	| "pending-retry";  // 新增：等待循环重试（节点已完成但将被重置）

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
	cycles?: CycleEdge[];  // 新增：循环边定义
	maxNodes?: number;
	maxDepth?: number;
	maxSteps?: number;
	maxExecutions?: number;
	initialGlobalData?: Record<string, DataFlowValue>;
};

export type WorkflowStateSnapshot = {
	step: number;
	version: number;
	values: ReadonlyMap<string, unknown>;
};

export type StateWrite = {
	channel: string;
	value: unknown;
	mode: "single" | "append" | "merge";
	nodeId: DynamicNodeId;
};

export type GraphExecutionEvent =
	| { type: "NodeAdded"; nodeId: DynamicNodeId; config: DynamicNodeConfig }
	| { type: "NodeStatusChanged"; nodeId: DynamicNodeId; status: NodeStatus }
	| { type: "NodeCompleted"; nodeId: DynamicNodeId; result: SubagentResult }
	| { type: "DependenciesResolved"; nodeId: DynamicNodeId; newNodes: DynamicNodeConfig[] }
	| { type: "ResolverFailed"; nodeId: DynamicNodeId; error: string }
	| { type: "CycleTriggered"; cycleId: string; fromNode: DynamicNodeId; toNode: DynamicNodeId; iteration: number; reason: string }
	| { type: "CycleStopped"; cycleId: string; reason: string; totalIterations: number }
	| {
			type: "GraphCompleted";
			finalNodes: ReadonlyMap<DynamicNodeId, SubagentResult>;
			failedNodes: DynamicNodeId[];
			unreachedNodes: DynamicNodeId[];
	  }
	| { type: "GraphCancelled"; finalNodes: ReadonlyMap<DynamicNodeId, SubagentResult> };

export type GraphExecutionListener = (event: GraphExecutionEvent) => void;
