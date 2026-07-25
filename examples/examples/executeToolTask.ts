/**
 * 动态图工具任务执行示例
 *
 * 模拟 Agent 通过工具 API 执行动态图工作流的完整流程
 */

import { createDynamicWorkflowTools } from "../src/extension/agent/dynamicWorkflowTools";
import { createWorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";

// ============================================================
// 模拟工具和环境
// ============================================================

const mockAvailableTools: ReactAgentTool[] = [
	{
		name: "analyzeCode",
		description: "Analyze code files",
		inputSchema: { type: "object", properties: {} },
		isConcurrencySafe: () => true,
		async invoke() {
			return JSON.stringify({
				files: ["src/user.ts", "src/auth.ts", "src/api.ts"],
				issues: 5,
			});
		},
	},
	{
		name: "refactorFile",
		description: "Refactor a single file",
		inputSchema: {
			type: "object",
			properties: { filePath: { type: "string" } },
		},
		isConcurrencySafe: () => true,
		async invoke({ input }) {
			const { filePath } = input as any;
			await new Promise((resolve) => setTimeout(resolve, 50));
			return JSON.stringify({
				file: filePath,
				changes: 3,
				status: "success",
			});
		},
	},
];

const mockRunnerFactory = async ({ task, runId }: any) => ({
	async *run() {
		let content = "default result";

		if (task.includes("Analyze codebase")) {
			content = JSON.stringify({
				files: ["src/user.ts", "src/auth.ts", "src/api.ts"],
				totalLines: 500,
			});
		} else if (task.includes("Refactor")) {
			const match = task.match(/Refactor (.+)/);
			const fileName = match ? match[1] : "unknown";
			content = JSON.stringify({
				file: fileName,
				linesChanged: 15,
				issuesFixed: 2,
			});
		} else if (task.includes("Generate report")) {
			content = JSON.stringify({
				summary: "Refactoring completed",
				totalFiles: 3,
				totalChanges: 45,
			});
		}

		yield {
			type: "assistantDelta",
			runId: runId || "tool-task-run",
			content,
		};
	},
});

// ============================================================
// 主任务执行函数
// ============================================================

async function executeToolTask() {
	console.log("=" .repeat(60));
	console.log("🤖 动态图工具任务执行示例");
	console.log("=" .repeat(60));
	console.log();

	// 步骤 0: 初始化
	console.log("⚙️  初始化工作流系统...");
	const orchestrator = createWorkflowOrchestrator({
		createRunner: mockRunnerFactory,
		limits: {
			maxSubagentsPerRun: 20,
			maxNestingDepth: 5,
			maxConcurrentSubagents: 5,
			subagentTimeoutMs: 10000,
		},
	});

	const tools = createDynamicWorkflowTools({
		orchestrator,
		availableTools: mockAvailableTools,
	});

	console.log(`✅ 已加载 ${tools.length} 个动态工作流工具\n`);

	// ============================================================
	// 任务 1: 创建动态图
	// ============================================================
	console.log("📝 任务 1: 创建代码重构动态图");
	console.log("-".repeat(60));

	const createTool = tools.find((t) => t.name === "createDynamicGraph")!;

	const createInput = {
		initialNodes: [
			{
				id: "analyze-codebase",
				task: "Analyze codebase for refactoring opportunities",
				role: "explorer",
				toolHints: ["analyzeCode"],
			},
		],
		maxNodes: 50,
		maxDepth: 5,
	};

	console.log("输入配置:");
	console.log(JSON.stringify(createInput, null, 2));
	console.log();

	const createResult = await createTool.invoke({
		input: createInput,
	} as any);

	const createData = JSON.parse(createResult as string);
	const graphId = createData.graphId;

	console.log("✅ 创建结果:");
	console.log(`   图 ID: ${graphId}`);
	console.log(`   初始节点数: ${createData.nodeCount}\n`);

	// ============================================================
	// 任务 2: 添加依赖解析器
	// ============================================================
	console.log("🔗 任务 2: 配置动态依赖解析器");
	console.log("-".repeat(60));

	const resolverTool = tools.find((t) => t.name === "addDynamicResolver")!;

	const resolverInput = {
		graphId,
		nodeId: "analyze-codebase",
		resolverType: "fanout",
		resolverConfig: {
			pattern: "refactor-{file}",
			taskTemplate: "Refactor {file}",
		},
	};

	console.log("输入配置:");
	console.log(JSON.stringify(resolverInput, null, 2));
	console.log();

	const resolverResult = await resolverTool.invoke({
		input: resolverInput,
	} as any);

	const resolverData = JSON.parse(resolverResult as string);
	console.log("✅ 配置结果:");
	console.log(`   节点: ${resolverData.nodeId}`);
	console.log(`   类型: ${resolverData.resolverType}`);
	console.log(`   已注册: ${resolverData.registered}\n`);

	// ============================================================
	// 任务 3: 检查初始状态
	// ============================================================
	console.log("📊 任务 3: 检查图的初始状态");
	console.log("-".repeat(60));

	const statusTool = tools.find((t) => t.name === "getGraphStatus")!;

	const initialStatusResult = await statusTool.invoke({
		input: { graphId },
	} as any);

	const initialStatus = JSON.parse(initialStatusResult as string);
	console.log("初始状态:");
	console.log(`   总节点数: ${initialStatus.totalNodes}`);
	console.log(`   状态分布:`, initialStatus.statusCounts);
	console.log();

	// ============================================================
	// 任务 4: 执行动态图
	// ============================================================
	console.log("▶️  任务 4: 执行动态图工作流");
	console.log("-".repeat(60));

	const executeTool = tools.find((t) => t.name === "executeDynamicGraph")!;

	console.log("开始执行...");
	const startTime = Date.now();

	const executeResult = await executeTool.invoke({
		input: { graphId },
	} as any);

	const duration = Date.now() - startTime;
	const executeData = JSON.parse(executeResult as string);

	console.log(`✅ 执行完成 (耗时 ${duration}ms)`);
	console.log(`   完成节点: ${executeData.completedNodes.length}`);
	console.log(`   执行顺序: ${executeData.executionOrder.join(" → ")}`);
	console.log();

	console.log("节点结果:");
	for (const [nodeId, result] of Object.entries(executeData.results)) {
		const r = result as any;
		console.log(`   [${nodeId}]`);
		console.log(`      状态: ${r.status}`);
		if (r.content) {
			const preview = r.content.substring(0, 80);
			console.log(`      内容: ${preview}${r.content.length > 80 ? "..." : ""}`);
		}
	}
	console.log();

	// ============================================================
	// 任务 5: 检查最终状态
	// ============================================================
	console.log("📊 任务 5: 检查图的最终状态");
	console.log("-".repeat(60));

	const finalStatusResult = await statusTool.invoke({
		input: { graphId },
	} as any);

	const finalStatus = JSON.parse(finalStatusResult as string);
	console.log("最终状态:");
	console.log(`   总节点数: ${finalStatus.totalNodes}`);
	console.log(`   状态分布:`, finalStatus.statusCounts);
	console.log();

	// ============================================================
	// 任务 6: 生成可视化 (JSON)
	// ============================================================
	console.log("📊 任务 6: 生成 JSON 可视化");
	console.log("-".repeat(60));

	const vizTool = tools.find((t) => t.name === "visualizeGraph")!;

	const vizResult = await vizTool.invoke({
		input: { graphId, format: "json" },
	} as any);

	const vizData = JSON.parse(vizResult as string);
	console.log("可视化数据:");
	console.log(`   节点数: ${vizData.visualization.nodes.length}`);
	console.log(`   边数: ${vizData.visualization.edges.length}`);
	console.log(`   统计:`, vizData.visualization.stats);
	console.log();

	// ============================================================
	// 任务 7: 生成 Mermaid 图表
	// ============================================================
	console.log("📈 任务 7: 生成 Mermaid 图表");
	console.log("-".repeat(60));

	const mermaidResult = await vizTool.invoke({
		input: { graphId, format: "mermaid" },
	} as any);

	const mermaidData = JSON.parse(mermaidResult as string);
	console.log("Mermaid 图表:");
	console.log("```mermaid");
	console.log(mermaidData.diagram);
	console.log("```");
	console.log();

	// ============================================================
	// 任务 8: 获取调试信息
	// ============================================================
	console.log("🔍 任务 8: 获取调试信息");
	console.log("-".repeat(60));

	const debugTool = tools.find((t) => t.name === "getGraphDebugInfo")!;

	const debugResult = await debugTool.invoke({
		input: { graphId },
	} as any);

	const debugData = JSON.parse(debugResult as string);
	console.log("调试信息:");
	console.log(`   执行顺序: ${debugData.executionOrder.join(" → ")}`);
	console.log(`   关键路径: ${debugData.criticalPath.length > 0 ? debugData.criticalPath.join(" → ") : "无"}`);
	console.log(`   瓶颈节点: ${debugData.bottlenecks.length > 0 ? debugData.bottlenecks.join(", ") : "无"}`);
	console.log(`   数据流记录: ${debugData.dataFlowRecords.length} 条`);
	console.log();

	// ============================================================
	// 任务 9: 取消图 (演示)
	// ============================================================
	console.log("⏸️  任务 9: 取消图 (演示)");
	console.log("-".repeat(60));

	const cancelTool = tools.find((t) => t.name === "cancelDynamicGraph")!;

	const cancelResult = await cancelTool.invoke({
		input: { graphId },
	} as any);

	const cancelData = JSON.parse(cancelResult as string);
	console.log("取消结果:");
	console.log(`   图 ID: ${cancelData.graphId}`);
	console.log(`   已取消: ${cancelData.cancelled}\n`);

	// ============================================================
	// 总结
	// ============================================================
	console.log("=" .repeat(60));
	console.log("✅ 工具任务执行完成");
	console.log("=" .repeat(60));
	console.log();
	console.log("执行的工具:");
	console.log("  1. createDynamicGraph     - 创建动态图");
	console.log("  2. addDynamicResolver     - 添加依赖解析器");
	console.log("  3. getGraphStatus         - 获取状态 (2次)");
	console.log("  4. executeDynamicGraph    - 执行图");
	console.log("  5. visualizeGraph         - 生成可视化 (JSON + Mermaid)");
	console.log("  6. getGraphDebugInfo      - 获取调试信息");
	console.log("  7. cancelDynamicGraph     - 取消图");
	console.log();
	console.log(`总耗时: ${duration}ms`);
	console.log(`总节点数: ${finalStatus.totalNodes}`);
	console.log(`完成节点: ${finalStatus.statusCounts.completed || 0}`);
	console.log();

	return {
		graphId,
		duration,
		finalStatus,
		visualization: vizData.visualization,
		debugInfo: debugData,
	};
}

// ============================================================
// 运行
// ============================================================

if (require.main === module) {
	executeToolTask()
		.then((result) => {
			console.log("🎉 任务执行成功!");
			process.exit(0);
		})
		.catch((error) => {
			console.error("❌ 任务执行失败:", error);
			process.exit(1);
		});
}

export { executeToolTask };
