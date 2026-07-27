import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDynamicGraphEngine } from "../src/extension/agent/workflow/dynamicGraphEngine";
import { createWorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
import { createDataFlowManager } from "../src/extension/agent/workflow/dataFlowManager";
import { createReflectionResolver } from "../src/extension/agent/workflow/reflectionResolver";
import type { DynamicGraphDefinition, DynamicNodeConfig } from "../src/extension/agent/workflow/dynamicGraphTypes";
import type { SubagentResult } from "../src/extension/agent/workflow/types";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";

describe("Dynamic Graph Workflow Integration", () => {
	let mockTools: ReactAgentTool[];
	let mockRunnerFactory: any;

	beforeEach(() => {
		mockTools = [
			{
				name: "readFile",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
				isConcurrencySafe: () => true,
				invoke: vi.fn().mockResolvedValue("file content"),
			},
			{
				name: "writeFile",
				description: "Write a file",
				inputSchema: { type: "object", properties: {} },
				isConcurrencySafe: () => true,
				invoke: vi.fn().mockResolvedValue("written"),
			},
		];

		mockRunnerFactory = vi.fn().mockResolvedValue({
			run: async function* () {
				yield { type: "assistantDelta", content: "test result" };
			},
		});
	});

	it("should execute a simple linear graph", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
			limits: { maxSubagentsPerRun: 10, maxNestingDepth: 5, maxConcurrentSubagents: 3, subagentTimeoutMs: 5000 },
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "node1", task: "Read input file" },
				{ id: "node2", task: "Process data", inputMapping: { input: "node1.content" } },
				{ id: "node3", task: "Write output", inputMapping: { data: "node2.content" } },
			],
		};

		// Manually set up dependencies
		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const results = await engine.execute();

		expect(results.size).toBeGreaterThan(0);
		expect(mockRunnerFactory).toHaveBeenCalled();
	});

	it("should handle conditional execution based on node results", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "validate", task: "Validate input" },
				{
					id: "processSuccess",
					task: "Process on success",
					condition: { type: "onSuccess" },
				},
				{
					id: "processFailure",
					task: "Handle failure",
					condition: { type: "onFailure" },
				},
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const results = await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.size).toBe(3);
	});

	it("should track data flow between nodes", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "source", task: "Generate data" },
				{
					id: "transform",
					task: "Transform data",
					inputMapping: { sourceData: "source.content" },
				},
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const dataFlowManager = engine.getDataFlowManager();
		const flowHistory = dataFlowManager.getFlowHistory();

		expect(flowHistory.length).toBeGreaterThan(0);
		const inputRecords = flowHistory.filter((r) => r.source === "input");
		const outputRecords = flowHistory.filter((r) => r.source === "output");

		expect(inputRecords.length).toBeGreaterThan(0);
		expect(outputRecords.length).toBeGreaterThan(0);
	});

	it("should generate visualization with nodes and edges", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "a", task: "Task A" },
				{ id: "b", task: "Task B" },
				{ id: "c", task: "Task C" },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const visualizer = engine.getVisualizer();
		const visualization = visualizer.generateVisualization();

		expect(visualization.nodes.length).toBe(3);
		expect(visualization.stats.totalNodes).toBe(3);
		expect(visualization.timeline.length).toBeGreaterThan(0);
	});

	it("should export graph to Mermaid format", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "start", task: "Start process" },
				{ id: "end", task: "End process" },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const visualizer = engine.getVisualizer();
		const mermaid = visualizer.exportToMermaid();

		expect(mermaid).toContain("graph TD");
		expect(mermaid).toContain("start");
		expect(mermaid).toContain("end");
		expect(mermaid).toContain("classDef");
	});

	it("should identify critical path in execution", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "step1", task: "Step 1" },
				{ id: "step2", task: "Step 2" },
				{ id: "step3", task: "Step 3" },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const visualizer = engine.getVisualizer();
		const debugInfo = visualizer.generateDebugInfo();

		expect(debugInfo.criticalPath).toBeDefined();
		expect(debugInfo.executionOrder).toBeDefined();
		expect(debugInfo.nodeDetails.size).toBe(3);
	});

	it("should respect max nodes limit", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const nodes: DynamicNodeConfig[] = [];
		for (let i = 0; i < 10; i++) {
			nodes.push({ id: `node${i}`, task: `Task ${i}` });
		}

		const definition: DynamicGraphDefinition = {
			initialNodes: nodes,
			maxNodes: 5,
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await expect(engine.execute()).rejects.toThrow(/maximum nodes/i);
	});

	it("should respect max depth limit", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "level1", task: "Level 1" },
				{ id: "level2", task: "Level 2", dependsOn: ["level1"] },
				{ id: "level3", task: "Level 3", dependsOn: ["level2"] },
				{ id: "level4", task: "Level 4", dependsOn: ["level3"] },
			],
			maxDepth: 2,
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await expect(engine.execute()).rejects.toThrow(/maximum depth/i);
	});

	it("should execute a dependsOn chain among initial nodes in dependency order (T5)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "c", task: "Step C", dependsOn: ["b"] },
				{ id: "a", task: "Step A" },
				{ id: "b", task: "Step B", dependsOn: ["a"] },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.executionOrder).toEqual(["a", "b", "c"]);
	});

	it("should reject a circular dependsOn declaration among initial nodes (T5)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "a", task: "Step A", dependsOn: ["b"] },
				{ id: "b", task: "Step B", dependsOn: ["a"] },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await expect(engine.execute()).rejects.toThrow(/circular/i);
	});

	it("should reject an initial node referencing an unknown dependsOn id (T5)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "a", task: "Step A", dependsOn: ["ghost"] }],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await expect(engine.execute()).rejects.toThrow(/not a known initial node/i);
	});

	it("should mark in-flight nodes cancelled and emit GraphCancelled instead of GraphCompleted (T8)", async () => {
		const runnerFactory = vi.fn().mockImplementation(async () => ({
			run: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 100));
				yield { type: "assistantDelta", content: "done" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "task1", task: "Long running task" },
				{ id: "task2", task: "Another task" },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const events: Array<{ type: string }> = [];
		engine.onEvent((event) => events.push(event));

		setTimeout(() => engine.cancel(), 10);

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.size).toBeGreaterThan(0);
		expect(context.nodes.get("task1")?.status).toBe("cancelled");
		expect(context.nodes.get("task2")?.status).toBe("cancelled");
		expect(events.some((event) => event.type === "GraphCancelled")).toBe(true);
		expect(events.some((event) => event.type === "GraphCompleted")).toBe(false);
	});

	it("should inject upstream node data into downstream subagent task (T1)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		// Reference by inputMapping alone does not create an execution-order dependency;
		// only a resolver-created (or, once T5 lands, dependsOn-declared) edge guarantees
		// "source" has actually finished before "transform" is evaluated.
		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "source", task: "Generate data" }],
			resolvers: new Map([
				[
					"source",
					async () => [{ id: "transform", task: "Transform data", inputMapping: { sourceData: "source.content" } }],
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const transformCall = mockRunnerFactory.mock.calls.find(([input]: [{ task: string }]) => input.task.startsWith("Transform data"));
		expect(transformCall).toBeDefined();
		const [transformInput] = transformCall as [{ task: string }];
		expect(transformInput.task).toContain("test result");
		expect(transformInput.task).toContain('trust="untrusted"');
		expect(transformInput.task).toContain("sourceData");

		const sourceCall = mockRunnerFactory.mock.calls.find(([input]: [{ task: string }]) => input.task === "Generate data");
		expect(sourceCall).toBeDefined();
	});

	it("should truncate oversized upstream data before injecting into task (T1)", async () => {
		const hugeContent = "x".repeat(10_000);
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				yield { type: "assistantDelta", content: task === "Generate data" ? hugeContent : "downstream result" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "source", task: "Generate data" }],
			resolvers: new Map([
				[
					"source",
					async () => [{ id: "transform", task: "Transform data", inputMapping: { sourceData: "source.content" } }],
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const transformCall = runnerFactory.mock.calls.find(([input]: [{ task: string }]) => input.task.startsWith("Transform data"));
		expect(transformCall).toBeDefined();
		const [transformInput] = transformCall as [{ task: string }];
		expect(transformInput.task).toContain("...[truncated]");
		expect(transformInput.task.length).toBeLessThan(hugeContent.length);
	});

	it("should execute node when custom condition expression is truthy (T2)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "check", task: "Check status" }],
			resolvers: new Map([
				[
					"check",
					async () => [
						{ id: "gated", task: "Runs only if check completed", condition: { type: "custom", expression: "check.status" } },
					],
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("gated")?.status).toBe("completed");
	});

	it("should skip node when custom condition expression is falsy (T2)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "check", task: "Check status" }],
			resolvers: new Map([
				[
					"check",
					async () => [
						{
							id: "gated",
							task: "Runs only if check produced a match",
							condition: { type: "custom", expression: "check.content[99]" },
						},
					],
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("gated")?.status).toBe("skipped");
	});

	it("should skip node when custom condition has no expression (T2)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "check", task: "Check status" }],
			resolvers: new Map([["check", async () => [{ id: "gated", task: "Misconfigured gate", condition: { type: "custom" } }]]]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("gated")?.status).toBe("skipped");
	});

	it("should mark unconditional downstream node unreachable and run onFailure node when a dependency fails (T3)", async () => {
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				if (task === "Step A") {
					yield { type: "runFailed", message: "boom" };
					return;
				}
				yield { type: "assistantDelta", content: "ok" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "a", task: "Step A" }],
			resolvers: new Map([
				[
					"a",
					async () => [
						{ id: "b", task: "Step B (no condition)" },
						{ id: "c", task: "Step C (onFailure)", condition: { type: "onFailure" } },
					],
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const events: Array<{ type: string; failedNodes?: string[]; unreachedNodes?: string[] }> = [];
		engine.onEvent((event) => events.push(event));

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("a")?.status).toBe("failed");
		expect(context.nodes.get("b")?.status).toBe("skipped");
		expect(context.nodes.get("c")?.status).toBe("completed");

		const completedEvent = events.find((event) => event.type === "GraphCompleted");
		expect(completedEvent?.failedNodes).toEqual(["a"]);
		expect(completedEvent?.unreachedNodes).toEqual([]);
	});

	it("should emit ResolverFailed and preserve the node's own result when its resolver throws (T4)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "source", task: "Generate data" }],
			resolvers: new Map([
				[
					"source",
					async () => {
						throw new Error("resolver blew up");
					},
				],
			]),
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const events: Array<{ type: string; nodeId?: string; error?: string }> = [];
		engine.onEvent((event) => events.push(event));

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("source")?.status).toBe("completed");

		const resolverFailedEvent = events.find((event) => event.type === "ResolverFailed");
		expect(resolverFailedEvent).toBeDefined();
		expect(resolverFailedEvent?.nodeId).toBe("source");
		expect(resolverFailedEvent?.error).toContain("resolver blew up");
	});

	it("should launch downstream nodes as soon as their own dependency finishes, without waiting for slower sibling branches (T6)", async () => {
		const log: string[] = [];
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				if (task === "Step B") {
					log.push("b-start");
					await new Promise((resolve) => setTimeout(resolve, 30));
					log.push("b-done");
					yield { type: "assistantDelta", content: "b" };
					return;
				}
				if (task === "Step C") {
					log.push("c-start");
					log.push("c-done");
					yield { type: "assistantDelta", content: "c" };
					return;
				}
				if (task === "Step E") {
					log.push("e-start");
					yield { type: "assistantDelta", content: "e" };
					return;
				}
				yield { type: "assistantDelta", content: "ok" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "a", task: "Step A" },
				{ id: "b", task: "Step B", dependsOn: ["a"] },
				{ id: "c", task: "Step C", dependsOn: ["a"] },
				{ id: "e", task: "Step E", dependsOn: ["c"] },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const bDoneIndex = log.indexOf("b-done");
		const eStartIndex = log.indexOf("e-start");
		expect(bDoneIndex).toBeGreaterThanOrEqual(0);
		expect(eStartIndex).toBeGreaterThanOrEqual(0);
		expect(eStartIndex).toBeLessThan(bDoneIndex);
	});

	it("should make initialGlobalData and setGlobalData visible to node inputMapping via $var (T7)", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "consumer", task: "Consume config", inputMapping: { region: "$region", tier: "$tier" } }],
			initialGlobalData: { region: "us-east" },
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		engine.setGlobalData("tier", "gold");

		await engine.execute();

		const context = engine.getContext();
		expect(context.nodes.get("consumer")?.context).toEqual({ region: "us-east", tier: "gold" });
	});

	it("should export a completed node's content into globalData for a sibling to read via $var (T7)", async () => {
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				yield { type: "assistantDelta", content: task === "Compute total" ? "42" : "ok" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "compute", task: "Compute total", exportTo: "total" },
				{ id: "report", task: "Report total", dependsOn: ["compute"], inputMapping: { total: "$total" } },
			],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();

		const context = engine.getContext();
		expect(context.globalData.get("total")).toBe("42");
		expect(context.nodes.get("report")?.context).toEqual({ total: "42" });
	});

	it("should retry a failing node up to maxAttempts and record the attempt count (T9)", async () => {
		let callCount = 0;
		const runnerFactory = vi.fn().mockImplementation(async () => ({
			run: async function* () {
				callCount++;
				if (callCount === 1) {
					yield { type: "runFailed", message: "flaky failure" };
					return;
				}
				yield { type: "assistantDelta", content: "recovered" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "flaky", task: "Flaky step", retry: { maxAttempts: 3, backoffMs: 5 } }],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("flaky")?.status).toBe("completed");
		expect(context.nodes.get("flaky")?.attempts).toBe(2);
		expect(callCount).toBe(2);
	});

	it("should exhaust retries and report failed once maxAttempts is reached (T9)", async () => {
		const runnerFactory = vi.fn().mockImplementation(async () => ({
			run: async function* () {
				yield { type: "runFailed", message: "always fails" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const definition: DynamicGraphDefinition = {
			initialNodes: [{ id: "doomed", task: "Doomed step", retry: { maxAttempts: 2 } }],
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.get("doomed")?.status).toBe("failed");
		expect(context.nodes.get("doomed")?.attempts).toBe(2);
	});

	it("should converge a reflection loop once the review approves, without a real cycle in the graph (T10)", async () => {
		const capturedTasks: string[] = [];
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				capturedTasks.push(task);
				const reviewMatch = task.match(/^Review round (\d+)/);
				if (reviewMatch) {
					const round = Number(reviewMatch[1]);
					yield { type: "assistantDelta", content: round >= 3 ? "APPROVED" : "REJECTED: needs more detail" };
					return;
				}
				yield { type: "assistantDelta", content: "draft" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const resolvers = new Map();
		const reflectionResolver = createReflectionResolver(resolvers, {
			maxRounds: 5,
			judge: (result) => ({ approved: result.content === "APPROVED", feedback: result.content }),
			reviseTask: (round, verdict) => `Revise round ${round}: address "${verdict.feedback}"`,
			reviewTask: (round) => `Review round ${round}`,
		});
		resolvers.set("review-1", reflectionResolver);

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "execute", task: "Do the work" },
				{ id: "review-1", task: "Review round 1", dependsOn: ["execute"] },
			],
			resolvers,
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const results = await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.size).toBe(6);
		expect(results.get("reflect-review-3")?.content).toBe("APPROVED");
		expect(context.nodes.get("execute")?.status).toBe("completed");
		expect(context.nodes.get("review-1")?.status).toBe("completed");
		expect(context.nodes.get("reflect-revise-2")?.status).toBe("completed");
		expect(context.nodes.get("reflect-review-2")?.status).toBe("completed");
		expect(context.nodes.get("reflect-revise-3")?.status).toBe("completed");
		expect(context.nodes.get("reflect-review-3")?.status).toBe("completed");

		const reviseTask = capturedTasks.find((task) => task.startsWith("Revise round 2"));
		expect(reviseTask).toContain("REJECTED: needs more detail");
	});

	it("should execute a complex adaptive workflow with all T1-T10 features (GitHub API integration demo)", async () => {
		const capturedTasks: string[] = [];
		const runnerFactory = vi.fn().mockImplementation(async ({ task }: { task: string }) => ({
			run: async function* () {
				capturedTasks.push(task);

				if (task.includes("读取 ~/.github-token")) {
					yield { type: "assistantDelta", content: "ghp_secret123token" };
					return;
				}
				if (task.includes("读取 repo 配置")) {
					yield { type: "assistantDelta", content: "config data" };
					return;
				}
				if (task.includes("测试 GitHub API 连通性")) {
					const hasToken = task.includes("ghp_secret123token");
					if (hasToken) {
						yield { type: "assistantDelta", content: "connection OK" };
					} else {
						yield { type: "runFailed", message: "no token" };
					}
					return;
				}
				if (task.includes("生成 GitHub 连接失败诊断")) {
					yield { type: "assistantDelta", content: "diagnostic report" };
					return;
				}
				if (task.includes("拉取 repo")) {
					const attemptMatch = capturedTasks.filter((t) => t === task).length;
					if (task.includes("angular/angular") && attemptMatch === 1) {
						yield { type: "runFailed", message: "rate limit" };
						return;
					}
					yield { type: "assistantDelta", content: `issues from ${task.match(/repo (.+?) 的/)?.[1]}` };
					return;
				}
				if (task.includes("汇总所有 repo 数据")) {
					const hasAllRepos = task.includes("angular") && task.includes("vue") && task.includes("react");
					yield { type: "assistantDelta", content: hasAllRepos ? "# Report Draft" : "incomplete" };
					return;
				}
				if (task.includes("检查报告格式")) {
					const round = task.match(/第 (\d+) 轮/)?.[1];
					yield { type: "assistantDelta", content: round === "1" ? "REJECTED: missing TOC" : "APPROVED" };
					return;
				}
				if (task.includes("修正报告")) {
					yield { type: "assistantDelta", content: "# Report v2 with TOC" };
					return;
				}
				yield { type: "assistantDelta", content: "ok" };
			},
		}));

		const orchestrator = createWorkflowOrchestrator({
			createRunner: runnerFactory,
		});

		const resolvers = new Map();
		const reflectionResolver = createReflectionResolver(resolvers, {
			maxRounds: 3,
			judge: (result) => ({
				approved: result.content?.includes("APPROVED"),
				feedback: result.content,
			}),
			reviseTask: (round, verdict) => `修正报告（第 ${round} 轮）：${verdict.feedback}`,
			reviewTask: (round) => `检查报告格式（第 ${round} 轮）`,
		});
		resolvers.set("review-1", reflectionResolver);

		const definition: DynamicGraphDefinition = {
			initialNodes: [
				{ id: "read-token", task: "读取 ~/.github-token 文件内容" },
				{ id: "read-config", task: "读取 repo 配置" },
				{
					id: "test-access",
					task: "用 token 测试 GitHub API 连通性",
					dependsOn: ["read-token"],
					inputMapping: { token: "read-token.content" },
				},
				{
					id: "diagnose",
					task: "生成 GitHub 连接失败诊断报告",
					dependsOn: ["test-access"],
					condition: { type: "custom", expression: "test-access.status === 'failed'" },
				},
				{
					id: "fetch-repo-1",
					task: "拉取 repo angular/angular 的 issues",
					dependsOn: ["test-access"],
					condition: { type: "custom", expression: "test-access.status === 'completed'" },
					retry: { maxAttempts: 2, backoffMs: 5 },
					inputMapping: { token: "read-token.content" },
				},
				{
					id: "fetch-repo-2",
					task: "拉取 repo vuejs/core 的 issues",
					dependsOn: ["test-access"],
					condition: { type: "custom", expression: "test-access.status === 'completed'" },
					retry: { maxAttempts: 2, backoffMs: 5 },
					inputMapping: { token: "read-token.content" },
				},
				{
					id: "fetch-repo-3",
					task: "拉取 repo facebook/react 的 issues",
					dependsOn: ["test-access"],
					condition: { type: "custom", expression: "test-access.status === 'completed'" },
					retry: { maxAttempts: 2, backoffMs: 5 },
					inputMapping: { token: "read-token.content" },
				},
				{
					id: "aggregate",
					task: "汇总所有 repo 数据，生成 markdown 初稿",
					dependsOn: ["fetch-repo-1", "fetch-repo-2", "fetch-repo-3"],
					inputMapping: {
						angular: "fetch-repo-1.content",
						vue: "fetch-repo-2.content",
						react: "fetch-repo-3.content",
					},
					exportTo: "draft",
				},
				{
					id: "review-1",
					task: "检查报告格式（第 1 轮）",
					dependsOn: ["aggregate"],
				},
			],
			resolvers,
			maxDepth: 15,
		};

		const engine = createDynamicGraphEngine({
			definition,
			orchestrator,
			availableTools: mockTools,
		});

		const results = await engine.execute();
		const context = engine.getContext();

		// T1: inputMapping injection
		expect(context.nodes.get("test-access")?.context).toMatchObject({ token: "ghp_secret123token" });
		expect(context.nodes.get("fetch-repo-1")?.context).toMatchObject({ token: "ghp_secret123token" });

		// T2: custom condition routing
		expect(context.nodes.get("test-access")?.status).toBe("completed");
		expect(context.nodes.get("diagnose")?.status).toBe("skipped");

		// T5: initial node dependsOn
		expect(context.nodes.get("read-token")?.status).toBe("completed");
		expect(context.nodes.get("read-config")?.status).toBe("completed");

		// T6: continuous scheduling (all 3 fetch nodes started without wave barrier)
		expect(context.nodes.get("fetch-repo-1")?.status).toBe("completed");
		expect(context.nodes.get("fetch-repo-2")?.status).toBe("completed");
		expect(context.nodes.get("fetch-repo-3")?.status).toBe("completed");

		// T9: retry (fetch-repo-1 failed once, then succeeded)
		expect(context.nodes.get("fetch-repo-1")?.attempts).toBe(2);
		expect(context.nodes.get("fetch-repo-2")?.attempts).toBe(1);

		// T7: globalData export
		expect(context.globalData.get("draft")).toBe("# Report Draft");

		// T10: reflection loop (review-1 rejected → revise-2 → review-2 approved)
		expect(context.nodes.get("review-1")?.status).toBe("completed");
		expect(results.get("review-1")?.content).toContain("REJECTED");
		expect(context.nodes.get("reflect-revise-2")?.status).toBe("completed");
		expect(context.nodes.get("reflect-review-2")?.status).toBe("completed");
		expect(results.get("reflect-review-2")?.content).toContain("APPROVED");

		// Total nodes: 9 initial nodes + 1 revise-2 + 1 review-2 = 11.
		expect(context.nodes.size).toBe(11);
	});

	it("should evaluate expressions in data flow", () => {
		const manager = createDataFlowManager();

		const mockResults = new Map<string, SubagentResult>([
			["nodeA", { status: "completed", content: "test content" }],
			["nodeB", { status: "completed", content: '{"key": "value"}' }],
			["read-token", { status: "completed", content: '{"items": ["alpha"]}' }],
		]);

		const context = {
			nodes: mockResults,
			globalData: new Map([
				["var1", "global value"],
				["expected", "value"],
			]),
		};

		expect(manager.evaluateExpression("nodeA.content", context)).toBe("test content");
		expect(manager.evaluateExpression("nodeA.status", context)).toBe("completed");
		expect(manager.evaluateExpression("$var1", context)).toBe("global value");
		expect(manager.evaluateExpression("null", context)).toBe(null);
		expect(manager.evaluateExpression("true", context)).toBe(true);
		expect(manager.evaluateExpression("42", context)).toBe(42);
		expect(manager.evaluateExpression("read-token.content.items[0]", context)).toBe("alpha");
		expect(manager.evaluateExpression("read-token.content.missing", context)).toBe(null);
		expect(manager.evaluateExpression("read-token.status === 'completed'", context)).toBe(true);
		expect(manager.evaluateExpression("$expected !== null", context)).toBe(true);
		expect(() => manager.evaluateExpression("read-token.content + 1", context)).toThrow(/unsupported expression/i);
		expect(() => manager.evaluateExpression("read-token.status === ", context)).toThrow(/unsupported expression/i);
	});

	it("should map inputs using expressions", () => {
		const manager = createDataFlowManager();

		const mockResults = new Map<string, SubagentResult>([
			["upstream", { status: "completed", content: "data from upstream" }],
		]);

		const context = {
			nodes: mockResults,
			globalData: new Map(),
		};

		const mapping = {
			input1: "upstream.content",
			input2: "$globalVar",
			input3: "'literal string'",
		};

		const result = manager.mapInputs(mapping, context);

		expect(result.input1).toBe("data from upstream");
		expect(result.input2).toBe(null);
		expect(result.input3).toBe("literal string");
	});
});
