import type { ReactAgentTool } from "./reactTypes";
import type { WorkflowOrchestrator } from "./workflowOrchestrator";
import type { DynamicGraphDefinition, DynamicNodeConfig, DependencyResolver } from "./workflow/dynamicGraphTypes";
import { createDynamicGraphEngine, type DynamicGraphEngine } from "./workflow/dynamicGraphEngine";

type DynamicWorkflowToolsOptions = {
	orchestrator: WorkflowOrchestrator;
	availableTools: readonly ReactAgentTool[];
	signal?: AbortSignal;
};

export function createDynamicWorkflowTools({ orchestrator, availableTools, signal }: DynamicWorkflowToolsOptions): ReactAgentTool[] {
	const activeGraphs = new Map<string, DynamicGraphEngine>();
	let nextGraphId = 1;

	return [
		{
			name: "createDynamicGraph",
			description: "Create a dynamic computation graph with initial nodes and optional dependency resolvers.",
			inputSchema: {
				type: "object",
				properties: {
					initialNodes: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string", minLength: 1 },
								task: { type: "string", minLength: 1 },
								role: { type: "string", enum: ["explorer", "reviewer", "planner"] },
								toolHints: { type: "array", items: { type: "string" } },
								timeoutMs: { type: "integer", minimum: 1 },
								inputMapping: { type: "object" },
								condition: {
									type: "object",
									properties: {
										type: { type: "string", enum: ["always", "onSuccess", "onFailure", "custom"] },
										expression: { type: "string" },
									},
									required: ["type"],
								},
							},
							required: ["id", "task"],
						},
					},
					maxNodes: { type: "integer", minimum: 1 },
					maxDepth: { type: "integer", minimum: 1 },
				},
				required: ["initialNodes"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const record = requireRecord(input);
				const initialNodes = parseNodeConfigs(record.initialNodes);
				const maxNodes = record.maxNodes !== undefined ? requirePositiveInteger(record.maxNodes, "maxNodes") : undefined;
				const maxDepth = record.maxDepth !== undefined ? requirePositiveInteger(record.maxDepth, "maxDepth") : undefined;

				const definition: DynamicGraphDefinition = {
					initialNodes,
					resolvers: new Map(),
					maxNodes,
					maxDepth,
				};

				const engine = createDynamicGraphEngine({
					definition,
					orchestrator,
					availableTools,
					signal,
				});

				const graphId = `graph-${nextGraphId++}`;
				activeGraphs.set(graphId, engine);

				return JSON.stringify({ graphId, nodeCount: initialNodes.length });
			},
		},
		{
			name: "executeDynamicGraph",
			description: "Execute a dynamic computation graph and return all node results.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
				},
				required: ["graphId"],
			},
			isConcurrencySafe: () => true,
			async invoke({ input }) {
				const graphId = requireString(requireRecord(input).graphId, "graphId");
				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				const results = await engine.execute();
				const context = engine.getContext();

				return JSON.stringify({
					graphId,
					completedNodes: Array.from(results.keys()),
					results: Object.fromEntries(results),
					executionOrder: context.executionOrder,
				});
			},
		},
		{
			name: "addDynamicResolver",
			description: "Add a dependency resolver to a graph node that will generate new nodes when the node completes.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
					nodeId: { type: "string", minLength: 1 },
					resolverType: { type: "string", enum: ["fanout", "conditional", "iterative"] },
					resolverConfig: { type: "object" },
				},
				required: ["graphId", "nodeId", "resolverType"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const record = requireRecord(input);
				const graphId = requireString(record.graphId, "graphId");
				const nodeId = requireString(record.nodeId, "nodeId");
				const resolverType = requireString(record.resolverType, "resolverType");
				const resolverConfig = record.resolverConfig !== undefined ? requireRecord(record.resolverConfig) : {};

				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				// TODO: Implement resolver based on type
				// This is a placeholder that returns the resolver configuration
				return JSON.stringify({
					graphId,
					nodeId,
					resolverType,
					registered: true,
				});
			},
		},
		{
			name: "getGraphStatus",
			description: "Get the current status of a dynamic computation graph.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
				},
				required: ["graphId"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const graphId = requireString(requireRecord(input).graphId, "graphId");
				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				const context = engine.getContext();
				const statusCounts: Record<string, number> = {};

				for (const node of context.nodes.values()) {
					statusCounts[node.status] = (statusCounts[node.status] || 0) + 1;
				}

				return JSON.stringify({
					graphId,
					totalNodes: context.nodes.size,
					statusCounts,
					executionOrder: context.executionOrder,
				});
			},
		},
		{
			name: "cancelDynamicGraph",
			description: "Cancel a running dynamic computation graph.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
				},
				required: ["graphId"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const graphId = requireString(requireRecord(input).graphId, "graphId");
				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				engine.cancel();
				activeGraphs.delete(graphId);

				return JSON.stringify({ graphId, cancelled: true });
			},
		},
		{
			name: "visualizeGraph",
			description: "Generate a visualization of the dynamic computation graph including nodes, edges, and statistics.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
					format: { type: "string", enum: ["json", "mermaid"] },
				},
				required: ["graphId"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const record = requireRecord(input);
				const graphId = requireString(record.graphId, "graphId");
				const format = record.format !== undefined ? requireString(record.format, "format") : "json";

				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				const visualizer = engine.getVisualizer();

				if (format === "mermaid") {
					return JSON.stringify({
						graphId,
						format: "mermaid",
						diagram: visualizer.exportToMermaid(),
					});
				}

				const visualization = visualizer.generateVisualization();
				return JSON.stringify({
					graphId,
					format: "json",
					visualization,
				});
			},
		},
		{
			name: "getGraphDebugInfo",
			description: "Get detailed debug information about a dynamic computation graph including critical path and bottlenecks.",
			inputSchema: {
				type: "object",
				properties: {
					graphId: { type: "string", minLength: 1 },
				},
				required: ["graphId"],
			},
			isConcurrencySafe: () => true,
			invoke({ input }) {
				const graphId = requireString(requireRecord(input).graphId, "graphId");
				const engine = activeGraphs.get(graphId);
				if (!engine) {
					throw new Error(`Graph ${graphId} not found`);
				}

				const visualizer = engine.getVisualizer();
				const debugInfo = visualizer.generateDebugInfo();

				return JSON.stringify({
					graphId,
					nodeDetails: Object.fromEntries(debugInfo.nodeDetails),
					dataFlowRecords: debugInfo.dataFlowRecords,
					executionOrder: debugInfo.executionOrder,
					criticalPath: debugInfo.criticalPath,
					bottlenecks: debugInfo.bottlenecks,
				});
			},
		},
	];
}

