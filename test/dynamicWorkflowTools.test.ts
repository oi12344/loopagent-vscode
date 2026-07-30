import { describe, expect, it, vi } from "vitest";

import { createDynamicWorkflowTools } from "../src/extension/agent/dynamicWorkflowTools";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { CreateSubagentConfig, SubagentResult } from "../src/extension/agent/workflow/types";
import type { WorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";

describe("dynamic workflow tools", () => {
	it("exposes a single merged tool and rejects invalid initial graphs before execution", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		expect(tools.map((tool) => tool.name)).toEqual(["runDynamicGraph"]);

		const tool = toolByName(tools, "runDynamicGraph");
		const properties = tool.inputSchema.properties as Record<string, any>;
		const nodeProperties = properties.initialNodes.items.properties as Record<string, unknown>;

		expect(nodeProperties).toEqual(expect.objectContaining({ dependsOn: expect.anything(), exportTo: expect.anything(), retry: expect.anything() }));
		expect(properties.initialGlobalData).toBeDefined();
		expect(properties.nodes).toBeDefined();
		expect(properties.initialState).toBeDefined();
		expect(properties.maxSteps).toBeDefined();
		expect(properties.resolvers.items.required).toEqual(["nodeId", "resolverType", "resolverConfig"]);
		expect(properties.include.items.enum).toEqual(["visualization", "debug", "mermaid"]);
		// Running a whole graph -- executor writes included -- must never share a concurrent batch.
		expect(tool.isConcurrencySafe?.(undefined)).toBe(false);

		await expect(runGraphRaw(tools, [{ id: "same", task: "a" }, { id: "same", task: "b" }])).rejects.toThrow(/duplicate/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a", dependsOn: ["missing"] }])).rejects.toThrow(/not a known initial node/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a", role: "writer" }])).rejects.toThrow(/role must be one of/i);
		await expect(runGraphRaw(tools, [{ id: "invalid id", task: "a" }])).rejects.toThrow(/node id/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a" }, { id: "b", task: "b" }], { maxNodes: 1 })).rejects.toThrow(/maximum nodes/i);
		await expect(runGraphRaw(tools, [
			{ id: "a", task: "a", dependsOn: ["b"] },
			{ id: "b", task: "b", dependsOn: ["a"] },
		])).rejects.toThrow(/circular/i);
		const deepNodes = Array.from({ length: 12 }, (_, index) => ({
			id: `depth-${index}`,
			task: `depth ${index}`,
			...(index > 0 && { dependsOn: [`depth-${index - 1}`] }),
		}));
		await expect(runGraphRaw(tools, deepNodes)).rejects.toThrow(/maximum depth \(10\)/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a" }], { include: ["timeline"] })).rejects.toThrow(/include entries must be one of/i);

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "review", task: "Review", role: "reviewer", dependsOn: ["read"] },
		]);
		expect(result.nodes).toEqual([
			{ id: "read", role: "explorer", dependsOn: [] },
			{ id: "review", role: "reviewer", dependsOn: ["read"] },
		]);
		expect(result.completedNodes).toEqual(["read", "review"]);
		expect(result.executionOrder).toEqual(["read", "review"]);
		expect(result.totalNodes).toBe(2);
		expect(result.statusCounts).toEqual({ completed: 2 });
		expect(result).not.toHaveProperty("visualization");
		expect(result).not.toHaveProperty("debugInfo");
		expect(result).not.toHaveProperty("mermaid");
	});

	it("returns observability payloads only when include requests them", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const result = await runGraph(
			tools,
			[{ id: "read", task: "Read", role: "explorer" }],
			{ include: ["visualization", "debug", "mermaid"] },
		);

		expect(result.visualization.nodes).toEqual([expect.objectContaining({ id: "read", status: "completed" })]);
		expect(result.visualization.stats.totalNodes).toBe(1);
		expect(result.debugInfo.nodeDetails.read).toEqual(expect.objectContaining({ id: "read", task: "Read" }));
		expect(result.debugInfo.executionOrder).toEqual(["read"]);
		expect(result.mermaid).toContain("graph TD");
	});

	it("fails the tool call when no node completes so the required-tool gate stays closed", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: failingOrchestrator("subagent exploded"),
			availableTools: [],
		});

		await expect(runGraphRaw(tools, [{ id: "read", task: "Read", role: "explorer" }]))
			.rejects.toThrow(/No graph node completed \(failed: 1\)/i);
	});

	it("runs the preferred semantic plan with a state-driven review loop", async () => {
		let reviewRuns = 0;
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.role === "reviewer"
				? (++reviewRuns > 1 ? '{"decision":"approve","feedback":[]}' : '{"decision":"revise","feedback":["change it"]}')
				: "draft output"),
			availableTools: [],
		});

		const result = JSON.parse(String(await invoke(tools, "runDynamicGraph", {
			nodes: [
				{ id: "draft", task: "Draft", role: "planner" },
				{ id: "review", task: "Review", role: "reviewer", after: ["draft"], reviews: ["draft"] },
			],
		}))); 

		expect(reviewRuns).toBe(2);
		expect(result.completedNodes).toEqual(["draft", "review"]);
		expect(result.executionOrder).toEqual(["draft", "review", "draft", "review"]);
	});

	it("lists only successfully completed nodes in completedNodes", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.task === "Fail"
				? { status: "failed", error: "boom" }
				: { status: "completed", content: "ok" }),
			availableTools: [],
		});

		const result = await runGraph(tools, [
			{ id: "ok", task: "Succeed" },
			{ id: "failed", task: "Fail" },
		]);

		expect(result.statusCounts).toEqual({ completed: 1, failed: 1 });
		expect(result.completedNodes).toEqual(["ok"]);
		expect(result.results.failed).toEqual({ status: "failed", error: "boom" });
	});

	it("rejects malformed resolver configuration before execution", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const source = [{ id: "source", task: "Source" }];

		await expect(runGraphRaw(tools, source, {
			resolvers: [{ nodeId: "source", resolverType: "fanout", resolverConfig: { idPrefix: "scan", task: "Inspect", itemInputKey: "item" } }],
		})).rejects.toThrow(/itemsExpression/i);
		await expect(runGraphRaw(tools, source, {
			resolvers: [{ nodeId: "missing", resolverType: "conditional", resolverConfig: { expression: "true", nodes: [{ id: "x", task: "x" }] } }],
		})).rejects.toThrow(/not an initial node/i);
		await expect(runGraphRaw(tools, source, {
			resolvers: [
				{ nodeId: "source", resolverType: "conditional", resolverConfig: { expression: "true", nodes: [{ id: "x", task: "x" }] } },
				{ nodeId: "source", resolverType: "fanout", resolverConfig: { itemsExpression: "source.content", idPrefix: "s", task: "t", itemInputKey: "i" } },
			],
		})).rejects.toThrow(/duplicate resolver for node id/i);

		// An unparseable resolver expression must surface as ResolverFailed, not silently drop.
		const result = await runGraph(tools, source, {
			resolvers: [{ nodeId: "source", resolverType: "conditional", resolverConfig: { expression: "source.content + 1", nodes: [{ id: "x", task: "x" }] } }],
		});
		expect(result.resolverFailures).toEqual([
			expect.objectContaining({ nodeId: "source", error: expect.stringMatching(/unsupported expression/i) }),
		]);
	});

	it("registers a fanout resolver and injects each JSON item as untrusted graph data", async () => {
		const captured: CreateSubagentConfig[] = [];
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.task === "Generate items" ? '["alpha","beta"]' : "done", captured),
			availableTools: [],
		});
		const result = await runGraph(tools, [{ id: "source", task: "Generate items" }], {
			resolvers: [{
				nodeId: "source",
				resolverType: "fanout",
				resolverConfig: {
					itemsExpression: "source.content",
					idPrefix: "scan",
					task: "Inspect item",
					role: "explorer",
					toolHints: ["readFile"],
					retry: { maxAttempts: 2 },
					itemInputKey: "item",
				},
			}],
		});

		expect(result.completedNodes).toEqual(expect.arrayContaining(["source", "scan-1", "scan-2"]));
		const scanTasks = captured.filter((config) => config.task.startsWith("Inspect item")).map((config) => config.task);
		expect(scanTasks).toHaveLength(2);
		expect(scanTasks.join("\n")).toContain('trust="untrusted"');
		expect(scanTasks.join("\n")).toContain("alpha");
		expect(scanTasks.join("\n")).toContain("beta");
	});

	it("registers a conditional resolver and creates declared nodes only when truthy", async () => {
		let releaseGuard!: () => void;
		const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
		const captured: CreateSubagentConfig[] = [];
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator(async (config) => {
				if (config.task === "Guard") await guard;
				return "ok";
			}, captured),
			availableTools: [],
		});
		const execution = runGraphRaw(tools, [{ id: "source", task: "Source" }, { id: "guard", task: "Guard" }], {
			resolvers: [{
				nodeId: "source",
				resolverType: "conditional",
				resolverConfig: {
					expression: "source.status === 'completed'",
					nodes: [{ id: "branch", task: "Run branch", role: "reviewer", dependsOn: ["guard"] }],
				},
			}],
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(captured.some((config) => config.task === "Run branch")).toBe(false);
		releaseGuard();
		const result = JSON.parse(String(await execution));
		expect(result.completedNodes).toEqual(expect.arrayContaining(["source", "branch"]));
	});

	it("registers an iterative resolver and stops after approval", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.task.startsWith("Review round 2") ? "APPROVED" : config.task === "Initial review" ? "REJECTED" : "revised"),
			availableTools: [],
		});
		const result = await runGraph(tools, [{ id: "review-1", task: "Initial review" }], {
			maxDepth: 5,
			resolvers: [{
				nodeId: "review-1",
				resolverType: "iterative",
				resolverConfig: {
					maxRounds: 3,
					approvalText: "APPROVED",
					reviseTask: "Revise round",
					reviewTask: "Review round",
					idPrefix: "loop",
					reviseRole: "planner",
					reviewRole: "reviewer",
				},
			}],
		});

		expect(result.completedNodes).toEqual(expect.arrayContaining(["review-1", "loop-revise-2", "loop-review-2"]));
		expect(result.completedNodes).not.toContain("loop-revise-3");
	});
});

