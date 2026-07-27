import { describe, it, expect, beforeEach } from "vitest";
import { createDynamicWorkflowTools } from "../../src/extension/agent/dynamicWorkflowTools";
import { createWorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";
import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";

/**
 * 测试通过工具 API 执行动态图工作流
 *
 * 合并后主 Agent 只有一个工具：runDynamicGraph 在单次调用内建图、注册 resolver、
 * 执行并返回全部节点结果。观测数据（可视化、debug、mermaid）通过 include 按需带回。
 */
describe("Dynamic Graph Workflow Tool Execution", () => {
	let runTool: ReactAgentTool;

	beforeEach(() => {
		const mockAvailableTools: ReactAgentTool[] = [
			{
				name: "readFile",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
				isConcurrencySafe: () => true,
				invoke: async () => "file content",
			},
		];

		const mockRunnerFactory = async ({ task, runId }: any) => ({
			async *run() {
				let content = "default result";
				if (task.includes("Analyze")) {
					content = JSON.stringify({ files: ["file1.ts", "file2.ts"], totalLines: 1000 });
				}
				yield { type: "assistantDelta", runId: runId || "test-run", content };
			},
		});

		const orchestrator = createWorkflowOrchestrator({ createRunner: mockRunnerFactory });
		const tools = createDynamicWorkflowTools({ orchestrator, availableTools: mockAvailableTools });
		expect(tools.map((tool) => tool.name)).toEqual(["runDynamicGraph"]);
		runTool = tools[0]!;
	});

	function run(input: unknown): Promise<any> {
		return Promise.resolve()
			.then(() => runTool.invoke({
				request: { id: "request-1", name: "runDynamicGraph", rawArguments: JSON.stringify(input), input },
				input,
				signal: new AbortController().signal,
			}))
			.then((result) => JSON.parse(String(result)));
	}

	it("creates and executes a graph in one call", async () => {
		const result = await run({
			initialNodes: [
				{ id: "analyze", task: "Analyze codebase", role: "explorer" },
				{ id: "summary", task: "Generate summary", role: "planner", condition: { type: "always" } },
			],
			maxNodes: 50,
			maxDepth: 5,
		});

		expect(result.nodes).toHaveLength(2);
		expect(result.totalNodes).toBe(2);
		expect(result.completedNodes.length).toBeGreaterThan(0);
		expect(result.statusCounts.completed).toBe(2);
	});

	it("honors conditional nodes", async () => {
		const result = await run({
			initialNodes: [
				{ id: "validate", task: "Validate input", role: "reviewer" },
				{ id: "process-success", task: "Process on success", role: "explorer", condition: { type: "onSuccess" } },
				{ id: "handle-failure", task: "Handle failure", role: "planner", condition: { type: "onFailure" } },
			],
		});

		expect(result.completedNodes.length).toBeGreaterThan(0);
		expect(result.statusCounts).toEqual(expect.objectContaining({ completed: expect.any(Number) }));
	});

	it("passes data between nodes through inputMapping", async () => {
		const result = await run({
			initialNodes: [
				{ id: "extract", task: "Extract data", role: "explorer" },
				{ id: "transform", task: "Transform data", role: "planner", inputMapping: { rawData: "extract.content" } },
				{ id: "load", task: "Load data", role: "planner", inputMapping: { transformedData: "transform.content" } },
			],
		});

		expect(result.executionOrder).toEqual(["extract", "transform", "load"]);
	});

	it("returns debug info only when include asks for it", async () => {
		const withDebug = await run({
			initialNodes: [{ id: "extract", task: "Extract data", role: "explorer" }],
			include: ["debug", "mermaid"],
		});
		expect(withDebug.debugInfo.executionOrder).toEqual(["extract"]);
		expect(withDebug.mermaid).toContain("graph TD");

		const withoutDebug = await run({
			initialNodes: [{ id: "extract", task: "Extract data", role: "explorer" }],
		});
		expect(withoutDebug).not.toHaveProperty("debugInfo");
		expect(withoutDebug).not.toHaveProperty("mermaid");
	});

	it("enforces graph limits before executing anything", async () => {
		const nodes = Array.from({ length: 8 }, (_, i) => ({
			id: `node${i}`,
			task: `Task ${i}`,
			role: "explorer" as const,
		}));

		const result = await run({ initialNodes: nodes, maxNodes: 10, maxDepth: 3 });
		expect(result.nodes).toHaveLength(8);

		await expect(run({ initialNodes: nodes, maxNodes: 4 })).rejects.toThrow(/maximum nodes/i);
	});
});
