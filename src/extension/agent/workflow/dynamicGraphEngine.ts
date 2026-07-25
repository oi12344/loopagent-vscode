import type { WorkflowOrchestrator } from "../workflowOrchestrator";
import type { ReactAgentTool } from "../reactTypes";
import type { SubagentResult } from "./types";
import type {
	DynamicGraphDefinition,
	DynamicNode,
	DynamicNodeConfig,
	DynamicNodeId,
	GraphComputationContext,
	GraphExecutionEvent,
	GraphExecutionListener,
	NodeStatus,
} from "./dynamicGraphTypes";
import { createDataFlowManager, type DataFlowManager } from "./dataFlowManager";
import { createGraphVisualizer, type GraphVisualizer } from "./graphVisualizer";

export type DynamicGraphEngineOptions = {
	definition: DynamicGraphDefinition;
	orchestrator: WorkflowOrchestrator;
	availableTools: readonly ReactAgentTool[];
	signal?: AbortSignal;
};

export type DynamicGraphEngine = {
	execute(): Promise<ReadonlyMap<DynamicNodeId, SubagentResult>>;
	getContext(): Readonly<GraphComputationContext>;
	getDataFlowManager(): DataFlowManager;
	getVisualizer(): GraphVisualizer;
	cancel(): void;
	onEvent(listener: GraphExecutionListener): () => void;
};

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_DEPTH = 10;

