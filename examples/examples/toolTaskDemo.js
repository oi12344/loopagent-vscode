/**
 * 动态图工具任务执行演示
 *
 * 此示例展示了如何通过工具 API 执行动态图计算工作流
 * 模拟 Agent 调用工具的完整过程
 */

console.log("=".repeat(70));
console.log("🤖 动态图计算工作流 - 工具任务执行演示");
console.log("=".repeat(70));
console.log();

// ============================================================
// 模拟场景: 代码审查工作流
// ============================================================

console.log("📋 场景描述:");
console.log("   自动化代码审查流程:");
console.log("   1. 分析 Git 变更的文件");
console.log("   2. 为每个文件动态生成审查任务");
console.log("   3. 并发执行所有审查任务");
console.log("   4. 汇总生成审查报告");
console.log();

// ============================================================
// 步骤 1: 创建动态图
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 1: 创建动态图");
console.log("=" .repeat(70));
console.log();

const graphConfig = {
	initialNodes: [
		{
			id: "analyze-changes",
			task: "Get changed files from git",
			role: "explorer",
			toolHints: ["gitDiff"],
		},
	],
	maxNodes: 50,
	maxDepth: 5,
};

console.log("📝 工具调用: createDynamicGraph");
console.log("输入配置:");
console.log(JSON.stringify(graphConfig, null, 2));
console.log();

// 模拟工具返回
const createResult = {
	graphId: "graph-1",
	nodeCount: 1,
	status: "created",
};

console.log("✅ 创建成功:");
console.log(`   图 ID: ${createResult.graphId}`);
console.log(`   初始节点数: ${createResult.nodeCount}`);
console.log();

// ============================================================
// 步骤 2: 配置依赖解析器
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 2: 配置依赖解析器");
console.log("=" .repeat(70));
console.log();

const resolverConfig = {
	graphId: "graph-1",
	nodeId: "analyze-changes",
	resolverType: "fanout",
	resolverLogic: `
    async (nodeId, completedNodes, context) => {
      // 解析分析结果
      const result = completedNodes.get(nodeId);
      const data = JSON.parse(result.content);
      const files = data.files;

      // 🔥 动态生成审查任务
      return files.map(file => ({
        id: \`review-\${file.replace(/[^a-zA-Z0-9]/g, '-')}\`,
        task: \`Review file: \${file}\`,
        role: 'reviewer',
        inputMapping: {
          filePath: \`analyze-changes.content.files[\${files.indexOf(file)}]\`
        }
      }));
    }
  `,
};

console.log("📝 工具调用: addDynamicResolver");
console.log("解析器类型:", resolverConfig.resolverType);
console.log("目标节点:", resolverConfig.nodeId);
console.log();

console.log("✅ 解析器已配置");
console.log("   当 'analyze-changes' 完成时:");
console.log("   → 解析 Git 变更文件列表");
console.log("   → 为每个文件生成独立的审查任务");
console.log();

// ============================================================
// 步骤 3: 执行动态图
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 3: 执行动态图");
console.log("=" .repeat(70));
console.log();

console.log("📝 工具调用: executeDynamicGraph");
console.log(`   图 ID: ${createResult.graphId}`);
console.log();

console.log("▶️  执行过程:");
console.log();

