import { createDynamicGraphEngine } from "../src/extension/agent/workflow/dynamicGraphEngine";
import { createWorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
import type { DynamicGraphDefinition } from "../src/extension/agent/workflow/dynamicGraphTypes";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";

/**
 * 动态图执行示例 - 代码审查工作流
 *
 * 场景:
 * 1. 分析 Git 变更的文件列表
 * 2. 根据文件数量动态创建审查任务
 * 3. 汇总审查结果生成报告
 */

// 模拟工具
const mockTools: ReactAgentTool[] = [
	{
		name: "gitDiff",
		description: "Get changed files from git",
		inputSchema: { type: "object", properties: {} },
		isConcurrencySafe: () => true,
		async invoke() {
			// 模拟 git diff 返回变更文件
			return JSON.stringify({
				files: ["src/auth.ts", "src/api.ts", "test/auth.test.ts"],
			});
		},
	},
	{
		name: "reviewFile",
		description: "Review a single file",
		inputSchema: {
			type: "object",
			properties: { filePath: { type: "string" } },
		},
		isConcurrencySafe: () => true,
		async invoke({ input }) {
			const { filePath } = input as any;
			// 模拟代码审查
			await new Promise((resolve) => setTimeout(resolve, 100));
			return JSON.stringify({
				file: filePath,
				issues: [
					{ line: 42, severity: "warning", message: "Consider adding error handling" },
				],
				score: 85,
			});
		},
	},
	{
		name: "generateReport",
		description: "Generate summary report",
		inputSchema: { type: "object", properties: {} },
		isConcurrencySafe: () => true,
		async invoke() {
			return JSON.stringify({
				summary: "Code review completed",
				totalIssues: 3,
				avgScore: 85,
			});
		},
	},
];

// 模拟 Runner Factory
const mockRunnerFactory = async ({ task, signal, runId }: any) => {
	return {
		async *run() {
			// 根据任务类型选择工具
			let result: string = "";
			if (task.includes("Get changed files")) {
				const toolResult = await mockTools[0].invoke({ input: {} } as any);
				result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
			} else if (task.includes("Review file")) {
				const match = task.match(/Review file: (.+)/);
				const filePath = match ? match[1] : "";
				const toolResult = await mockTools[1].invoke({ input: { filePath } } as any);
				result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
			} else if (task.includes("Generate report")) {
				const toolResult = await mockTools[2].invoke({ input: {} } as any);
				result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
			}

			yield { type: "assistantDelta", runId: runId || "example-run", content: result };
		},
	};
};

/**
 * 主执行函数
 */
export async function runDynamicGraphExample() {
	console.log("🚀 启动动态图计算工作流示例\n");

	// 1. 创建编排器
	const orchestrator = createWorkflowOrchestrator({
		createRunner: mockRunnerFactory,
		limits: {
			maxSubagentsPerRun: 20,
			maxNestingDepth: 5,
			maxConcurrentSubagents: 5,
			subagentTimeoutMs: 10000,
		},
	});

	// 2. 定义动态图
	const definition: DynamicGraphDefinition = {
		// 初始节点: 只有一个"分析变更"节点
		initialNodes: [
			{
				id: "analyze-changes",
				task: "Get changed files from git",
				role: "explorer",
			},
		],

		// 依赖解析器: analyze-changes 完成后动态生成审查任务
		resolvers: new Map([
			[
				"analyze-changes",
				async (nodeId, completedNodes, context) => {
					console.log("\n📊 分析节点完成,开始动态生成审查任务...");

					const result = completedNodes.get(nodeId);
					if (!result || result.status !== "completed") {
						console.log("❌ 分析失败,不生成后续任务");
						return [];
					}

					// 解析结果
					const data = JSON.parse(result.content || "{}");
					const files = data.files || [];

					console.log(`✅ 发现 ${files.length} 个变更文件:`);
					files.forEach((file: string) => console.log(`   - ${file}`));

					// 动态生成: 每个文件一个审查任务
					const reviewTasks = files.map((file: string) => ({
						id: `review-${file.replace(/[^a-zA-Z0-9]/g, "-")}`,
						task: `Review file: ${file}`,
						role: "reviewer" as const,
						inputMapping: {
							filePath: `analyze-changes.content.files[${files.indexOf(file)}]`,
						},
					}));

					// 添加汇总任务(依赖所有审查任务)
					const summaryTask = {
						id: "generate-report",
						task: "Generate review summary report",
						role: "planner" as const,
						condition: { type: "always" as const },
					};

					console.log(`\n🔄 动态生成 ${reviewTasks.length + 1} 个新节点`);

					return [...reviewTasks, summaryTask];
				},
			],
		]),

		maxNodes: 50,
		maxDepth: 3,
	};

	// 3. 创建引擎
	const engine = createDynamicGraphEngine({
		definition,
		orchestrator,
		availableTools: mockTools,
	});

	// 4. 监听事件
	let nodeCount = 0;
	engine.onEvent((event) => {
		switch (event.type) {
			case "NodeAdded":
				nodeCount++;
				console.log(`  ➕ 节点已添加: ${event.nodeId}`);
				break;
			case "NodeStatusChanged":
				if (event.status === "running") {
					console.log(`  ▶️  节点运行中: ${event.nodeId}`);
				} else if (event.status === "completed") {
					console.log(`  ✅ 节点完成: ${event.nodeId}`);
				}
				break;
			case "DependenciesResolved":
				console.log(`  🔗 依赖已解析: ${event.nodeId} → 生成 ${event.newNodes.length} 个新节点`);
				break;
			case "GraphCompleted":
				console.log(`\n🎉 图执行完成! 总节点数: ${nodeCount}`);
				break;
		}
	});

	// 5. 执行
	console.log("\n▶️  开始执行动态图...\n");
	const startTime = Date.now();
	const results = await engine.execute();
	const duration = Date.now() - startTime;

	// 6. 输出结果
	console.log("\n" + "=".repeat(60));
	console.log("📋 执行结果");
	console.log("=".repeat(60));
	console.log(`⏱️  总耗时: ${duration}ms`);
	console.log(`📊 完成节点数: ${results.size}`);

	for (const [nodeId, result] of results) {
		console.log(`\n[${nodeId}]`);
		console.log(`  状态: ${result.status}`);
		if (result.content) {
			const preview = result.content.substring(0, 100);
			console.log(`  内容: ${preview}${result.content.length > 100 ? "..." : ""}`);
		}
	}

	// 7. 生成可视化
	console.log("\n" + "=".repeat(60));
	console.log("📊 图可视化 (Mermaid)");
	console.log("=".repeat(60));
	const visualizer = engine.getVisualizer();
	const mermaid = visualizer.exportToMermaid();
	console.log(mermaid);

	// 8. 调试信息
	console.log("\n" + "=".repeat(60));
	console.log("🔍 调试信息");
	console.log("=".repeat(60));
	const debugInfo = visualizer.generateDebugInfo();
	console.log(`执行顺序: ${debugInfo.executionOrder.join(" → ")}`);
	console.log(`关键路径: ${debugInfo.criticalPath.join(" → ")}`);
	console.log(`瓶颈节点: ${debugInfo.bottlenecks.length > 0 ? debugInfo.bottlenecks.join(", ") : "无"}`);

	// 9. 统计信息
	const viz = visualizer.generateVisualization();
	console.log("\n" + "=".repeat(60));
	console.log("📈 统计信息");
	console.log("=".repeat(60));
	console.log(`总节点数: ${viz.stats.totalNodes}`);
	console.log(`已完成: ${viz.stats.completedNodes}`);
	console.log(`失败: ${viz.stats.failedNodes}`);
	console.log(`跳过: ${viz.stats.skippedNodes}`);
	console.log(`最大深度: ${viz.stats.maxDepth}`);
	console.log(`平均执行时间: ${viz.stats.avgDuration?.toFixed(2)}ms`);

	return {
		results,
		visualization: viz,
		debugInfo,
	};
}

// 如果直接运行此文件
if (require.main === module) {
	runDynamicGraphExample()
		.then(() => {
			console.log("\n✅ 示例执行完成");
			process.exit(0);
		})
		.catch((error) => {
			console.error("\n❌ 执行失败:", error);
			process.exit(1);
		});
}
