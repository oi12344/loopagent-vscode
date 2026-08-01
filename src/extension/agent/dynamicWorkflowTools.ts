import type { ReactAgentTool } from "./reactTypes";
import type { WorkflowOrchestrator } from "./workflowOrchestrator";
import type { ConversationStore } from "../conversation/conversationStore";
import type { DataFlowValue } from "./workflow/dataFlowManager";
import type { DynamicGraphCheckpointSnapshot, DynamicGraphDefinition, DynamicNode, DynamicNodeConfig, DependencyResolver, GraphComputationContext } from "./workflow/dynamicGraphTypes";
import { createDynamicGraphEngine, DEFAULT_DYNAMIC_GRAPH_LIMITS, type DynamicGraphEngine } from "./workflow/dynamicGraphEngine";
import type { GraphDebugInfo } from "./workflow/graphVisualizer";
import { createReflectionResolver } from "./workflow/reflectionResolver";
import type { SubagentRoleId, SubagentResult } from "./workflow/types";
import { allowedRecoveryActions, classifyFailure, DEFAULT_RECOVERY_POLICY, parseRecoveryPlan, RecoveryPlanError, type FailureCategory, type RecoveryPlan } from "./workflow/workflowRecovery";
import type { CycleEdge } from "./workflow/cycleManager";
import { compileGeneratedWorkflow } from "./workflow/workflowCompiler";
import { parseGeneratedWorkflowPlan, type GeneratedWorkflowPlan } from "./workflow/generatedWorkflowTypes";
import {
	createPlanHash,
	type WorkflowCheckpoint,
	type WorkflowFailureEvidence,
	type WorkflowNodeCheckpointDefinition,
	type WorkflowNodeCheckpointStatus,
} from "../../shared/workflowCheckpoint";

type DynamicWorkflowToolsOptions = {
	orchestrator: WorkflowOrchestrator;
	availableTools: readonly ReactAgentTool[];
	signal?: AbortSignal;
	conversationId?: string;
	runId?: string;
	checkpointStore?: Pick<ConversationStore, "claimWorkflowCheckpoint" | "saveWorkflowCheckpoint" | "loadWorkflowCheckpoint" | "getWorkflowCheckpointRunId" | "clearWorkflowCheckpoint">;
};

type ActiveGraph = {
	engine: DynamicGraphEngine;
	resolvers: Map<string, DependencyResolver>;
	initialNodeIds: Set<string>;
};

type GraphInclude = "visualization" | "debug" | "mermaid";

type RecoveryDiagnostic = {
	nodeId: string;
	category: FailureCategory;
	action?: RecoveryPlan["action"];
	reason?: string;
	timeoutMs?: number;
	error?: string;
};

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

