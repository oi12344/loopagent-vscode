import { describe, expect, it, vi } from "vitest";

import { createDynamicWorkflowTools } from "../src/extension/agent/dynamicWorkflowTools";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { CreateSubagentConfig, SubagentResult } from "../src/extension/agent/workflow/types";
import type { WorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";

describe("dynamic workflow tools", () => {
	it("exposes the complete graph definition and rejects invalid initial graphs at creation", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const schema = toolByName(tools, "createDynamicGraph").inputSchema;
		const properties = schema.properties as Record<string, any>;
		const nodeProperties = properties.initialNodes.items.properties as Record<string, unknown>;

		expect(nodeProperties).toEqual(expect.objectContaining({ dependsOn: expect.anything(), exportTo: expect.anything(), retry: expect.anything() }));
		expect(properties.initialGlobalData).toBeDefined();
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "same", task: "a" }, { id: "same", task: "b" }],
		})).rejects.toThrow(/duplicate/i);
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "a", task: "a", dependsOn: ["missing"] }],
		})).rejects.toThrow(/not a known initial node/i);
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "a", task: "a", role: "writer" }],
		})).rejects.toThrow(/role must be one of/i);
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "invalid id", task: "a" }],
		})).rejects.toThrow(/node id/i);
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "a", task: "a" }, { id: "b", task: "b" }],
			maxNodes: 1,
		})).rejects.toThrow(/maximum nodes/i);
		await expect(invoke(tools, "createDynamicGraph", {
			initialNodes: [{ id: "a", task: "a", dependsOn: ["b"] }, { id: "b", task: "b", dependsOn: ["a"] }],
		})).rejects.toThrow(/circular/i);
		const deepNodes = Array.from({ length: 12 }, (_, index) => ({
			id: `depth-${index}`,
			task: `depth ${index}`,
			...(index > 0 && { dependsOn: [`depth-${index - 1}`] }),
		}));
		await expect(invoke(tools, "createDynamicGraph", { initialNodes: deepNodes })).rejects.toThrow(/maximum depth \(10\)/i);
		const created = JSON.parse(String(await invoke(tools, "createDynamicGraph", {
			initialNodes: [
				{ id: "read", task: "Read", role: "explorer" },
				{ id: "review", task: "Review", role: "reviewer", dependsOn: ["read"] },
			],
		})));
		expect(created.nodes).toEqual([
			{ id: "read", role: "explorer", dependsOn: [] },
			{ id: "review", role: "reviewer", dependsOn: ["read"] },
		]);
		await expect(invoke(tools, "executeDynamicGraph", { graphId: "graph-stale" })).rejects.toThrow(/createDynamicGraph.*new graph/i);
	});

	it("rejects malformed resolver configuration before execution", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const graphId = await createGraph(tools, [{ id: "source", task: "Source" }]);

		await expect(invoke(tools, "addDynamicResolver", {
			graphId,
			nodeId: "source",
			resolverType: "fanout",
			resolverConfig: { idPrefix: "scan", task: "Inspect", itemInputKey: "item" },
		})).rejects.toThrow(/itemsExpression/i);
		await expect(invoke(tools, "addDynamicResolver", {
			graphId,
			nodeId: "missing",
			resolverType: "conditional",
			resolverConfig: { expression: "true", nodes: [{ id: "x", task: "x" }] },
		})).rejects.toThrow(/not an initial node/i);
		await invoke(tools, "addDynamicResolver", {
			graphId,
			nodeId: "source",
			resolverType: "conditional",
			resolverConfig: { expression: "source.content + 1", nodes: [{ id: "x", task: "x" }] },
		});
		const result = JSON.parse(String(await invoke(tools, "executeDynamicGraph", { graphId })));
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
		const graphId = await createGraph(tools, [{ id: "source", task: "Generate items" }]);

		await invoke(tools, "addDynamicResolver", {
			graphId,
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
		});

		const result = JSON.parse(String(await invoke(tools, "executeDynamicGraph", { graphId })));
		expect(result.completedNodes).toEqual(expect.arrayContaining(["source", "scan-1", "scan-2"]));
		const scanTasks = captured.filter((config) => config.task.startsWith("Inspect item")).map((config) => config.task);
		expect(scanTasks).toHaveLength(2);
		expect(scanTasks.join("\n")).toContain('trust="untrusted"');
		expect(scanTasks.join("\n")).toContain("alpha");
		expect(scanTasks.join("\n")).toContain("beta");
		await expect(invoke(tools, "getGraphStatus", { graphId })).rejects.toThrow(/not found/i);
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
		const graphId = await createGraph(tools, [{ id: "source", task: "Source" }, { id: "guard", task: "Guard" }]);

		await invoke(tools, "addDynamicResolver", {
			graphId,
			nodeId: "source",
			resolverType: "conditional",
			resolverConfig: {
				expression: "source.status === 'completed'",
					nodes: [{ id: "branch", task: "Run branch", role: "reviewer", dependsOn: ["guard"] }],
			},
		});

		const execution = invoke(tools, "executeDynamicGraph", { graphId });
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
		const graphId = await createGraph(tools, [{ id: "review-1", task: "Initial review" }], { maxDepth: 5 });

		await invoke(tools, "addDynamicResolver", {
			graphId,
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
		});

		const result = JSON.parse(String(await invoke(tools, "executeDynamicGraph", { graphId })));
		expect(result.completedNodes).toEqual(expect.arrayContaining(["review-1", "loop-revise-2", "loop-review-2"]));
		expect(result.completedNodes).not.toContain("loop-revise-3");
	});
});

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

async function createGraph(
	tools: ReactAgentTool[],
	initialNodes: unknown[],
	extra: Record<string, unknown> = {},
): Promise<string> {
	const result = JSON.parse(String(await invoke(tools, "createDynamicGraph", { initialNodes, ...extra })));
	return result.graphId;
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