function failingOrchestrator(error: string): WorkflowOrchestrator {
	let nextId = 1;
	return {
		createSubagent: vi.fn(() => `subagent-${nextId++}`),
		waitForSubagents: vi.fn(async (ids) => new Map(
			ids.map((id) => [id, { status: "failed", error } satisfies SubagentResult] as const),
		)),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

function resultOrchestrator(
	resultFor: (config: CreateSubagentConfig) => SubagentResult | Promise<SubagentResult>,
): WorkflowOrchestrator {
	const configs = new Map<string, CreateSubagentConfig>();
	let nextId = 1;
	return {
		createSubagent: vi.fn((config) => {
			const id = `subagent-${nextId++}`;
			configs.set(id, config);
			return id;
		}),
		waitForSubagents: vi.fn(async (ids) => new Map(await Promise.all(
			ids.map(async (id) => [id, await resultFor(configs.get(id)!)] as const),
		))),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

function scriptedOrchestrator(
	content: (config: CreateSubagentConfig) => string | Promise<string>,
	captured: CreateSubagentConfig[] = [],
): WorkflowOrchestrator {
	const configs = new Map<string, CreateSubagentConfig>();
	let nextId = 1;
	return {
		createSubagent: vi.fn((config) => {
			const id = `subagent-${nextId++}`;
			configs.set(id, config);
			captured.push(config);
			return id;
		}),
		waitForSubagents: vi.fn(async (ids) => {
			const entries = await Promise.all(ids.map(async (id) => [id, {
				status: "completed",
				content: await content(configs.get(id)!),
			} satisfies SubagentResult] as const));
			return new Map(entries);
		}),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

async function runGraph(
	tools: ReactAgentTool[],
	initialNodes: unknown[],
	extra: Record<string, unknown> = {},
): Promise<any> {
	return JSON.parse(String(await invoke(tools, "runDynamicGraph", { initialNodes, ...extra })));
}

function runGraphRaw(
	tools: ReactAgentTool[],
	initialNodes: unknown[],
	extra: Record<string, unknown> = {},
): Promise<string | object> {
	return invoke(tools, "runDynamicGraph", { initialNodes, ...extra });
}

function toolByName(tools: ReactAgentTool[], name: string): ReactAgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

function invoke(tools: ReactAgentTool[], name: string, input: unknown): Promise<string | object> {
	return Promise.resolve().then(() => toolByName(tools, name).invoke({
		request: { id: "request-1", name, rawArguments: JSON.stringify(input), input },
		input,
		signal: new AbortController().signal,
	}));
}