const OUTPUT_CONTRACT_SCHEMA = {
	type: "object",
	properties: {
		exactText: { type: "string", minLength: 1 },
		requiredText: { type: "string", minLength: 1 },
		requiredFields: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
		minLength: { type: "integer", minimum: 0 },
	},
	additionalProperties: false,
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
		outputContract: OUTPUT_CONTRACT_SCHEMA,
		sideEffect: { type: "string", enum: ["none", "applied", "unknown"], description: "副作用证据；executor 默认 unknown，避免恢复时盲目重复编辑或命令。" },
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
		timeoutMs: { type: "integer", minimum: 1 },
		outputContract: OUTPUT_CONTRACT_SCHEMA,
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
				sideEffect: { type: "string", enum: ["none", "applied", "unknown"] },
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

export function createDynamicWorkflowTools({ orchestrator, availableTools, signal, conversationId, runId, checkpointStore }: DynamicWorkflowToolsOptions): ReactAgentTool[] {
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
					resumeToken: { type: "string", description: "Opaque token returned for a previous resumable graph run." },
				},
				required: [],
			},
			// The merged tool runs the whole graph, including executor nodes that write to the
			// workspace. Keep graph runs out of the same concurrent tool batch; the shared
			// workspace mutation lock still protects edits and approved commands.
			isConcurrencySafe: () => false,
			async invoke({ input }) {
				const record = requireRecord(input);
				const requestedResumeToken = record.resumeToken === undefined ? undefined : requireString(record.resumeToken, "resumeToken");
				const parsedResumeToken = requestedResumeToken ? parseResumeToken(requestedResumeToken) : undefined;
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
						timeoutMs: node.timeoutMs,
						dependsOn: node.after,
						outputContract: node.outputContract,
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
					if (cycles) validateCycleEndpoints(cycles, initialNodes);
					const resolvers = new Map<string, DependencyResolver>();
					const activeGraph: ActiveGraph = {
						engine: undefined as unknown as DynamicGraphEngine,
						resolvers,
						initialNodeIds: new Set(initialNodes.map((node) => node.id)),
					};
					for (const entry of parseResolverEntries(record.resolvers)) {
						if (!activeGraph.initialNodeIds.has(entry.nodeId)) {
							throw new Error(`Resolver nodeId "${entry.nodeId}" is not an initial node`);
						}
						resolvers.set(entry.nodeId, createConfiguredResolver(entry.resolverType, entry.resolverConfig, activeGraph));
					}
					const compiledGraph = semanticPlan ? compileGeneratedWorkflow(semanticPlan) : undefined;
					const planHash = createPlanHash(compactForHash({
						kind: semanticPlan ? "semantic" : "legacy",
						semanticPlan,
						initialNodes,
						resolvers: record.resolvers,
						cycles,
						initialGlobalData,
						maxNodes,
						maxDepth,
						maxSteps: semanticPlan?.maxSteps,
						initialState: semanticPlan?.initialState,
					}));
					if (parsedResumeToken) {
						if (!conversationId || !runId || !checkpointStore) throw new Error("resumeToken cannot be used without a checkpoint context");
						if (parsedResumeToken.conversationId !== conversationId || parsedResumeToken.runId !== runId || parsedResumeToken.planHash !== planHash) {
							throw new Error("resumeToken does not match this workflow");
						}
					}
					const checkpointRunId = conversationId && runId && checkpointStore
						? checkpointStore.getWorkflowCheckpointRunId(conversationId)
						: undefined;
					const storedCheckpoint = conversationId && runId && checkpointStore
						? checkpointStore.loadWorkflowCheckpoint(conversationId, runId)
						: undefined;
					if (parsedResumeToken) {
						if (!storedCheckpoint || storedCheckpoint.revision !== parsedResumeToken.revision) {
							throw new Error("resumeToken is stale or no longer available");
						}
					}
					const resumeCheckpoint = storedCheckpoint?.planHash === planHash ? storedCheckpoint : undefined;
					if (conversationId && runId && checkpointStore) {
						const claimed = checkpointStore.claimWorkflowCheckpoint(
							conversationId,
							runId,
							planHash,
							checkpointRunId,
							resumeCheckpoint?.revision,
						);
						if (!claimed) {
							throw new Error(parsedResumeToken
								? "resumeToken is stale or no longer available"
								: "workflow checkpoint ownership changed before execution");
						}
					}

				const definition: DynamicGraphDefinition = {
					initialNodes: semanticPlan ? [] : initialNodes,
					resolvers,
					cycles,
					maxNodes,
					maxDepth,
					initialGlobalData,
					compiledGraph,
					initialState: semanticPlan?.initialState,
						maxSteps: semanticPlan?.maxSteps,
					};
					const nodes = initialNodes.map((node) => ({
						id: node.id,
						role: node.role ?? "explorer",
						dependsOn: node.dependsOn ?? [],
					}));
					const resolverFailures: Array<{ nodeId: string; error: string }> = [];
					const recoveryDiagnostics: RecoveryDiagnostic[] = (resumeCheckpoint?.recoveryDiagnostics ?? []).map((entry) => ({
						nodeId: entry.nodeId,
						category: entry.category as FailureCategory,
						action: entry.action as RecoveryPlan["action"] | undefined,
						reason: entry.reason,
						timeoutMs: entry.timeoutMs,
						error: entry.error,
					}));
					let workflowStopReason: string | undefined;
					let workflowStep = 0;
					let workflowStateVersion = 0;
					let failedNodeIds: readonly string[] = [];
					let unreachedNodeIds: readonly string[] = [];
					let graphCancelled = false;
					let checkpointRevision = resumeCheckpoint?.revision ?? 0;
					let checkpointSaveError: string | undefined;
					const saveSnapshot = async (snapshot: DynamicGraphCheckpointSnapshot): Promise<void> => {
						if (!checkpointStore || !conversationId || !runId) return;
						const checkpoint: WorkflowCheckpoint = {
							version: 1,
							conversationId,
							runId,
							planHash,
							revision: ++checkpointRevision,
							status: snapshot.status,
							frontier: snapshot.frontier,
							executionOrder: snapshot.executionOrder,
							nodes: Object.fromEntries([...snapshot.nodes].map(([nodeId, node]) => [nodeId, {
								nodeId,
								status: checkpointNodeStatus(node.status),
								inputHash: createPlanHash({ nodeId, task: node.config.task, context: compactForHash(node.context) }),
								attempts: node.attempts ?? 0,
								recoveryAttempts: node.recoveryAttempts ?? 0,
								...(node.pendingRecovery && { pendingRecovery: { ...node.pendingRecovery, contextFrom: node.pendingRecovery.contextFrom ? [...node.pendingRecovery.contextFrom] : undefined } }),
								definition: checkpointNodeDefinition(node),
								...(node.result && {
									result: {
										status: node.result.status,
										...(node.result.content !== undefined && { content: checkpointText(node.result.content) }),
										...(node.result.error !== undefined && { error: checkpointText(node.result.error, 2_000) }),
									},
								}),
								sideEffect: node.config.sideEffect ?? (node.config.role === "executor" ? "unknown" : "none"),
							}])),
							state: {
								step: snapshot.state?.step ?? workflowStep,
								version: snapshot.state?.version ?? workflowStateVersion,
								values: compactCheckpointValue(Object.fromEntries(snapshot.state?.values ?? [])) as Record<string, unknown>,
							},
							unresolvedFailures: [
								...resolverFailures.map((entry) => ({ nodeId: entry.nodeId, code: "resolver_failed", message: checkpointText(entry.error, 2_000) })),
								...([...snapshot.nodes].filter(([, node]) => node.status === "failed" || node.result?.status === "failed").map(([nodeId, node]) => ({
									nodeId,
									code: classifyNodeFailure(nodeId, node.config.role, node.result?.error, node.config.sideEffect),
									message: checkpointText(node.result?.error ?? "node failed", 2_000),
									attempt: node.attempts ?? 0,
									timeoutMs: node.lastAttemptTimeoutMs ?? node.config.timeoutMs,
									logs: node.result?.diagnosticLog ? [...node.result.diagnosticLog] : undefined,
									input: compactCheckpointValue(redactRecoveryValue(node.context ?? {})) as Record<string, unknown>,
								}))),
							],
							recoveryDiagnostics: recoveryDiagnostics.slice(-32),
							updatedAt: Date.now(),
						};
						try {
							if (!checkpointStore.saveWorkflowCheckpoint(checkpoint)) checkpointSaveError = "checkpoint was rejected as stale";
							else checkpointSaveError = undefined;
						} catch (error) {
							checkpointSaveError = error instanceof Error ? error.message : "checkpoint could not be saved";
						}
					};
					let engine!: DynamicGraphEngine;
					const recoverFailure = async (evidence: WorkflowFailureEvidence): Promise<RecoveryPlan | undefined> => {
						const failedNode = engine.getContext().nodes.get(evidence.nodeId);
						const category = classifyNodeFailure(
							evidence.nodeId,
							failedNode?.config.role,
							evidence.error,
							failedNode?.config.sideEffect,
						);
						const plannerId = orchestrator.createSubagent(
							{
								task: buildRecoveryDiagnosisTask(evidence, category, [...engine.getContext().nodes.keys()]),
								role: "planner",
							},
							availableTools,
						);
						const plannerResult = (await orchestrator.waitForSubagents([plannerId])).get(plannerId);
						if (!plannerResult || plannerResult.status !== "completed" || !plannerResult.content) {
							recoveryDiagnostics.push({ nodeId: evidence.nodeId, category, error: checkpointText(plannerResult?.error ?? "Recovery diagnosis did not return a plan", 2_000) });
							return undefined;
						}
						try {
							const parsedCandidate = parseRecoveryJson(plannerResult.content);
							const candidate = isRecoveryRecord(parsedCandidate) && parsedCandidate.action === "retry" && typeof parsedCandidate.task === "string" && parsedCandidate.task.trim()
								? { ...parsedCandidate, action: "replace_node" }
								: parsedCandidate;
							let plan: RecoveryPlan;
							try {
								plan = parseRecoveryPlan(candidate, {
									category,
									failedNodeId: evidence.nodeId,
									knownNodeIds: [...engine.getContext().nodes.keys()],
									attempt: evidence.recoveryAttempt,
									hasSideEffect: evidence.sideEffect !== "none",
									failedRole: failedNode?.config.role,
								});
							} catch (error) {
								// reason is diagnostic metadata only; cap an overlong model explanation
								// while keeping action/task/target validation strict.
								if (!(error instanceof RecoveryPlanError) || error.path !== "recovery.reason" || !isRecoveryRecord(candidate) || typeof candidate.reason !== "string") {
									throw error;
								}
								plan = parseRecoveryPlan({
									...candidate,
									reason: redactRecoveryText(candidate.reason.slice(0, DEFAULT_RECOVERY_POLICY.maxReasonChars).trim()),
								}, {
								category,
								failedNodeId: evidence.nodeId,
								knownNodeIds: [...engine.getContext().nodes.keys()],
								attempt: evidence.recoveryAttempt,
								hasSideEffect: evidence.sideEffect !== "none",
								failedRole: failedNode?.config.role,
								});
							}
							const safePlan = { ...plan, reason: redactRecoveryText(plan.reason) };
							const diagnostic: RecoveryDiagnostic = {
								nodeId: evidence.nodeId,
								category,
								action: safePlan.action,
								reason: safePlan.reason,
								timeoutMs: safePlan.timeoutMs,
							};
							recoveryDiagnostics.push(diagnostic);
							if (!["retry", "replace_node", "replace_tool", "replan"].includes(safePlan.action)) {
								diagnostic.error = `Recovery action '${safePlan.action}' is diagnostic-only and requires explicit follow-up`;
								return undefined;
							}
							if (safePlan.action === "replan" && safePlan.targetNodeId !== evidence.nodeId) {
								diagnostic.error = "Graph-level replan requires a new workflow invocation";
								return undefined;
							}
							return safePlan;
						} catch (error) {
							recoveryDiagnostics.push({ nodeId: evidence.nodeId, category, error: checkpointText(error instanceof Error ? error.message : "Invalid recovery plan", 2_000) });
							return undefined;
						}
					};
					engine = createDynamicGraphEngine({
						definition,
						orchestrator,
						availableTools,
						signal,
						resume: resumeCheckpoint ? { checkpoint: resumeCheckpoint } : undefined,
						onCheckpoint: saveSnapshot,
						recoverFailure,
					});
					activeGraph.engine = engine;
					// 两条执行路径都在 GraphCompleted 里汇报真实的失败与未到达节点；工具必须把它们
					// 透传给父智能体，否则“部分成功”会被当成整图成功。
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
						error: checkpointText(context.nodes.get(nodeId)?.result?.error ?? "unknown error", 2_000),
						category: classifyNodeFailure(
							nodeId,
							context.nodes.get(nodeId)?.config.role,
							context.nodes.get(nodeId)?.result?.error,
							context.nodes.get(nodeId)?.config.sideEffect,
						),
						sideEffect: context.nodes.get(nodeId)?.config.sideEffect
							?? (context.nodes.get(nodeId)?.config.role === "executor" ? "unknown" : "none"),
						diagnosticLog: context.nodes.get(nodeId)?.result?.diagnosticLog ?? [],
					}));
					const hasUnknownSideEffect = failedNodeIds.some((nodeId) => {
						const node = context.nodes.get(nodeId);
						const sideEffect = node?.config.sideEffect ?? (node?.config.role === "executor" ? "unknown" : "none");
						return sideEffect !== "none";
					});
					const hasExhaustedRetryBudget = failedNodeIds.some((nodeId) => {
						const node = context.nodes.get(nodeId);
						const sideEffect = node?.config.sideEffect ?? (node?.config.role === "executor" ? "unknown" : "none");
						const maxAttempts = sideEffect === "none" ? Math.max(1, node?.config.retry?.maxAttempts ?? 1) : 1;
						return (node?.attempts ?? 0) >= maxAttempts;
					});
					const hasFailedRecovery = failedNodeIds.some((nodeId) => recoveryDiagnostics.some((entry) => entry.nodeId === nodeId));
					const workflowStatus = graphCancelled || cancelled
						? "cancelled"
						: hasUnknownSideEffect || hasExhaustedRetryBudget || hasFailedRecovery
							? "recovery_required"
							: failedNodes.length > 0 || unreachedNodeIds.length > 0 || resolverFailures.length > 0
							? "failed"
							: "completed";
					const unresolvedFailures = [
						...resolverFailures.map((entry) => ({ nodeId: entry.nodeId, code: "resolver_failed", message: checkpointText(entry.error, 2_000) })),
						...failedNodes.map((entry) => ({ nodeId: entry.nodeId, code: entry.category, message: entry.error })),
					];
					if (workflowStatus === "recovery_required" && checkpointStore && conversationId && runId) {
						const latest = checkpointStore.loadWorkflowCheckpoint(conversationId, runId);
						if (latest) {
							checkpointRevision = latest.revision + 1;
							try {
								if (!checkpointStore.saveWorkflowCheckpoint({ ...latest, revision: checkpointRevision, status: "recovery_required", updatedAt: Date.now() })) {
									checkpointSaveError = "checkpoint was rejected as stale";
								} else checkpointSaveError = undefined;
							} catch (error) {
								checkpointSaveError = error instanceof Error ? error.message : "checkpoint could not be saved";
							}
						}
					}
					const resumeToken = checkpointStore && conversationId && runId && !checkpointSaveError && workflowStatus !== "completed"
						? createResumeToken(conversationId, runId, planHash, checkpointRevision)
						: undefined;
					if (workflowStatus === "completed" && conversationId && runId) {
						checkpointStore?.clearWorkflowCheckpoint(conversationId, runId);
					}

					const visualizer = engine.getVisualizer();
					return JSON.stringify({
						workflowStatus,
						planHash,
						...(resumeToken && { resumeToken }),
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
						recoveryDiagnostics,
						unresolvedFailures,
						...(checkpointSaveError && { checkpointError: checkpointSaveError }),
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

function buildRecoveryDiagnosisTask(evidence: WorkflowFailureEvidence, category: FailureCategory, knownNodeIds: readonly string[]): string {
	const allowedActions = allowedRecoveryActions(category, {
		hasSideEffect: evidence.sideEffect !== "none",
		attempt: evidence.recoveryAttempt,
	});
	const safeEvidence = {
		...evidence,
		task: redactRecoveryText(evidence.task),
		error: redactRecoveryText(evidence.error),
		input: redactRecoveryValue(evidence.input),
		logs: evidence.logs.map((log) => ({ ...log, message: redactRecoveryText(log.message) })),
	};
	return [
		"WORKFLOW_RECOVERY_DIAGNOSIS",
		`allowedRecoveryActions=${allowedActions.join(",")}`,
		"只分析失败证据，不执行任何工具或修改工作区。返回一个严格 JSON 对象，不要 Markdown。",
		"targetNodeId 必须是失败节点；上面的 allowedRecoveryActions 是当前分类和预算允许的动作。",
		`若可以安全修复，replace_node/replace_tool/replan 必须给出短 task；否则使用合适的诊断动作。reason 说明根因且不超过 ${DEFAULT_RECOVERY_POLICY.maxReasonChars} 个字符。`,
		"修复 task 必须直接产出 failure evidence 中 outputContract 要求的数据，不要搜索工作区来证明标记是否存在。",
		"timeoutMs 可选且最大 60000；若失败原因是 timeout，修复动作必须给出 timeoutMs=60000。",
		"示例：{\"action\":\"replace_node\",\"targetNodeId\":\"failed-id\",\"reason\":\"timeout\",\"task\":\"完成原节点输出契约\",\"timeoutMs\":60000}",
		`failureCategory=${category}`,
		`knownNodeIds=${JSON.stringify(knownNodeIds)}`,
		JSON.stringify(safeEvidence),
	].join("\n");
}

function parseRecoveryJson(content: string): unknown {
	if (content.length > 8_000) throw new Error("Recovery plan response is too large");
	const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	return JSON.parse(normalized);
}

function isRecoveryRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactRecoveryText(value: string): string {
	return value
		.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
		.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function redactRecoveryValue(value: unknown): unknown {
	if (typeof value === "string") return redactRecoveryText(value);
	if (Array.isArray(value)) return value.map(redactRecoveryValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactRecoveryValue(child)]));
	}
	return value;
}

