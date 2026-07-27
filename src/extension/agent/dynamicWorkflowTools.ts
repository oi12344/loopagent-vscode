import type { ReactAgentTool } from "./reactTypes";
import type { WorkflowOrchestrator } from "./workflowOrchestrator";
import type { DataFlowValue } from "./workflow/dataFlowManager";
import type { DynamicGraphDefinition, DynamicNodeConfig, DependencyResolver, GraphComputationContext } from "./workflow/dynamicGraphTypes";
import { createDynamicGraphEngine, DEFAULT_DYNAMIC_GRAPH_LIMITS, type DynamicGraphEngine } from "./workflow/dynamicGraphEngine";
import type { GraphDebugInfo } from "./workflow/graphVisualizer";
import { createReflectionResolver } from "./workflow/reflectionResolver";
import type { SubagentRoleId, SubagentResult } from "./workflow/types";

type DynamicWorkflowToolsOptions = {
	orchestrator: WorkflowOrchestrator;
	availableTools: readonly ReactAgentTool[];
	signal?: AbortSignal;
};

type ActiveGraph = {
	engine: DynamicGraphEngine;
	resolvers: Map<string, DependencyResolver>;
	initialNodeIds: Set<string>;
};

type GraphInclude = "visualization" | "debug" | "mermaid";

const VALID_INCLUDES: ReadonlySet<string> = new Set<GraphInclude>(["visualization", "debug", "mermaid"]);

const RETRY_SCHEMA = {
	type: "object",
	properties: {
		maxAttempts: { type: "integer", minimum: 1 },
		backoffMs: { type: "integer", minimum: 0 },
	},
	required: ["maxAttempts"],
};

const NODE_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1 },
		task: { type: "string", minLength: 1 },
		role: { type: "string", enum: ["explorer", "reviewer", "planner", "executor"] },
		dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
		toolHints: { type: "array", items: { type: "string", minLength: 1 } },
		timeoutMs: { type: "integer", minimum: 1 },
		inputMapping: { type: "object", additionalProperties: { type: "string" } },
		condition: {
			type: "object",
			properties: {
				type: { type: "string", enum: ["always", "onSuccess", "onFailure", "custom"] },
				expression: { type: "string" },
			},
			required: ["type"],
		},
		exportTo: { type: "string", minLength: 1 },
		retry: RETRY_SCHEMA,
	},
	required: ["id", "task"],
};

const RESOLVER_SCHEMA = {
	type: "object",
	properties: {
		nodeId: { type: "string", minLength: 1 },
		resolverType: { type: "string", enum: ["fanout", "conditional", "iterative"] },
		resolverConfig: {
			type: "object",
			properties: {
				itemsExpression: { type: "string", minLength: 1 },
				idPrefix: { type: "string", minLength: 1 },
				task: { type: "string", minLength: 1 },
				role: NODE_SCHEMA.properties.role,
				toolHints: NODE_SCHEMA.properties.toolHints,
				retry: RETRY_SCHEMA,
				itemInputKey: { type: "string", minLength: 1 },
				expression: { type: "string", minLength: 1 },
				nodes: { type: "array", items: NODE_SCHEMA },
				maxRounds: { type: "integer", minimum: 1 },
				approvalText: { type: "string", minLength: 1 },
				reviseTask: { type: "string", minLength: 1 },
				reviewTask: { type: "string", minLength: 1 },
				reviseRole: NODE_SCHEMA.properties.role,
				reviewRole: NODE_SCHEMA.properties.role,
			},
		},
	},
	required: ["nodeId", "resolverType", "resolverConfig"],
};

