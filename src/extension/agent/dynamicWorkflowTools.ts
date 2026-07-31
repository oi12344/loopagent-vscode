import type { ReactAgentTool } from "./reactTypes";
import type { WorkflowOrchestrator } from "./workflowOrchestrator";
import type { DataFlowValue } from "./workflow/dataFlowManager";
import type { DynamicGraphDefinition, DynamicNodeConfig, DependencyResolver, GraphComputationContext } from "./workflow/dynamicGraphTypes";
import { createDynamicGraphEngine, DEFAULT_DYNAMIC_GRAPH_LIMITS, type DynamicGraphEngine } from "./workflow/dynamicGraphEngine";
import type { GraphDebugInfo } from "./workflow/graphVisualizer";
import { createReflectionResolver } from "./workflow/reflectionResolver";
import type { SubagentRoleId, SubagentResult } from "./workflow/types";
import type { CycleEdge } from "./workflow/cycleManager";
import { compileGeneratedWorkflow } from "./workflow/workflowCompiler";
import { parseGeneratedWorkflowPlan, type GeneratedWorkflowPlan } from "./workflow/generatedWorkflowTypes";

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

const CYCLE_EXIT_CONDITION_SCHEMA = {
	type: "object",
	properties: {
		type: {
			type: "string",
			enum: ["expression", "cost-limit", "time-limit"],
			description: "\"expression\" evaluates value against node results; \"cost-limit\" compares accumulated tokens; \"time-limit\" compares elapsed milliseconds.",
		},
		value: {
			description:
				"For type=expression: a string in the RESTRICTED expression language (see the tool description's EXPRESSION LANGUAGE section). "
				+ "Use exactly `<nodeId>.content.includes('text')`, optionally prefixed with `!`. "
				+ "The nodeId MUST be one of the ids you declared in initialNodes -- never invent a new id here. "
				+ "For type=cost-limit / time-limit: an integer.",
		},
		description: { type: "string", description: "Human-readable reason shown when this condition stops the cycle." },
		priority: { type: "string", enum: ["high", "medium", "low"] },
	},
	required: ["type", "value"],
};

const CYCLE_SCHEMA = {
	type: "object",
	description:
		"A cycle edge: when node `from` completes, node `to` is reset and re-run, until an exit condition holds. "
		+ "Both `from` and `to` MUST be ids declared in initialNodes. Typical shape: from=the fix node, to=the review node.",
	properties: {
		id: { type: "string", minLength: 1, description: "Unique label for this cycle, e.g. \"review-fix-loop\"." },
		from: { type: "string", minLength: 1, description: "Existing initialNodes id whose completion triggers a new round." },
		to: { type: "string", minLength: 1, description: "Existing initialNodes id that gets reset and re-run each round." },
		exit: {
			type: "object",
			properties: {
				hardLimit: { type: "integer", minimum: 1, description: "Absolute maximum rounds. Required. 3 is a sensible default." },
				breakWhen: {
					type: "array",
					description: "Conditions checked before each new round; any match stops the cycle.",
					items: CYCLE_EXIT_CONDITION_SCHEMA,
				},
				adaptive: {
					type: "object",
					description: "Optional automatic stop when rounds stop making progress or exceed a token budget.",
					properties: {
						detectNoProgress: { type: "boolean" },
						progressWindow: { type: "integer", minimum: 1, description: "How many recent rounds to compare, e.g. 2." },
						similarityThreshold: { type: "number", minimum: 0, maximum: 1, description: "Stop when round similarity exceeds this, e.g. 0.85." },
						costBudget: { type: "integer", minimum: 1 },
					},
					required: ["detectNoProgress", "progressWindow"],
				},
			},
			required: ["hardLimit"],
		},
	},
	required: ["id", "from", "to", "exit"],
};

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
		id: { type: "string", minLength: 1, description: "Stable identifier other nodes and expressions reference. Keep it short and hyphen-free where possible, e.g. \"review\"." },
		task: { type: "string", minLength: 1 },
		role: { type: "string", enum: ["explorer", "reviewer", "planner", "executor"] },
		dependsOn: { type: "array", items: { type: "string", minLength: 1 }, description: "Ids of other initialNodes in this same call." },
		toolHints: { type: "array", items: { type: "string", minLength: 1 } },
		timeoutMs: { type: "integer", minimum: 1 },
		inputMapping: { type: "object", additionalProperties: { type: "string" } },
		condition: {
			type: "object",
			properties: {
				type: { type: "string", enum: ["always", "onSuccess", "onFailure", "custom"] },
				expression: {
					type: "string",
					description: "Required when type=\"custom\". Restricted expression language -- see the tool description. Typical form: \"!review.content.includes('APPROVED')\".",
				},
			},
			required: ["type"],
		},
		exportTo: { type: "string", minLength: 1, description: "Write this node's content to global data under this key, readable elsewhere as \"$key\"." },
		retry: RETRY_SCHEMA,
	},
	required: ["id", "task"],
};