const MAX_CHECKPOINT_TEXT_CHARS = 8_192;

function checkpointText(value: string, maxChars = MAX_CHECKPOINT_TEXT_CHARS): string {
	const redacted = redactRecoveryText(value);
	return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}...[truncated]` : redacted;
}

function compactCheckpointValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[truncated]";
	if (typeof value === "string") return checkpointText(value);
	if (Array.isArray(value)) return value.slice(0, 64).map((entry) => compactCheckpointValue(entry, depth + 1));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 64).map(([key, entry]) => [key, compactCheckpointValue(entry, depth + 1)]));
	}
	return value;
}

function checkpointNodeDefinition(node: DynamicNode): WorkflowNodeCheckpointDefinition {
	const config = node.config;
	return {
		task: checkpointText(config.task, 4_000),
		...(config.role && { role: config.role }),
		...(config.toolHints && { toolHints: [...config.toolHints] }),
		dependsOn: [...node.dependencies],
		timeoutMs: config.timeoutMs,
		sideEffect: config.sideEffect ?? (config.role === "executor" ? "unknown" : "none"),
		...(config.exportTo && { exportTo: config.exportTo }),
		...(config.inputMapping && { inputMapping: Object.fromEntries(Object.entries(config.inputMapping).map(([key, value]) => [key, checkpointText(value, 1_000)])) }),
		...(config.condition && { condition: { ...config.condition } }),
		...(config.retry && { retry: { ...config.retry } }),
		...(config.outputContract && {
			outputContract: {
				...(config.outputContract.exactText !== undefined && { exactText: checkpointText(config.outputContract.exactText, 1_000) }),
				...(config.outputContract.requiredText !== undefined && { requiredText: checkpointText(config.outputContract.requiredText, 1_000) }),
				...(config.outputContract.requiredFields !== undefined && { requiredFields: [...config.outputContract.requiredFields] }),
				...(config.outputContract.minLength !== undefined && { minLength: config.outputContract.minLength }),
			},
		}),
	};
}

function formatStatusCounts(statusCounts: Record<string, number>): string {
	const entries = Object.entries(statusCounts);
	return entries.length > 0 ? entries.map(([status, count]) => `${status}: ${count}`).join(", ") : "no nodes";
}

function checkpointNodeStatus(status: DynamicNode["status"]): WorkflowNodeCheckpointStatus {
	return status === "ready" || status === "pending-retry" ? "pending" : status;
}

function compactForHash(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compactForHash);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.map(([key, entry]) => [key, compactForHash(entry)]),
		);
	}
	return value;
}

function createResumeToken(conversationId: string, runId: string, planHash: string, revision: number): string {
	return Buffer.from(JSON.stringify({ version: 1, conversationId, runId, planHash, revision }), "utf8").toString("base64url");
}

function parseResumeToken(value: string): { conversationId: string; runId: string; planHash: string; revision: number } {
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("resumeToken is malformed");
	}
	const token = requireRecord(decoded);
	if (token.version !== 1) throw new Error("resumeToken version is unsupported");
	return {
		conversationId: requireString(token.conversationId, "resumeToken.conversationId"),
		runId: requireString(token.runId, "resumeToken.runId"),
		planHash: requireString(token.planHash, "resumeToken.planHash"),
		revision: requireNonNegativeInteger(token.revision, "resumeToken.revision"),
	};
}

function validateCycleEndpoints(cycles: readonly CycleEdge[], initialNodes: readonly DynamicNodeConfig[]): void {
	const ids = new Set(initialNodes.map((node) => node.id));
	for (const cycle of cycles) {
		if (!ids.has(cycle.from)) throw new Error(`Cycle "${cycle.id}" from "${cycle.from}" is not an initial node`);
		if (!ids.has(cycle.to)) throw new Error(`Cycle "${cycle.id}" to "${cycle.to}" is not an initial node`);
	}
}

function classifyNodeFailure(
	nodeId: string,
	role: SubagentRoleId | undefined,
	error: unknown,
	sideEffect: "none" | "applied" | "unknown" | undefined,
): FailureCategory {
	const outcome = sideEffect ?? (role === "executor" ? "unknown" : "none");
	return classifyFailure({ nodeId, role, error, sideEffect: { outcome } });
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
		const outputContract = record.outputContract !== undefined ? parseOutputContract(record.outputContract, `${path}.outputContract`) : undefined;
		const sideEffect = record.sideEffect !== undefined ? requireSideEffect(record.sideEffect, `${path}.sideEffect`) : undefined;

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
			...(outputContract && { outputContract }),
			...(sideEffect && { sideEffect }),
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
	const sideEffect = config.sideEffect !== undefined ? requireSideEffect(config.sideEffect, "resolverConfig.sideEffect") : undefined;

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
				...(sideEffect && { sideEffect }),
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

function parseOutputContract(value: unknown, property: string): NonNullable<DynamicNodeConfig["outputContract"]> {
	const record = requireRecord(value);
	const exactText = record.exactText !== undefined ? requireString(record.exactText, `${property}.exactText`) : undefined;
	const requiredText = record.requiredText !== undefined ? requireString(record.requiredText, `${property}.requiredText`) : undefined;
	const requiredFields = record.requiredFields !== undefined ? requireStringArray(record.requiredFields, `${property}.requiredFields`) : undefined;
	const minLength = record.minLength !== undefined ? requireNonNegativeInteger(record.minLength, `${property}.minLength`) : undefined;
	if (exactText === undefined && requiredText === undefined && requiredFields === undefined && minLength === undefined) {
		throw new Error(`${property} must define exactText, requiredText, requiredFields, or minLength`);
	}
	return {
		...(exactText !== undefined && { exactText }),
		...(requiredText !== undefined && { requiredText }),
		...(requiredFields !== undefined && { requiredFields }),
		...(minLength !== undefined && { minLength }),
	};
}

function requireSideEffect(value: unknown, property: string): "none" | "applied" | "unknown" {
	if (value !== "none" && value !== "applied" && value !== "unknown") {
		throw new Error(`${property} must be one of: none, applied, unknown`);
	}
	return value;
}