export function createDynamicWorkflowTools({ orchestrator, availableTools, signal }: DynamicWorkflowToolsOptions): ReactAgentTool[] {
	return [
		{
			name: "runDynamicGraph",
			description:
				"Create and execute a dynamic computation graph in one call, then return every node result. Register fanout, conditional, or iterative expansion through the optional resolvers field.",
			inputSchema: {
				type: "object",
				properties: {
					initialNodes: {
						type: "array",
						items: NODE_SCHEMA,
					},
					resolvers: {
						type: "array",
						items: RESOLVER_SCHEMA,
					},
					initialGlobalData: { type: "object" },
					maxNodes: { type: "integer", minimum: 1 },
					maxDepth: { type: "integer", minimum: 1 },
					include: {
						type: "array",
						items: { type: "string", enum: ["visualization", "debug", "mermaid"] },
					},
				},
				required: ["initialNodes"],
			},
			// The merged tool runs the whole graph, including executor nodes that write to the
			// workspace. Two concurrent invocations would bypass the orchestrator's single-executor
			// gate, so this tool must never share a concurrent batch.
			isConcurrencySafe: () => false,
			async invoke({ input }) {
				const record = requireRecord(input);
				const initialNodes = parseNodeConfigs(record.initialNodes);
				const maxNodes = record.maxNodes !== undefined ? requirePositiveInteger(record.maxNodes, "maxNodes") : undefined;
				const maxDepth = record.maxDepth !== undefined ? requirePositiveInteger(record.maxDepth, "maxDepth") : undefined;
				const initialGlobalData = record.initialGlobalData !== undefined
					? requireRecord(record.initialGlobalData) as Record<string, DataFlowValue>
					: undefined;
				const include = parseIncludes(record.include);
				validateInitialGraph(
					initialNodes,
					maxNodes ?? DEFAULT_DYNAMIC_GRAPH_LIMITS.maxNodes,
					maxDepth ?? DEFAULT_DYNAMIC_GRAPH_LIMITS.maxDepth,
				);

				// The engine reads `definition.resolvers` lazily at execution time, so the map can stay
				// empty here and be filled in below -- that breaks the cycle between resolver closures
				// (which need the engine's data-flow manager) and the engine (which needs the map).
				const resolvers = new Map<string, DependencyResolver>();
				const definition: DynamicGraphDefinition = {
					initialNodes,
					resolvers,
					maxNodes,
					maxDepth,
					initialGlobalData,
				};
				const engine = createDynamicGraphEngine({
					definition,
					orchestrator,
					availableTools,
					signal,
				});
				const activeGraph: ActiveGraph = {
					engine,
					resolvers,
					initialNodeIds: new Set(initialNodes.map((node) => node.id)),
				};

				for (const entry of parseResolverEntries(record.resolvers)) {
					if (!activeGraph.initialNodeIds.has(entry.nodeId)) {
						throw new Error(`Resolver nodeId "${entry.nodeId}" is not an initial node`);
					}
					resolvers.set(entry.nodeId, createConfiguredResolver(entry.resolverType, entry.resolverConfig, activeGraph));
				}

				const nodes = initialNodes.map((node) => ({
					id: node.id,
					role: node.role ?? "explorer",
					dependsOn: node.dependsOn ?? [],
				}));
				const resolverFailures: Array<{ nodeId: string; error: string }> = [];
				const dispose = engine.onEvent((event) => {
					if (event.type === "ResolverFailed") resolverFailures.push({ nodeId: event.nodeId, error: event.error });
				});

				try {
					const results = await engine.execute();
					const context = engine.getContext();
					const statusCounts: Record<string, number> = {};
					for (const node of context.nodes.values()) {
						statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1;
					}

					// A graph where nothing completed carries no evidence, but execute() still resolves
					// normally -- returning it as a success would satisfy the runner's requiredToolNames
					// gate and let the model answer from nothing. Throwing keeps the gate closed so the
					// model has to build a working graph. User cancellation is exempt: the run is ending
					// anyway and the partial results are all there is.
					const cancelled = (statusCounts.cancelled ?? 0) > 0;
					if ((statusCounts.completed ?? 0) === 0 && !cancelled) {
						throw new Error(
							`No graph node completed (${formatStatusCounts(statusCounts)}). `
							+ `Rebuild a simpler graph with narrower node tasks.`
							+ (resolverFailures.length > 0 ? ` Resolver failures: ${resolverFailures.map((entry) => `${entry.nodeId}: ${entry.error}`).join("; ")}` : ""),
						);
					}

					const visualizer = engine.getVisualizer();
					return JSON.stringify({
						nodes,
						totalNodes: context.nodes.size,
						statusCounts,
						completedNodes: Array.from(results.keys()),
						results: Object.fromEntries(results),
						executionOrder: context.executionOrder,
						resolverFailures,
						...(include.has("visualization") && { visualization: visualizer.generateVisualization() }),
						...(include.has("debug") && { debugInfo: serializeDebugInfo(visualizer.generateDebugInfo()) }),
						...(include.has("mermaid") && { mermaid: visualizer.exportToMermaid() }),
					});
				} finally {
					dispose();
				}
			},
		},
	];
}

