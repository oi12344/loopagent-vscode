import { describe, it, expect, beforeEach } from "vitest";
import { createDynamicWorkflowTools } from "../../src/extension/agent/dynamicWorkflowTools";
import { createWorkflowOrchestrator } from "../../src/extension/agent/workflowOrchestrator";
import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";

/**
 * 测试通过工具 API 执行动态图工作流
 *
 * 模拟 Agent 调用工具的完整流程:
 * 1. createDynamicGraph - 创建图
 * 2. executeDynamicGraph - 执行图
 * 3. visualizeGraph - 生成可视化
 * 4. getGraphDebugInfo - 获取调试信息
 */
describe("Dynamic Graph Workflow Tool Execution", () => {
	let tools: ReactAgentTool[];
	let mockAvailableTools: ReactAgentTool[];
	let mockRunnerFactory: any;

	beforeEach(() => {
		// 模拟可用工具
		mockAvailableTools = [
			{
				name: "readFile",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
				isConcurrencySafe: () => true,
				invoke: async () => "file content",
			},
			{
				name: "writeFile",
				description: "Write a file",
				inputSchema: { type: "object", properties: {} },
				isConcurrencySafe: () => true,
				invoke: async () => "written",
			},
		];

		// 模拟 Runner Factory
		mockRunnerFactory = async ({ task, runId }: any) => ({
			async *run() {
				// 根据任务生成不同的结果
				let content = "default result";

				if (task.includes("Analyze")) {
					content = JSON.stringify({
						files: ["file1.ts", "file2.ts", "file3.ts"],
						totalLines: 1000,
					});
				} else if (task.includes("Process")) {
					const match = task.match(/Process (.+)/);
					const fileName = match ? match[1] : "unknown";
					content = JSON.stringify({
						file: fileName,
						linesProcessed: 100,
						issues: 2,
					});
				}

				yield {
					type: "assistantDelta",
					runId: runId || "test-run",
					content,
				};
			},
		});

		const orchestrator = createWorkflowOrchestrator({
			createRunner: mockRunnerFactory,
		});

		// 创建动态工作流工具
		tools = createDynamicWorkflowTools({
			orchestrator,
			availableTools: mockAvailableTools,
		});
	});

	it("should execute complete workflow through tool API", async () => {
		console.log("\n=== 场景: 代码分析工作流 ===\n");

		// 步骤 1: 创建动态图
		console.log("📝 步骤 1: 创建动态图");
		const createTool = tools.find((t) => t.name === "createDynamicGraph")!;
		const createResult = await createTool.invoke({
			input: {
				initialNodes: [
					{
						id: "analyze",
						task: "Analyze codebase",
						role: "explorer",
					},
					{
						id: "summary",
						task: "Generate summary",
						role: "planner",
						condition: { type: "always" },
					},
				],
				maxNodes: 50,
				maxDepth: 5,
			},
		} as any);

		const createData = JSON.parse(createResult as string);
		console.log(`✅ 图已创建: ${createData.graphId}`);
		console.log(`   初始节点数: ${createData.nodeCount}\n`);

		const graphId = createData.graphId;

		// 步骤 2: 检查初始状态
		console.log("📊 步骤 2: 检查初始状态");
		const statusTool = tools.find((t) => t.name === "getGraphStatus")!;
		const initialStatus = await statusTool.invoke({
			input: { graphId },
		} as any);

		const initialData = JSON.parse(initialStatus as string);
		console.log(`   总节点数: ${initialData.totalNodes}`);
		console.log(`   状态分布:`, initialData.statusCounts);
		console.log();

		// 步骤 3: 执行图
		console.log("▶️  步骤 3: 执行动态图");
		const executeTool = tools.find((t) => t.name === "executeDynamicGraph")!;
		const executeResult = await executeTool.invoke({
			input: { graphId },
		} as any);

		const executeData = JSON.parse(executeResult as string);
		console.log(`✅ 执行完成`);
		console.log(`   完成节点: ${executeData.completedNodes.length}`);
		console.log(`   执行顺序: ${executeData.executionOrder.join(" → ")}\n`);

		// 执行完成后图会被释放
		const vizTool = tools.find((t) => t.name === "visualizeGraph")!;
		expect(createData.graphId).toBeTruthy();
		expect(executeData.completedNodes.length).toBeGreaterThan(0);
		expect(() => vizTool.invoke({ input: { graphId, format: "json" } } as any))
			.toThrow(`Graph ${graphId} not found`);
	});

	it("should handle conditional execution through tool API", async () => {
		console.log("\n=== 场景: 条件执行工作流 ===\n");

		const createTool = tools.find((t) => t.name === "createDynamicGraph")!;
		const executeTool = tools.find((t) => t.name === "executeDynamicGraph")!;
		const statusTool = tools.find((t) => t.name === "getGraphStatus")!;

		// 创建带条件的图
		console.log("📝 创建带条件分支的图");
		const createResult = await createTool.invoke({
			input: {
				initialNodes: [
					{
						id: "validate",
						task: "Validate input",
						role: "reviewer",
					},
					{
						id: "process-success",
						task: "Process on success",
						role: "explorer",
						condition: { type: "onSuccess" },
					},
					{
						id: "handle-failure",
						task: "Handle failure",
						role: "planner",
						condition: { type: "onFailure" },
					},
				],
			},
		} as any);

		const createData = JSON.parse(createResult as string);
		const graphId = createData.graphId;
		console.log(`✅ 图已创建: ${graphId}\n`);

		// 执行
		console.log("▶️  执行条件工作流");
		const executeResult = await executeTool.invoke({ input: { graphId } } as any);
		const executeData = JSON.parse(executeResult as string);

		console.log(`✅ 执行完成`);
		console.log();

		expect(executeData.completedNodes.length).toBeGreaterThan(0);
		expect(() => statusTool.invoke({ input: { graphId } } as any))
			.toThrow(`Graph ${graphId} not found`);
	});

	it("should support input mapping through tool API", async () => {
		console.log("\n=== 场景: 数据流传递工作流 ===\n");

		const createTool = tools.find((t) => t.name === "createDynamicGraph")!;
		const executeTool = tools.find((t) => t.name === "executeDynamicGraph")!;
		const debugTool = tools.find((t) => t.name === "getGraphDebugInfo")!;

		// 创建数据流图
		console.log("📝 创建数据流传递图");
		const createResult = await createTool.invoke({
			input: {
				initialNodes: [
					{
						id: "extract",
						task: "Extract data",
						role: "explorer",
					},
					{
						id: "transform",
						task: "Transform data",
						role: "planner",
						inputMapping: {
							rawData: "extract.content",
						},
					},
					{
						id: "load",
						task: "Load data",
						role: "planner",
						inputMapping: {
							transformedData: "transform.content",
						},
					},
				],
			},
		} as any);

		const createData = JSON.parse(createResult as string);
		const graphId = createData.graphId;
		console.log(`✅ 图已创建: ${graphId}\n`);

		// 执行
		console.log("▶️  执行数据流工作流");
		const executeResult = await executeTool.invoke({ input: { graphId } } as any);
		const executeData = JSON.parse(executeResult as string);
		console.log(`✅ 执行完成: ${executeData.executionOrder.join(" → ")}\n`);

		expect(executeData.executionOrder).toEqual(["extract", "transform", "load"]);
		expect(() => debugTool.invoke({ input: { graphId } } as any))
			.toThrow(`Graph ${graphId} not found`);
	});

	it("should enforce limits through tool API", async () => {
		console.log("\n=== 场景: 限制验证 ===\n");

		const createTool = tools.find((t) => t.name === "createDynamicGraph")!;

		// 尝试创建超过限制的图
		console.log("📝 创建节点数接近限制的图");
		const nodes = Array.from({ length: 8 }, (_, i) => ({
			id: `node${i}`,
			task: `Task ${i}`,
			role: "explorer" as const,
		}));

		const createResult = await createTool.invoke({
			input: {
				initialNodes: nodes,
				maxNodes: 10,
				maxDepth: 3,
			},
		} as any);

		const createData = JSON.parse(createResult as string);
		console.log(`✅ 图已创建: ${createData.graphId}`);
		console.log(`   初始节点: ${createData.nodeCount}`);
		console.log(`   最大节点限制: 10`);
		console.log(`   最大深度限制: 3\n`);

		expect(createData.nodeCount).toBe(8);
		expect(createData.nodeCount).toBeLessThanOrEqual(10);
	});

	it("should cancel graph through tool API", async () => {
		console.log("\n=== 场景: 取消执行 ===\n");

		const createTool = tools.find((t) => t.name === "createDynamicGraph")!;
		const cancelTool = tools.find((t) => t.name === "cancelDynamicGraph")!;

		// 创建图
		console.log("📝 创建图");
		const createResult = await createTool.invoke({
			input: {
				initialNodes: [
					{ id: "task1", task: "Long task 1" },
					{ id: "task2", task: "Long task 2" },
				],
			},
		} as any);

		const createData = JSON.parse(createResult as string);
		const graphId = createData.graphId;
		console.log(`✅ 图已创建: ${graphId}\n`);

		// 立即取消
		console.log("⏸️  取消图执行");
		const cancelResult = await cancelTool.invoke({
			input: { graphId },
		} as any);

		const cancelData = JSON.parse(cancelResult as string);
		console.log(`✅ 已取消: ${cancelData.graphId}`);
		console.log(`   取消状态: ${cancelData.cancelled}\n`);

		expect(cancelData.cancelled).toBe(true);
		expect(cancelData.graphId).toBe(graphId);
	});
});
