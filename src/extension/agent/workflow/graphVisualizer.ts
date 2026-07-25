import type { DynamicNode, DynamicNodeId, GraphComputationContext, NodeStatus } from "./dynamicGraphTypes";
import type { DataFlowManager } from "./dataFlowManager";

export type GraphVisualization = {
	nodes: VisualizationNode[];
	edges: VisualizationEdge[];
	stats: GraphStats;
	timeline: TimelineEvent[];
};

export type VisualizationNode = {
	id: DynamicNodeId;
	label: string;
	status: NodeStatus;
	role?: string;
	startedAt?: string;
	finishedAt?: string;
	duration?: number;
	depth: number;
	error?: string;
};

export type VisualizationEdge = {
	from: DynamicNodeId;
	to: DynamicNodeId;
	type: "dependency" | "dataflow";
	label?: string;
};

export type GraphStats = {
	totalNodes: number;
	completedNodes: number;
	failedNodes: number;
	skippedNodes: number;
	runningNodes: number;
	pendingNodes: number;
	totalEdges: number;
	maxDepth: number;
	avgDuration?: number;
};

export type TimelineEvent = {
	timestamp: string;
	nodeId: DynamicNodeId;
	event: "created" | "started" | "completed" | "failed" | "skipped";
	details?: string;
};

export type GraphDebugInfo = {
	nodeDetails: Map<DynamicNodeId, NodeDebugInfo>;
	dataFlowRecords: any[];
	executionOrder: DynamicNodeId[];
	criticalPath: DynamicNodeId[];
	bottlenecks: DynamicNodeId[];
};

export type NodeDebugInfo = {
	id: DynamicNodeId;
	task: string;
	status: NodeStatus;
	dependencies: DynamicNodeId[];
	dependents: DynamicNodeId[];
	inputData: Record<string, unknown>;
	outputData: Record<string, unknown>;
	executionTime?: number;
	toolCalls?: number;
};