function formatStatusCounts(statusCounts: Record<string, number>): string {
	const entries = Object.entries(statusCounts);
	return entries.length > 0 ? entries.map(([status, count]) => `${status}: ${count}`).join(", ") : "no nodes";
}

function serializeDebugInfo(debugInfo: GraphDebugInfo) {
	return {
		nodeDetails: Object.fromEntries(debugInfo.nodeDetails),
		dataFlowRecords: debugInfo.dataFlowRecords,
		executionOrder: debugInfo.executionOrder,
		criticalPath: debugInfo.criticalPath,
		bottlenecks: debugInfo.bottlenecks,
	};
}

function parseIncludes(value: unknown): ReadonlySet<GraphInclude> {
	if (value === undefined) return new Set();
	if (!Array.isArray(value)) throw new Error("include must be an array");
	for (const entry of value) {
		if (typeof entry !== "string" || !VALID_INCLUDES.has(entry)) {
			throw new Error(`include entries must be one of: ${[...VALID_INCLUDES].join(", ")}`);
		}
	}
	return new Set(value as GraphInclude[]);
}

function parseResolverEntries(value: unknown): Array<{ nodeId: string; resolverType: string; resolverConfig: Record<string, unknown> }> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("resolvers must be an array");

	const seen = new Set<string>();
	return value.map((item, index) => {
		const record = requireRecord(item);
		const path = `resolvers[${index}]`;
		const nodeId = requireString(record.nodeId, `${path}.nodeId`);
		if (seen.has(nodeId)) throw new Error(`Duplicate resolver for node id: ${nodeId}`);
		seen.add(nodeId);
		return {
			nodeId,
			resolverType: requireString(record.resolverType, `${path}.resolverType`),
			resolverConfig: requireRecord(record.resolverConfig),
		};
	});
}