function parseNodeConfigs(value: unknown): DynamicNodeConfig[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("initialNodes must be a non-empty array");
	}

	return value.map((item, index) => {
		const record = requireRecord(item);
		const id = requireString(record.id, `initialNodes[${index}].id`);
		const task = requireString(record.task, `initialNodes[${index}].task`);
		const role = record.role !== undefined ? requireRole(record.role) : undefined;
		const toolHints = record.toolHints !== undefined ? requireStringArray(record.toolHints, `initialNodes[${index}].toolHints`) : undefined;
		const timeoutMs = record.timeoutMs !== undefined ? requirePositiveInteger(record.timeoutMs, `initialNodes[${index}].timeoutMs`) : undefined;
		const inputMapping = record.inputMapping !== undefined ? requireRecord(record.inputMapping) as Record<string, string> : undefined;
		const condition = record.condition !== undefined ? parseCondition(record.condition, index) : undefined;

		return {
			id,
			task,
			...(role && { role }),
			...(toolHints && { toolHints }),
			...(timeoutMs && { timeoutMs }),
			...(inputMapping && { inputMapping }),
			...(condition && { condition }),
		};
	});
}

function parseCondition(value: unknown, index: number) {
	const record = requireRecord(value);
	const type = requireString(record.type, `initialNodes[${index}].condition.type`);
	const expression = record.expression !== undefined ? requireString(record.expression, `initialNodes[${index}].condition.expression`) : undefined;

	if (!["always", "onSuccess", "onFailure", "custom"].includes(type)) {
		throw new Error(`initialNodes[${index}].condition.type must be one of: always, onSuccess, onFailure, custom`);
	}

	return { type: type as "always" | "onSuccess" | "onFailure" | "custom", ...(expression && { expression }) };
}

function requireRecord(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("input must be an object");
	}
	return input as Record<string, unknown>;
}

function requireString(value: unknown, property: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${property} must be a non-empty string`);
	}
	return value.trim();
}

function requireStringArray(value: unknown, property: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${property} entries must be non-empty strings`);
	}
	return value.map((item) => item.trim());
}

function requirePositiveInteger(value: unknown, property: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${property} must be a positive safe integer`);
	}
	return value;
}

const VALID_ROLES: ReadonlySet<string> = new Set(["explorer", "reviewer", "planner"]);

function requireRole(value: unknown): "explorer" | "reviewer" | "planner" {
	if (typeof value !== "string" || !VALID_ROLES.has(value)) {
		throw new Error(`role must be one of: ${[...VALID_ROLES].join(", ")}`);
	}
	return value as "explorer" | "reviewer" | "planner";
}