export function createDynamicGraphEngine(options: DynamicGraphEngineOptions): DynamicGraphEngine {
	const { definition, orchestrator, availableTools, signal } = options;
	const maxNodes = definition.maxNodes ?? DEFAULT_MAX_NODES;
	const maxDepth = definition.maxDepth ?? DEFAULT_MAX_DEPTH;

	const context: GraphComputationContext = {
		nodes: new Map(),
		globalData: new Map(),
		executionOrder: [],
	};

	const dataFlowManager = createDataFlowManager();
	const visualizer = createGraphVisualizer(context, dataFlowManager);
	const listeners = new Set<GraphExecutionListener>();
	const pendingResolvers = new Map<DynamicNodeId, Set<DynamicNodeId>>();
	let cancelled = false;

	function emit(event: GraphExecutionEvent): void {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				continue;
			}
		}
	}

	function addNode(config: DynamicNodeConfig, dependencies: DynamicNodeId[] = []): DynamicNodeId {
		if (context.nodes.size >= maxNodes) {
			throw new Error(`Maximum nodes limit (${maxNodes}) exceeded`);
		}

		const depth = calculateNodeDepth(config.id, dependencies);
		if (depth > maxDepth) {
			throw new Error(`Maximum depth (${maxDepth}) exceeded for node ${config.id}`);
		}

		const node: DynamicNode = {
			config,
			status: "pending",
			dependencies: new Set(dependencies),
			dependents: new Set(),
			context: {},
		};

		context.nodes.set(config.id, node);

		for (const depId of dependencies) {
			const depNode = context.nodes.get(depId);
			if (depNode) {
				depNode.dependents.add(config.id);
			}
		}

		emit({ type: "NodeAdded", nodeId: config.id, config });
		return config.id;
	}

	function calculateNodeDepth(nodeId: DynamicNodeId, dependencies: DynamicNodeId[]): number {
		const visited = new Set<DynamicNodeId>();
		const stack: Array<{ id: DynamicNodeId; depth: number }> = dependencies.map((id) => ({ id, depth: 1 }));
		let maxDepth = dependencies.length > 0 ? 1 : 0;

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (visited.has(current.id)) continue;
			visited.add(current.id);

			maxDepth = Math.max(maxDepth, current.depth);
			const node = context.nodes.get(current.id);
			if (node) {
				for (const depId of node.dependencies) {
					stack.push({ id: depId, depth: current.depth + 1 });
				}
			}
		}

		return maxDepth;
	}

	function updateNodeStatus(nodeId: DynamicNodeId, status: NodeStatus): void {
		const node = context.nodes.get(nodeId);
		if (!node || node.status === status) return;

		node.status = status;
		emit({ type: "NodeStatusChanged", nodeId, status });

		if (status === "completed" || status === "failed") {
			context.executionOrder.push(nodeId);
		}
	}

	function evaluateCondition(node: DynamicNode, completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>): boolean {
		const condition = node.config.condition;
		if (!condition) return true;

		if (condition.type === "always") return true;

		const depResults = Array.from(node.dependencies).map((depId) => completedNodes.get(depId));
		if (depResults.some((r) => !r)) return false;

		if (condition.type === "onSuccess") {
			return depResults.every((r) => r!.status === "completed");
		}

		if (condition.type === "onFailure") {
			return depResults.some((r) => r!.status === "failed");
		}

		// TODO(human): Custom expression evaluation
		return true;
	}

	function prepareNodeInput(node: DynamicNode, completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>): Record<string, unknown> {
		if (!node.config.inputMapping) {
			return {};
		}

		const expressionContext = {
			nodes: completedNodes,
			globalData: context.globalData,
			currentNode: node.config.id,
		};

		const inputData = dataFlowManager.mapInputs(node.config.inputMapping, expressionContext);
		dataFlowManager.recordInput(node.config.id, inputData);

		return inputData;
	}

	async function executeNode(node: DynamicNode, completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>): Promise<void> {
		if (!evaluateCondition(node, completedNodes)) {
			updateNodeStatus(node.config.id, "skipped");
			return;
		}

		const inputData = prepareNodeInput(node, completedNodes);
		node.context = inputData;

		updateNodeStatus(node.config.id, "ready");

		const subagentId = orchestrator.createSubagent(
			{
				task: node.config.task,
				role: node.config.role,
				toolHints: node.config.toolHints,
				timeoutMs: node.config.timeoutMs,
				dependsOn: Array.from(node.dependencies)
					.map((depId) => context.nodes.get(depId)?.subagentId)
					.filter((id): id is string => !!id),
			},
			availableTools,
		);

		node.subagentId = subagentId;
		updateNodeStatus(node.config.id, "running");

		const results = await orchestrator.waitForSubagents([subagentId]);
		const result = results.get(subagentId);

		if (result) {
			node.result = result;
			updateNodeStatus(node.config.id, result.status === "completed" ? "completed" : "failed");

			dataFlowManager.recordOutput(node.config.id, result);
			emit({ type: "NodeCompleted", nodeId: node.config.id, result });

			const newCompletedNodes = new Map(completedNodes);
			newCompletedNodes.set(node.config.id, result);

			await resolveDependencies(node.config.id, newCompletedNodes);
		}
	}

	async function resolveDependencies(
		nodeId: DynamicNodeId,
		completedNodes: ReadonlyMap<DynamicNodeId, SubagentResult>,
	): Promise<void> {
		const resolver = definition.resolvers?.get(nodeId);
		if (!resolver) return;

		try {
			const newNodeConfigs = await resolver(nodeId, completedNodes, context);
			if (newNodeConfigs.length === 0) return;

			const newNodeIds: DynamicNodeId[] = [];
			for (const config of newNodeConfigs) {
				const id = addNode(config, [nodeId]);
				newNodeIds.push(id);
			}

			emit({ type: "DependenciesResolved", nodeId, newNodes: newNodeConfigs });
		} catch (error) {
			console.error(`Failed to resolve dependencies for node ${nodeId}:`, error);
		}
	}

	async function execute(): Promise<ReadonlyMap<DynamicNodeId, SubagentResult>> {
		for (const config of definition.initialNodes) {
			addNode(config);
		}

		const completedNodes = new Map<DynamicNodeId, SubagentResult>();

		while (!cancelled && !signal?.aborted) {
			const readyNodes = Array.from(context.nodes.values()).filter(
				(node) =>
					node.status === "pending" &&
					Array.from(node.dependencies).every((depId) => {
						const depNode = context.nodes.get(depId);
						return depNode?.status === "completed" || depNode?.status === "skipped";
					}),
			);

			if (readyNodes.length === 0) {
				const hasRunning = Array.from(context.nodes.values()).some((node) => node.status === "running" || node.status === "ready");
				if (!hasRunning) break;

				await new Promise((resolve) => setTimeout(resolve, 100));
				continue;
			}

			await Promise.all(readyNodes.map((node) => executeNode(node, completedNodes)));

			for (const node of context.nodes.values()) {
				if (node.result && !completedNodes.has(node.config.id)) {
					completedNodes.set(node.config.id, node.result);
				}
			}
		}

		emit({ type: "GraphCompleted", finalNodes: completedNodes });
		return completedNodes;
	}

	function cancel(): void {
		cancelled = true;
		orchestrator.cancelAll();
	}

	return {
		execute,
		getContext: () => Object.freeze({ ...context }) as Readonly<GraphComputationContext>,
		getDataFlowManager: () => dataFlowManager,
		getVisualizer: () => visualizer,
		cancel,
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