function parseNodeConfigs(value: unknown, property = "initialNodes"): DynamicNodeConfig[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${property} must be a non-empty array`);
	}

	const nodes = value.map((item, index) => {
		const record = requireRecord(item);
		const path = `${property}[${index}]`;
		const id = requireNodeId(record.id, `${path}.id`);
		const task = requireString(record.task, `${path}.task`);
		const role = record.role !== undefined ? requireRole(record.role) : undefined;
		const dependsOn = record.dependsOn !== undefined ? requireStringArray(record.dependsOn, `${path}.dependsOn`) : undefined;
		const toolHints = record.toolHints !== undefined ? requireStringArray(record.toolHints, `${path}.toolHints`) : undefined;
		const timeoutMs = record.timeoutMs !== undefined ? requirePositiveInteger(record.timeoutMs, `${path}.timeoutMs`) : undefined;
		const inputMapping = record.inputMapping !== undefined ? requireStringRecord(record.inputMapping, `${path}.inputMapping`) : undefined;
		const condition = record.condition !== undefined ? parseCondition(record.condition, path) : undefined;
		const exportTo = record.exportTo !== undefined ? requireString(record.exportTo, `${path}.exportTo`) : undefined;
		const retry = record.retry !== undefined ? parseRetry(record.retry, `${path}.retry`) : undefined;

		return {
			id,
			task,
			...(role && { role }),
			...(dependsOn && { dependsOn }),
			...(toolHints && { toolHints }),
			...(timeoutMs && { timeoutMs }),
			...(inputMapping && { inputMapping }),
			...(condition && { condition }),
			...(exportTo && { exportTo }),
			...(retry && { retry }),
		};
	});
	const ids = new Set<string>();
	for (const node of nodes) {
		if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
		ids.add(node.id);
	}
	return nodes;
}

function parseCondition(value: unknown, path: string) {
	const record = requireRecord(value);
	const type = requireString(record.type, `${path}.condition.type`);
	const expression = record.expression !== undefined ? requireString(record.expression, `${path}.condition.expression`) : undefined;

	if (!["always", "onSuccess", "onFailure", "custom"].includes(type)) {
		throw new Error(`${path}.condition.type must be one of: always, onSuccess, onFailure, custom`);
	}
	if (type === "custom" && !expression) throw new Error(`${path}.condition.expression is required for custom conditions`);

	return { type: type as "always" | "onSuccess" | "onFailure" | "custom", ...(expression && { expression }) };
}

function parseRetry(value: unknown, property: string): NonNullable<DynamicNodeConfig["retry"]> {
	const record = requireRecord(value);
	const maxAttempts = requirePositiveInteger(record.maxAttempts, `${property}.maxAttempts`);
	const backoffMs = record.backoffMs !== undefined ? requireNonNegativeInteger(record.backoffMs, `${property}.backoffMs`) : undefined;
	return { maxAttempts, ...(backoffMs !== undefined && { backoffMs }) };
}

function validateInitialGraph(nodes: readonly DynamicNodeConfig[], maxNodes?: number, maxDepth?: number): void {
	if (maxNodes !== undefined && nodes.length > maxNodes) {
		throw new Error(`Maximum nodes limit (${maxNodes}) exceeded`);
	}
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const depths = new Map<string, number>();
	const visiting = new Set<string>();

	function depthOf(nodeId: string): number {
		const cached = depths.get(nodeId);
		if (cached !== undefined) return cached;
		if (visiting.has(nodeId)) throw new Error(`Circular dependsOn detected involving initial node "${nodeId}"`);
		const node = byId.get(nodeId)!;
		visiting.add(nodeId);
		let depth = 0;
		for (const dependencyId of node.dependsOn ?? []) {
			if (!byId.has(dependencyId)) {
				throw new Error(`Node "${nodeId}" declares dependsOn "${dependencyId}", which is not a known initial node id`);
			}
			depth = Math.max(depth, depthOf(dependencyId) + 1);
		}
		visiting.delete(nodeId);
		depths.set(nodeId, depth);
		return depth;
	}

	for (const node of nodes) {
		const depth = depthOf(node.id);
		if (maxDepth !== undefined && depth > maxDepth) {
			throw new Error(`Maximum depth (${maxDepth}) exceeded for node ${node.id}`);
		}
	}
}

function createConfiguredResolver(type: string, config: Record<string, unknown>, activeGraph: ActiveGraph): DependencyResolver {
	if (type === "fanout") return createFanoutResolver(config, activeGraph);
	if (type === "conditional") return createConditionalResolver(config, activeGraph);
	if (type === "iterative") return createIterativeResolver(config, activeGraph);
	throw new Error("resolverType must be one of: fanout, conditional, iterative");
}

function createFanoutResolver(config: Record<string, unknown>, activeGraph: ActiveGraph): DependencyResolver {
	const itemsExpression = requireString(config.itemsExpression, "resolverConfig.itemsExpression");
	const idPrefix = requireNodeId(config.idPrefix, "resolverConfig.idPrefix");
	const task = requireString(config.task, "resolverConfig.task");
	const itemInputKey = requireString(config.itemInputKey, "resolverConfig.itemInputKey");
	const role = config.role !== undefined ? requireRole(config.role) : undefined;
	const toolHints = config.toolHints !== undefined ? requireStringArray(config.toolHints, "resolverConfig.toolHints") : undefined;
	const retry = config.retry !== undefined ? parseRetry(config.retry, "resolverConfig.retry") : undefined;

	return async (_nodeId, completedNodes, context) => {
		const value = activeGraph.engine.getDataFlowManager().evaluateExpression(itemsExpression, expressionContext(completedNodes, context));
		let items: unknown = value;
		if (typeof items === "string") {
			try {
				items = JSON.parse(items);
			} catch {
				throw new Error("fanout itemsExpression must resolve to a JSON array");
			}
		}
		if (!Array.isArray(items)) throw new Error("fanout itemsExpression must resolve to an array");

		return items.map((item, index) => {
			const id = `${idPrefix}-${index + 1}`;
			const globalKey = `fanout.${id}`;
			context.globalData.set(globalKey, normalizeDataFlowValue(item));
			return {
				id,
				task,
				...(role && { role }),
				...(toolHints && { toolHints }),
				...(retry && { retry }),
				inputMapping: { [itemInputKey]: `$${globalKey}` },
			};
		});
	};
}

function createConditionalResolver(config: Record<string, unknown>, activeGraph: ActiveGraph): DependencyResolver {
	const expression = requireString(config.expression, "resolverConfig.expression");
	const nodes = parseNodeConfigs(config.nodes, "resolverConfig.nodes");
	return async (_nodeId, completedNodes, context) => {
		const value = activeGraph.engine.getDataFlowManager().evaluateExpression(expression, expressionContext(completedNodes, context));
		return value ? nodes.map((node) => ({ ...node })) : [];
	};
}

function createIterativeResolver(config: Record<string, unknown>, activeGraph: ActiveGraph): DependencyResolver {
	const maxRounds = requirePositiveInteger(config.maxRounds, "resolverConfig.maxRounds");
	const approvalText = requireString(config.approvalText, "resolverConfig.approvalText");
	const reviseTask = requireString(config.reviseTask, "resolverConfig.reviseTask");
	const reviewTask = requireString(config.reviewTask, "resolverConfig.reviewTask");
	const idPrefix = requireNodeId(config.idPrefix, "resolverConfig.idPrefix");
	const reviseRole = config.reviseRole !== undefined ? requireRole(config.reviseRole) : undefined;
	const reviewRole = config.reviewRole !== undefined ? requireRole(config.reviewRole) : undefined;

	return createReflectionResolver(activeGraph.resolvers, {
		maxRounds,
		idPrefix,
		reviseRole,
		reviewRole,
		judge: (result) => ({ approved: result.content?.includes(approvalText) === true, feedback: result.content }),
		reviseTask: (round) => `${reviseTask} ${round}`,
		reviewTask: (round) => `${reviewTask} ${round}`,
	});
}

function expressionContext(completedNodes: ReadonlyMap<string, SubagentResult>, context: GraphComputationContext) {
	return { nodes: completedNodes, globalData: context.globalData };
}

function normalizeDataFlowValue(value: unknown): DataFlowValue {
	return value === undefined ? null : value as DataFlowValue;
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

function requireNodeId(value: unknown, property: string): string {
	const id = requireString(value, property);
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error(`${property} must be a node id containing only letters, numbers, underscores, or hyphens`);
	}
	return id;
}

function requireStringArray(value: unknown, property: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${property} entries must be non-empty strings`);
	}
	return value.map((item) => item.trim());
}

function requireStringRecord(value: unknown, property: string): Record<string, string> {
	const record = requireRecord(value);
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`${property}.${key} must be a non-empty string`);
		}
	}
	return record as Record<string, string>;
}

function requirePositiveInteger(value: unknown, property: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${property} must be a positive safe integer`);
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, property: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${property} must be a non-negative safe integer`);
	}
	return value;
}

const VALID_ROLES: ReadonlySet<string> = new Set(["explorer", "reviewer", "planner", "executor"]);

function requireRole(value: unknown): SubagentRoleId {
	if (typeof value !== "string" || !VALID_ROLES.has(value)) {
		throw new Error(`role must be one of: ${[...VALID_ROLES].join(", ")}`);
	}
	return value as SubagentRoleId;
}