export function createGraphVisualizer(context: GraphComputationContext, dataFlowManager: DataFlowManager) {
	function generateVisualization(): GraphVisualization {
		const nodes: VisualizationNode[] = [];
		const edges: VisualizationEdge[] = [];
		const timeline: TimelineEvent[] = [];

		const depthMap = calculateDepths(context);

		for (const [nodeId, node] of context.nodes) {
			const duration = calculateDuration(node);

			nodes.push({
				id: nodeId,
				label: truncateTask(node.config.task),
				status: node.status,
				role: node.config.role,
				startedAt: node.context?.startedAt?.toString(),
				finishedAt: node.context?.finishedAt?.toString(),
				duration,
				depth: depthMap.get(nodeId) ?? 0,
				error: node.result?.error,
			});

			for (const depId of node.dependencies) {
				edges.push({
					from: depId,
					to: nodeId,
					type: "dependency",
				});
			}

			if (node.context?.startedAt) {
				timeline.push({
					timestamp: node.context.startedAt.toString(),
					nodeId,
					event: "started",
				});
			}

			if (node.context?.finishedAt) {
				const event = node.status === "completed" ? "completed" : node.status === "failed" ? "failed" : "skipped";
				timeline.push({
					timestamp: node.context.finishedAt.toString(),
					nodeId,
					event: event as "completed" | "failed" | "skipped",
					details: node.result?.error,
				});
			}
		}

		timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

		const stats = calculateStats(context, depthMap);

		return { nodes, edges, stats, timeline };
	}

	function calculateDepths(context: GraphComputationContext): Map<DynamicNodeId, number> {
		const depths = new Map<DynamicNodeId, number>();

		function getDepth(nodeId: DynamicNodeId, visited: Set<DynamicNodeId>): number {
			if (depths.has(nodeId)) return depths.get(nodeId)!;
			if (visited.has(nodeId)) return 0;

			visited.add(nodeId);
			const node = context.nodes.get(nodeId);
			if (!node) return 0;

			const maxDepDep = Math.max(0, ...Array.from(node.dependencies).map((depId) => getDepth(depId, visited)));
			const depth = maxDepDep + 1;
			depths.set(nodeId, depth);

			return depth;
		}

		for (const nodeId of context.nodes.keys()) {
			getDepth(nodeId, new Set());
		}

		return depths;
	}

	function calculateDuration(node: DynamicNode): number | undefined {
		const started = node.context?.startedAt as any;
		const finished = node.context?.finishedAt as any;

		if (started && finished) {
			return new Date(finished).getTime() - new Date(started).getTime();
		}

		return undefined;
	}

	function calculateStats(context: GraphComputationContext, depthMap: Map<DynamicNodeId, number>): GraphStats {
		let completedNodes = 0;
		let failedNodes = 0;
		let skippedNodes = 0;
		let runningNodes = 0;
		let pendingNodes = 0;
		let totalDuration = 0;
		let durationCount = 0;

		for (const node of context.nodes.values()) {
			switch (node.status) {
				case "completed":
					completedNodes++;
					break;
				case "failed":
					failedNodes++;
					break;
				case "skipped":
					skippedNodes++;
					break;
				case "running":
					runningNodes++;
					break;
				case "pending":
				case "ready":
					pendingNodes++;
					break;
			}

			const duration = calculateDuration(node);
			if (duration !== undefined) {
				totalDuration += duration;
				durationCount++;
			}
		}

		const totalEdges = Array.from(context.nodes.values()).reduce((sum, node) => sum + node.dependencies.size, 0);
		const maxDepth = Math.max(0, ...depthMap.values());
		const avgDuration = durationCount > 0 ? totalDuration / durationCount : undefined;

		return {
			totalNodes: context.nodes.size,
			completedNodes,
			failedNodes,
			skippedNodes,
			runningNodes,
			pendingNodes,
			totalEdges,
			maxDepth,
			avgDuration,
		};
	}

	function generateDebugInfo(): GraphDebugInfo {
		const nodeDetails = new Map<DynamicNodeId, NodeDebugInfo>();

		for (const [nodeId, node] of context.nodes) {
			const flowRecords = dataFlowManager.getNodeData(nodeId);
			const inputRecord = flowRecords.find((r) => r.source === "input");
			const outputRecord = flowRecords.find((r) => r.source === "output");

			nodeDetails.set(nodeId, {
				id: nodeId,
				task: node.config.task,
				status: node.status,
				dependencies: Array.from(node.dependencies),
				dependents: Array.from(node.dependents),
				inputData: inputRecord?.data ?? {},
				outputData: outputRecord?.data ?? {},
				executionTime: calculateDuration(node),
				toolCalls: node.result?.toolCallCount,
			});
		}

		const dataFlowRecords = dataFlowManager.getFlowHistory();
		const executionOrder = context.executionOrder;
		const criticalPath = findCriticalPath(context);
		const bottlenecks = findBottlenecks(context);

		return {
			nodeDetails,
			dataFlowRecords: Array.from(dataFlowRecords),
			executionOrder,
			criticalPath,
			bottlenecks,
		};
	}

	function findCriticalPath(context: GraphComputationContext): DynamicNodeId[] {
		const durations = new Map<DynamicNodeId, number>();

		for (const [nodeId, node] of context.nodes) {
			durations.set(nodeId, calculateDuration(node) ?? 0);
		}

		const longestPaths = new Map<DynamicNodeId, { length: number; path: DynamicNodeId[] }>();

		function getLongestPath(nodeId: DynamicNodeId): { length: number; path: DynamicNodeId[] } {
			if (longestPaths.has(nodeId)) {
				return longestPaths.get(nodeId)!;
			}

			const node = context.nodes.get(nodeId);
			if (!node || node.dependencies.size === 0) {
				const result = { length: durations.get(nodeId) ?? 0, path: [nodeId] };
				longestPaths.set(nodeId, result);
				return result;
			}

			let maxLength = 0;
			let maxPath: DynamicNodeId[] = [];

			for (const depId of node.dependencies) {
				const depPath = getLongestPath(depId);
				if (depPath.length > maxLength) {
					maxLength = depPath.length;
					maxPath = depPath.path;
				}
			}

			const result = {
				length: maxLength + (durations.get(nodeId) ?? 0),
				path: [...maxPath, nodeId],
			};

			longestPaths.set(nodeId, result);
			return result;
		}

		let criticalPath: DynamicNodeId[] = [];
		let maxLength = 0;

		for (const nodeId of context.nodes.keys()) {
			const path = getLongestPath(nodeId);
			if (path.length > maxLength) {
				maxLength = path.length;
				criticalPath = path.path;
			}
		}

		return criticalPath;
	}

	function findBottlenecks(context: GraphComputationContext): DynamicNodeId[] {
		const bottlenecks: DynamicNodeId[] = [];

		for (const [nodeId, node] of context.nodes) {
			if (node.dependents.size >= 3) {
				bottlenecks.push(nodeId);
			}
		}

		return bottlenecks;
	}

	function truncateTask(task: string, maxLength: number = 50): string {
		if (task.length <= maxLength) return task;
		return task.substring(0, maxLength - 3) + "...";
	}

	function exportToMermaid(): string {
		const lines: string[] = ["graph TD"];

		for (const [nodeId, node] of context.nodes) {
			const statusSymbol = getStatusSymbol(node.status);
			const label = `${statusSymbol} ${truncateTask(node.config.task, 30)}`;
			const style = getNodeStyle(node.status);
			lines.push(`    ${nodeId}["${label}"]:::${style}`);

			for (const depId of node.dependencies) {
				lines.push(`    ${depId} --> ${nodeId}`);
			}
		}

		lines.push("");
		lines.push("    classDef completed fill:#90EE90,stroke:#333,stroke-width:2px");
		lines.push("    classDef running fill:#FFD700,stroke:#333,stroke-width:2px");
		lines.push("    classDef failed fill:#FF6B6B,stroke:#333,stroke-width:2px");
		lines.push("    classDef pending fill:#D3D3D3,stroke:#333,stroke-width:2px");
		lines.push("    classDef skipped fill:#A9A9A9,stroke:#333,stroke-width:1px,stroke-dasharray: 5 5");

		return lines.join("\n");
	}

	function getStatusSymbol(status: NodeStatus): string {
		switch (status) {
			case "completed":
				return "✓";
			case "failed":
				return "✗";
			case "running":
				return "⟳";
			case "skipped":
				return "⊘";
			default:
				return "○";
		}
	}

	function getNodeStyle(status: NodeStatus): string {
		switch (status) {
			case "completed":
				return "completed";
			case "failed":
				return "failed";
			case "running":
			case "ready":
				return "running";
			case "skipped":
				return "skipped";
			default:
				return "pending";
		}
	}

	return {
		generateVisualization,
		generateDebugInfo,
		exportToMermaid,
	};
}

export type GraphVisualizer = ReturnType<typeof createGraphVisualizer>;