// 模拟执行流程
const executionSteps = [
	{ time: 0, event: "开始执行", nodeId: "analyze-changes", status: "running" },
	{ time: 150, event: "节点完成", nodeId: "analyze-changes", status: "completed" },
	{ time: 160, event: "🔥 触发解析器", info: "发现 3 个变更文件" },
	{ time: 165, event: "🔥 动态生成节点", info: "生成 4 个新任务" },
	{ time: 170, event: "节点已添加", nodeId: "review-src-auth-ts" },
	{ time: 171, event: "节点已添加", nodeId: "review-src-api-ts" },
	{ time: 172, event: "节点已添加", nodeId: "review-test-auth-test-ts" },
	{ time: 173, event: "节点已添加", nodeId: "generate-report" },
	{ time: 180, event: "并发执行", info: "4 个任务同时运行" },
	{ time: 280, event: "节点完成", nodeId: "review-src-auth-ts", status: "completed" },
	{ time: 285, event: "节点完成", nodeId: "review-src-api-ts", status: "completed" },
	{ time: 290, event: "节点完成", nodeId: "review-test-auth-test-ts", status: "completed" },
	{ time: 295, event: "节点完成", nodeId: "generate-report", status: "completed" },
	{ time: 300, event: "执行完成", info: "所有任务已完成" },
];

executionSteps.forEach((step) => {
	const icon = step.event.includes("🔥") ? step.event.split(" ")[0] : step.status === "completed" ? "✅" : "▶️ ";
	const msg = step.nodeId ? `${step.event}: ${step.nodeId}` : step.info ? `${step.event} - ${step.info}` : step.event;
	console.log(`   [T+${step.time}ms] ${icon} ${msg}`);
});

console.log();

const executeResult = {
	graphId: "graph-1",
	completedNodes: ["analyze-changes", "review-src-auth-ts", "review-src-api-ts", "review-test-auth-test-ts", "generate-report"],
	executionOrder: ["analyze-changes", "review-src-auth-ts", "review-src-api-ts", "review-test-auth-test-ts", "generate-report"],
	totalDuration: 300,
};

console.log("✅ 执行完成:");
console.log(`   总耗时: ${executeResult.totalDuration}ms`);
console.log(`   完成节点数: ${executeResult.completedNodes.length}`);
console.log(`   执行顺序: ${executeResult.executionOrder.join(" → ")}`);
console.log();

// ============================================================
// 步骤 4: 生成可视化
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 4: 生成可视化");
console.log("=" .repeat(70));
console.log();

console.log("📝 工具调用: visualizeGraph (format: mermaid)");
console.log();

const mermaidDiagram = `graph TD
    analyze-changes["✓ Get changed files from git"]:::completed
    review-src-auth-ts["✓ Review file: src/auth.ts"]:::completed
    analyze-changes --> review-src-auth-ts
    review-src-api-ts["✓ Review file: src/api.ts"]:::completed
    analyze-changes --> review-src-api-ts
    review-test-auth-test-ts["✓ Review file: test/auth.test.ts"]:::completed
    analyze-changes --> review-test-auth-test-ts
    generate-report["✓ Generate review summary report"]:::completed
    analyze-changes --> generate-report

    classDef completed fill:#90EE90,stroke:#333,stroke-width:2px
    classDef running fill:#FFD700,stroke:#333,stroke-width:2px
    classDef failed fill:#FF6B6B,stroke:#333,stroke-width:2px`;

console.log("✅ Mermaid 图表:");
console.log("```mermaid");
console.log(mermaidDiagram);
console.log("```");
console.log();

// ============================================================
// 步骤 5: 获取调试信息
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 5: 获取调试信息");
console.log("=" .repeat(70));
console.log();

console.log("📝 工具调用: getGraphDebugInfo");
console.log();

const debugInfo = {
	graphId: "graph-1",
	nodeDetails: {
		"analyze-changes": {
			status: "completed",
			duration: 150,
			inputData: {},
			outputData: { files: ["src/auth.ts", "src/api.ts", "test/auth.test.ts"] },
		},
		"review-src-auth-ts": {
			status: "completed",
			duration: 100,
			inputData: { filePath: "src/auth.ts" },
			outputData: { issues: 2, score: 85 },
		},
		"review-src-api-ts": {
			status: "completed",
			duration: 105,
			inputData: { filePath: "src/api.ts" },
			outputData: { issues: 1, score: 90 },
		},
		"review-test-auth-test-ts": {
			status: "completed",
			duration: 110,
			inputData: { filePath: "test/auth.test.ts" },
			outputData: { issues: 0, score: 95 },
		},
		"generate-report": {
			status: "completed",
			duration: 15,
			inputData: {},
			outputData: { summary: "Review completed", totalIssues: 3 },
		},
	},
	executionOrder: ["analyze-changes", "review-src-auth-ts", "review-src-api-ts", "review-test-auth-test-ts", "generate-report"],
	criticalPath: ["analyze-changes", "review-test-auth-test-ts"],
	bottlenecks: ["analyze-changes"],
	dataFlowRecords: 10,
};

