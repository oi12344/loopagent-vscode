import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDynamicGraphEngine } from "../src/extension/agent/workflow/dynamicGraphEngine";
import { createWorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
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
		});

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
				{ id: "level2", task: "Level 2" },
				{ id: "level3", task: "Level 3" },
				{ id: "level4", task: "Level 4" },
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

	it("should handle node cancellation", async () => {
		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
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

		setTimeout(() => engine.cancel(), 100);

		const results = await engine.execute();
		const context = engine.getContext();

		expect(context.nodes.size).toBeGreaterThan(0);
	});

	it("should evaluate expressions in data flow", () => {
		const { createDataFlowManager } = require("../src/extension/agent/workflow/dataFlowManager");
		const manager = createDataFlowManager();

		const mockResults = new Map<string, SubagentResult>([
			["nodeA", { status: "completed", content: "test content" }],
			["nodeB", { status: "completed", content: '{"key": "value"}' }],
		]);

		const context = {
			nodes: mockResults,
			globalData: new Map([["var1", "global value"]]),
		};

		expect(manager.evaluateExpression("nodeA.content", context)).toBe("test content");
		expect(manager.evaluateExpression("nodeA.status", context)).toBe("completed");
		expect(manager.evaluateExpression("$var1", context)).toBe("global value");
		expect(manager.evaluateExpression("null", context)).toBe(null);
		expect(manager.evaluateExpression("true", context)).toBe(true);
		expect(manager.evaluateExpression("42", context)).toBe(42);
	});

	it("should map inputs using expressions", () => {
		const { createDataFlowManager } = require("../src/extension/agent/workflow/dataFlowManager");
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
			input3: "literal string",
		};

		const result = manager.mapInputs(mapping, context);

		expect(result.input1).toBe("data from upstream");
		expect(result.input2).toBe(null);
	});
});