const SEMANTIC_NODE_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1 },
		task: { type: "string", minLength: 1 },
		role: NODE_SCHEMA.properties.role,
		after: { type: "array", items: { type: "string", minLength: 1 } },
		contextFrom: { type: "array", items: { type: "string", minLength: 1 } },
		reviews: { type: "array", maxItems: 1, items: { type: "string", minLength: 1 } },
	},
	required: ["id", "task"],
};

const RESOLVER_SCHEMA = {
	type: "object",
	description: "Expands the graph after `nodeId` completes. Prefer `cycles` over resolverType=iterative for review/fix loops -- cycles reuse existing nodes instead of generating new ids.",
	properties: {
		nodeId: { type: "string", minLength: 1, description: "Existing initialNodes id whose completion triggers this resolver." },
		resolverType: { type: "string", enum: ["fanout", "conditional", "iterative"] },
		resolverConfig: {
			type: "object",
			description: [
				"Which fields are REQUIRED depends on resolverType -- omitting one fails the whole call:",
				"  fanout      -> itemsExpression, idPrefix, task, itemInputKey",
				"  conditional -> expression, nodes",
				"  iterative   -> maxRounds, approvalText, reviseTask, reviewTask, idPrefix",
				"All other fields are optional. Nodes created by a resolver get generated ids, so they cannot be",
				"referenced from expressions written in this call.",
			].join("\n"),
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
			description: [
				"Create and execute a dynamic computation graph in one call, then return every node result.",
				"PREFERRED INPUT: nodes with after/contextFrom/reviews. The engine derives loop routes from reviewer state; do not emit cycles or expressions.",
				"A reviewer must return JSON {\"decision\":\"approve\"|\"revise\",\"feedback\":string[]}; revise returns to the reviewed node.",
				"LEGACY INPUT: initialNodes/resolvers/cycles remains accepted for compatibility only.",
				"Register fanout, conditional, or iterative expansion through the optional resolvers field.",
				"Use the optional cycles field for review->fix->review loops.",
				"",
				"EXPRESSION LANGUAGE (used by node.condition.expression and cycles[].exit.breakWhen[].value).",
				"This is NOT JavaScript. Only these forms parse; anything else fails the whole call:",
				"  <nodeId>.content                     -- that node's output text",
				"  <nodeId>.status                      -- \"completed\" | \"failed\" | \"cancelled\"",
				"  <nodeId>.content.includes('text')    -- substring test, quotes required",
				"  !<expr>                              -- negation",
				"  <expr> === 'value' | <expr> !== 'value'",
				"  <expr> >= 5 | > 5 | <= 5 | < 5",
				"  <exprA> && <exprB>",
				"  $globalKey                           -- a value written by another node's exportTo",
				"NOT supported -- do not write these: nodes.get('x'), optional chaining (?.),",
				".length, .match(), .trim(), template literals, cycleState.*, arrow functions, ||.",
				"",
				"NODE IDS: every id referenced in dependsOn, condition.expression, breakWhen[].value,",
				"cycles[].from and cycles[].to MUST be an id you declared in this call's initialNodes.",
				"Referencing an id you did not declare is the most common cause of failure.",
				"",
				"MINIMAL CYCLE EXAMPLE (copy this shape):",
				"  initialNodes: [",
				"    { id: \"write\",  task: \"...\", role: \"executor\" },",
				"    { id: \"review\", task: \"Reply exactly APPROVED if it passes, else list problems.\",",
				"      role: \"reviewer\", dependsOn: [\"write\"] },",
				"    { id: \"fix\",    task: \"...\", role: \"executor\", dependsOn: [\"review\"],",
				"      condition: { type: \"custom\", expression: \"!review.content.includes('APPROVED')\" } }",
				"  ],",
				"  cycles: [",
				"    { id: \"review-fix\", from: \"fix\", to: \"review\",",
				"      exit: { hardLimit: 3,",
				"              breakWhen: [{ type: \"expression\", value: \"review.content.includes('APPROVED')\" }] } }",
				"  ]",
				"",
				"Tell the reviewer node the exact sentinel string to emit, and match that same string in breakWhen,",
				"otherwise the loop can only ever end by hitting hardLimit.",
			].join("\n"),
			inputSchema: {
				type: "object",
				properties: {
					nodes: { type: "array", items: SEMANTIC_NODE_SCHEMA },
					entry: { type: "array", items: { type: "string", minLength: 1 } },
					initialState: { type: "object" },
					maxSteps: { type: "integer", minimum: 1 },
					initialNodes: {
						type: "array",
						items: NODE_SCHEMA,
					},
					resolvers: {
						type: "array",
						items: RESOLVER_SCHEMA,
					},
					cycles: {
						type: "array",
						items: CYCLE_SCHEMA,
					},
					initialGlobalData: { type: "object" },
					maxNodes: { type: "integer", minimum: 1 },
					maxDepth: { type: "integer", minimum: 1 },
					include: {
						type: "array",
						items: { type: "string", enum: ["visualization", "debug", "mermaid"] },
					},
				},
				required: [],
			},
			// The merged tool runs the whole graph, including executor nodes that write to the
			// workspace. Keep graph runs out of the same concurrent tool batch; the shared
			// workspace mutation lock still protects edits and approved commands.
			isConcurrencySafe: () => false,
			async invoke({ input }) {
				const record = requireRecord(input);
				const semanticPlan = record.nodes !== undefined
					? parseGeneratedWorkflowPlan({
						nodes: record.nodes,
						entry: record.entry,
						initialState: record.initialState,
						maxSteps: record.maxSteps,
					} as unknown as GeneratedWorkflowPlan)
					: undefined;
				const initialNodes = semanticPlan
					? semanticPlan.nodes.map((node) => ({
						id: node.id,
						task: node.task,
						role: node.role,
						dependsOn: node.after,
					}))
					: parseNodeConfigs(record.initialNodes);
				const maxNodes = record.maxNodes !== undefined ? requirePositiveInteger(record.maxNodes, "maxNodes") : undefined;
				const maxDepth = record.maxDepth !== undefined ? requirePositiveInteger(record.maxDepth, "maxDepth") : undefined;
				const initialGlobalData = record.initialGlobalData !== undefined
					? requireRecord(record.initialGlobalData) as Record<string, DataFlowValue>
					: undefined;
				const cycles = semanticPlan ? undefined : record.cycles !== undefined ? parseCycles(record.cycles) : undefined;
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
					initialNodes: semanticPlan ? [] : initialNodes,
					resolvers,
					cycles,
					maxNodes,
					maxDepth,
					initialGlobalData,
					compiledGraph: semanticPlan ? compileGeneratedWorkflow(semanticPlan) : undefined,
					initialState: semanticPlan?.initialState,
					maxSteps: semanticPlan?.maxSteps,
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
				let workflowStopReason: string | undefined;
				let workflowStep = 0;
				let workflowStateVersion = 0;
				// 两条执行路径都在 GraphCompleted 里汇报真实的失败与未到达节点；工具必须把它们
				// 透传给父智能体，否则“部分成功”会被当成整图成功。
				let failedNodeIds: readonly string[] = [];
				let unreachedNodeIds: readonly string[] = [];
				let graphCancelled = false;
				const dispose = engine.onEvent((event) => {
					if (event.type === "ResolverFailed") resolverFailures.push({ nodeId: event.nodeId, error: event.error });
					if (event.type === "StepStarted") workflowStep = event.step;
					if (event.type === "StateCommitted") workflowStateVersion = event.stateVersion;
					if (event.type === "GraphLimitExceeded") workflowStopReason = `${event.limit}:${event.value}`;
					if (event.type === "GraphCancelled") graphCancelled = true;
					if (event.type === "GraphCompleted") {
						failedNodeIds = event.failedNodes;
						unreachedNodeIds = event.unreachedNodes;
					}
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

					// 失败节点带上错误原文：只给 id 的话父智能体无法判断该重试、换路径还是上报。
					const failedNodes = failedNodeIds.map((nodeId) => ({
						nodeId,
						error: context.nodes.get(nodeId)?.result?.error ?? "unknown error",
					}));
					const workflowStatus = graphCancelled || cancelled
						? "cancelled"
						: failedNodes.length > 0 || unreachedNodeIds.length > 0
							? "failed"
							: "completed";

					const visualizer = engine.getVisualizer();
					return JSON.stringify({
						workflowStatus,
						nodes,
						totalNodes: context.nodes.size,
						statusCounts,
						completedNodes: Array.from(context.nodes.values())
							.filter((node) => node.status === "completed")
							.map((node) => node.config.id),
						failedNodes,
						unreachedNodes: [...unreachedNodeIds],
						results: Object.fromEntries(results),
						executionOrder: context.executionOrder,
						workflowState: {
							step: engine.getStateSnapshot()?.step ?? workflowStep,
							stateVersion: engine.getStateSnapshot()?.version ?? workflowStateVersion,
							executionOrder: context.executionOrder,
							stopReason: workflowStopReason,
						},
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

function parseCycles(value: unknown): CycleEdge[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("cycles must be an array");

	return value.map((item, index) => {
		const record = requireRecord(item);
		const path = `cycles[${index}]`;

		const id = requireString(record.id, `${path}.id`);
		const from = requireString(record.from, `${path}.from`);
		const to = requireString(record.to, `${path}.to`);
		const exitConfig = requireRecord(record.exit);

		const hardLimit = requirePositiveInteger(exitConfig.hardLimit, `${path}.exit.hardLimit`);

		// Parse breakWhen conditions
		const breakWhen = Array.isArray(exitConfig.breakWhen)
			? exitConfig.breakWhen.map((cond: any, i: number) => {
					const condRecord = requireRecord(cond);
					return {
						type: requireString(condRecord.type, `${path}.exit.breakWhen[${i}].type`) as any,
						value: condRecord.value,
						description: condRecord.description as string | undefined,
						priority: condRecord.priority as "high" | "medium" | "low" | undefined,
					};
			  })
			: undefined;

		// Parse adaptive config
		const adaptive = exitConfig.adaptive
			? (() => {
					const adaptiveRecord = requireRecord(exitConfig.adaptive);
					return {
						detectNoProgress: Boolean(adaptiveRecord.detectNoProgress),
						progressWindow: requirePositiveInteger(adaptiveRecord.progressWindow, `${path}.exit.adaptive.progressWindow`),
						similarityThreshold: typeof adaptiveRecord.similarityThreshold === "number"
							? adaptiveRecord.similarityThreshold
							: undefined,
						costBudget: typeof adaptiveRecord.costBudget === "number"
							? adaptiveRecord.costBudget
							: undefined,
					};
			  })()
			: undefined;

		// Parse interactive config
		const interactive = exitConfig.interactive
			? (() => {
					const interactiveRecord = requireRecord(exitConfig.interactive);
					return {
						askAfterRound: requirePositiveInteger(interactiveRecord.askAfterRound, `${path}.exit.interactive.askAfterRound`),
						showProgressSummary: Boolean(interactiveRecord.showProgressSummary),
					};
			  })()
			: undefined;

		return {
			id,
			from,
			to,
			exit: {
				hardLimit,
				breakWhen,
				adaptive,
				interactive,
			},
		};
	});
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