console.log("✅ 调试信息:");
console.log(`   执行顺序: ${debugInfo.executionOrder.join(" → ")}`);
console.log(`   关键路径: ${debugInfo.criticalPath.join(" → ")} (总耗时: 260ms)`);
console.log(`   瓶颈节点: ${debugInfo.bottlenecks.join(", ")} (扇出度: 4)`);
console.log(`   数据流记录: ${debugInfo.dataFlowRecords} 条`);
console.log();

console.log("节点性能:");
Object.entries(debugInfo.nodeDetails).forEach(([nodeId, details]) => {
	console.log(`   [${nodeId}]`);
	console.log(`      状态: ${details.status}`);
	console.log(`      耗时: ${details.duration}ms`);
	console.log(`      输入: ${JSON.stringify(details.inputData)}`);
	console.log(`      输出: ${JSON.stringify(details.outputData)}`);
});
console.log();

// ============================================================
// 步骤 6: 统计信息
// ============================================================

console.log("=" .repeat(70));
console.log("步骤 6: 统计信息");
console.log("=" .repeat(70));
console.log();

console.log("📝 工具调用: getGraphStatus");
console.log();

const stats = {
	totalNodes: 5,
	completedNodes: 5,
	failedNodes: 0,
	skippedNodes: 0,
	runningNodes: 0,
	pendingNodes: 0,
	maxDepth: 2,
	avgDuration: 96,
	totalDuration: 300,
};

console.log("✅ 统计信息:");
console.log(`   总节点数: ${stats.totalNodes}`);
console.log(`   已完成: ${stats.completedNodes}`);
console.log(`   失败: ${stats.failedNodes}`);
console.log(`   跳过: ${stats.skippedNodes}`);
console.log(`   最大深度: ${stats.maxDepth}`);
console.log(`   平均耗时: ${stats.avgDuration}ms`);
console.log(`   总耗时: ${stats.totalDuration}ms`);
console.log();

// ============================================================
// 总结
// ============================================================

console.log("=" .repeat(70));
console.log("✅ 工具任务执行完成");
console.log("=" .repeat(70));
console.log();

console.log("执行的工具:");
console.log("  1. createDynamicGraph     - 创建动态图");
console.log("  2. addDynamicResolver     - 配置依赖解析器");
console.log("  3. executeDynamicGraph    - 执行图");
console.log("  4. visualizeGraph         - 生成 Mermaid 图表");
console.log("  5. getGraphDebugInfo      - 获取调试信息");
console.log("  6. getGraphStatus         - 获取统计信息");
console.log();

console.log("核心特性展示:");
console.log("  ✅ 运行时动态生成节点 (1 → 5)");
console.log("  ✅ 数据驱动的任务生成");
console.log("  ✅ 并发执行 (4 个任务同时运行)");
console.log("  ✅ 完整的可视化和调试工具");
console.log("  ✅ 性能分析 (关键路径、瓶颈检测)");
console.log();

console.log("关键指标:");
console.log(`  • 初始节点: 1 个`);
console.log(`  • 动态生成: 4 个`);
console.log(`  • 总执行时间: ${stats.totalDuration}ms`);
console.log(`  • 并发度: 4`);
console.log(`  • 性能提升: ~4x (相比串行执行)`);
console.log();

console.log("🎉 动态图计算工作流演示完成!");
console.log();
