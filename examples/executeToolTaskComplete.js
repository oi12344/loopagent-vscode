/**
 * 执行工具任务 - 实战示例
 *
 * 展示如何通过工具 API 一步步执行动态图计算工作流
 */

console.log("╔════════════════════════════════════════════════════════════════╗");
console.log("║          执行工具任务 - 动态图计算工作流实战              ║");
console.log("╚════════════════════════════════════════════════════════════════╝");
console.log();

// ====================================================================
// 场景: 批量重构代码文件
// ====================================================================

console.log("📋 任务场景:");
console.log("   批量重构使用旧 API 的代码文件");
console.log("   1. 扫描代码库,找到使用旧 API 的文件");
console.log("   2. 为每个文件动态生成重构任务");
console.log("   3. 并发执行所有重构任务");
console.log("   4. 生成重构报告");
console.log();

// ====================================================================
// 工具任务执行流程
// ====================================================================

let currentStep = 0;

function logStep(title) {
  currentStep++;
  console.log("═".repeat(70));
  console.log(`步骤 ${currentStep}: ${title}`);
  console.log("═".repeat(70));
  console.log();
}

// --------------------------------------------------------------------
// 步骤 1: 创建动态图
// --------------------------------------------------------------------
logStep("创建动态图");

console.log("🔧 调用工具: createDynamicGraph");
console.log();

const createGraphInput = {
  initialNodes: [
    {
      id: "scan-codebase",
      task: "扫描代码库,找到使用 oldAPI() 的所有文件",
      role: "explorer",
      toolHints: ["grep", "listFiles"]
    }
  ],
  maxNodes: 200,
  maxDepth: 3
};

console.log("📥 输入:");
console.log(JSON.stringify(createGraphInput, null, 2));
console.log();

// 模拟工具返回
const createGraphResult = {
  graphId: "graph-refactor-20260725",
  nodeCount: 1,
  status: "created",
  timestamp: new Date().toISOString()
};

console.log("📤 输出:");
console.log(JSON.stringify(createGraphResult, null, 2));
console.log();

console.log("✅ 图创建成功");
console.log(`   图 ID: ${createGraphResult.graphId}`);
console.log(`   初始节点: ${createGraphResult.nodeCount} 个`);
console.log();

// --------------------------------------------------------------------
// 步骤 2: 配置依赖解析器 (可选)
// --------------------------------------------------------------------
logStep("配置依赖解析器");

console.log("🔧 调用工具: addDynamicResolver");
console.log();

const resolverInput = {
  graphId: createGraphResult.graphId,
  nodeId: "scan-codebase",
  resolverType: "fanout",
  resolverConfig: {
    description: "为每个找到的文件生成重构任务",
    nodeTemplate: {
      idPattern: "refactor-{fileName}",
      taskPattern: "重构 {filePath} 中的 oldAPI() 调用",
      role: "planner"
    }
  }
};

console.log("📥 输入:");
console.log(JSON.stringify(resolverInput, null, 2));
console.log();

const resolverResult = {
  graphId: createGraphResult.graphId,
  nodeId: "scan-codebase",
  resolverType: "fanout",
  registered: true
};

console.log("📤 输出:");
console.log(JSON.stringify(resolverResult, null, 2));
console.log();

console.log("✅ 解析器配置成功");
console.log("   当 scan-codebase 完成时:");
console.log("   → 解析扫描结果");
console.log("   → 为每个文件动态生成重构任务");
console.log();

// --------------------------------------------------------------------
// 步骤 3: 执行动态图
// --------------------------------------------------------------------
logStep("执行动态图");

console.log("🔧 调用工具: executeDynamicGraph");
console.log();

const executeInput = {
  graphId: createGraphResult.graphId
};

console.log("📥 输入:");
console.log(JSON.stringify(executeInput, null, 2));
console.log();

console.log("⚙️  执行中...");
console.log();

// 模拟执行过程
console.log("📡 执行事件流:");
console.log();

const executionEvents = [
  { time: 0, type: "start", nodeId: "scan-codebase", message: "开始扫描代码库" },
  { time: 500, type: "progress", nodeId: "scan-codebase", message: "正在搜索..." },
  { time: 1200, type: "complete", nodeId: "scan-codebase", message: "扫描完成: 发现 5 个文件" },
  { time: 1250, type: "resolver", message: "🔥 触发依赖解析器" },
  { time: 1300, type: "generate", message: "🔥 动态生成 5 个重构任务" },
  { time: 1310, type: "add", nodeId: "refactor-utils-auth.ts", message: "添加节点" },
  { time: 1315, type: "add", nodeId: "refactor-services-user.ts", message: "添加节点" },
  { time: 1320, type: "add", nodeId: "refactor-api-login.ts", message: "添加节点" },
  { time: 1325, type: "add", nodeId: "refactor-lib-crypto.ts", message: "添加节点" },
  { time: 1330, type: "add", nodeId: "refactor-tests-integration.ts", message: "添加节点" },
  { time: 1350, type: "parallel", message: "🚀 并发执行 5 个重构任务 (并发度: 5)" },
  { time: 1400, type: "start", nodeId: "refactor-utils-auth.ts", message: "开始重构" },
  { time: 1405, type: "start", nodeId: "refactor-services-user.ts", message: "开始重构" },
  { time: 1410, type: "start", nodeId: "refactor-api-login.ts", message: "开始重构" },
  { time: 1415, type: "start", nodeId: "refactor-lib-crypto.ts", message: "开始重构" },
  { time: 1420, type: "start", nodeId: "refactor-tests-integration.ts", message: "开始重构" },
  { time: 2100, type: "complete", nodeId: "refactor-utils-auth.ts", message: "重构完成: 3 处修改" },
  { time: 2250, type: "complete", nodeId: "refactor-services-user.ts", message: "重构完成: 5 处修改" },
  { time: 2300, type: "complete", nodeId: "refactor-api-login.ts", message: "重构完成: 2 处修改" },
  { time: 2450, type: "complete", nodeId: "refactor-lib-crypto.ts", message: "重构完成: 4 处修改" },
  { time: 2500, type: "complete", nodeId: "refactor-tests-integration.ts", message: "重构完成: 1 处修改" },
  { time: 2550, type: "done", message: "🎉 所有任务完成" }
];

executionEvents.forEach(event => {
  const icon = {
    'start': '▶️ ',
    'progress': '⏳',
    'complete': '✅',
    'resolver': '🔥',
    'generate': '🔥',
    'add': '➕',
    'parallel': '🚀',
    'done': '🎉'
  }[event.type] || '  ';

  const nodeInfo = event.nodeId ? ` [${event.nodeId}]` : '';
  console.log(`   T+${event.time}ms ${icon} ${event.message}${nodeInfo}`);
});

console.log();

// 执行结果
const executeResult = {
  graphId: createGraphResult.graphId,
  status: "completed",
  completedNodes: [
    "scan-codebase",
    "refactor-utils-auth.ts",
    "refactor-services-user.ts",
    "refactor-api-login.ts",
    "refactor-lib-crypto.ts",
    "refactor-tests-integration.ts"
  ],
  results: {
    "scan-codebase": {
      status: "completed",
      content: JSON.stringify({
        files: [
          { path: "src/utils/auth.ts", matches: 3 },
          { path: "src/services/user.ts", matches: 5 },
          { path: "src/api/login.ts", matches: 2 },
          { path: "src/lib/crypto.ts", matches: 4 },
          { path: "tests/integration.ts", matches: 1 }
        ],
        totalMatches: 15
      })
    },
    "refactor-utils-auth.ts": {
      status: "completed",
      content: JSON.stringify({ changes: 3, success: true })
    },
    "refactor-services-user.ts": {
      status: "completed",
      content: JSON.stringify({ changes: 5, success: true })
    },
    "refactor-api-login.ts": {
      status: "completed",
      content: JSON.stringify({ changes: 2, success: true })
    },
    "refactor-lib-crypto.ts": {
      status: "completed",
      content: JSON.stringify({ changes: 4, success: true })
    },
    "refactor-tests-integration.ts": {
      status: "completed",
      content: JSON.stringify({ changes: 1, success: true })
    }
  },
  executionOrder: [
    "scan-codebase",
    "refactor-utils-auth.ts",
    "refactor-services-user.ts",
    "refactor-api-login.ts",
    "refactor-lib-crypto.ts",
    "refactor-tests-integration.ts"
  ],
  totalDuration: 2550
};

console.log("📤 输出:");
console.log(JSON.stringify({
  graphId: executeResult.graphId,
  status: executeResult.status,
  completedNodes: executeResult.completedNodes,
  totalDuration: executeResult.totalDuration
}, null, 2));
console.log();

console.log("✅ 执行完成");
console.log(`   完成节点: ${executeResult.completedNodes.length} 个`);
console.log(`   总耗时: ${executeResult.totalDuration}ms`);
console.log(`   动态扩展: 1 节点 → ${executeResult.completedNodes.length} 节点`);
console.log();

// --------------------------------------------------------------------
// 步骤 4: 查询图状态
// --------------------------------------------------------------------
logStep("查询图状态");

console.log("🔧 调用工具: getGraphStatus");
console.log();

const statusInput = {
  graphId: createGraphResult.graphId
};

console.log("📥 输入:");
console.log(JSON.stringify(statusInput, null, 2));
console.log();

const statusResult = {
  graphId: createGraphResult.graphId,
  totalNodes: 6,
  statusCounts: {
    completed: 6,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0
  },
  executionOrder: executeResult.executionOrder
};

console.log("📤 输出:");
console.log(JSON.stringify(statusResult, null, 2));
console.log();

console.log("✅ 状态查询成功");
console.log(`   总节点: ${statusResult.totalNodes}`);
console.log(`   已完成: ${statusResult.statusCounts.completed}`);
console.log(`   成功率: 100%`);
console.log();

// --------------------------------------------------------------------
// 步骤 5: 生成可视化
// --------------------------------------------------------------------
logStep("生成可视化");

console.log("🔧 调用工具: visualizeGraph");
console.log();

const vizInput = {
  graphId: createGraphResult.graphId,
  format: "mermaid"
};

console.log("📥 输入:");
console.log(JSON.stringify(vizInput, null, 2));
console.log();

const vizResult = {
  graphId: createGraphResult.graphId,
  format: "mermaid",
  diagram: `graph TD
    scan["✓ 扫描代码库 (1200ms)"]:::completed
    refactor1["✓ 重构 auth.ts (700ms)"]:::completed
    scan --> refactor1
    refactor2["✓ 重构 user.ts (850ms)"]:::completed
    scan --> refactor2
    refactor3["✓ 重构 login.ts (900ms)"]:::completed
    scan --> refactor3
    refactor4["✓ 重构 crypto.ts (1050ms)"]:::completed
    scan --> refactor4
    refactor5["✓ 重构 integration.ts (1100ms)"]:::completed
    scan --> refactor5

    classDef completed fill:#90EE90,stroke:#333,stroke-width:2px`
};

console.log("📤 输出:");
console.log("```mermaid");
console.log(vizResult.diagram);
console.log("```");
console.log();

console.log("✅ 可视化生成成功");
console.log("   格式: Mermaid");
console.log("   节点: 6 个");
console.log("   边: 5 条");
console.log();

// --------------------------------------------------------------------
// 步骤 6: 获取调试信息
// --------------------------------------------------------------------
logStep("获取调试信息");

console.log("🔧 调用工具: getGraphDebugInfo");
console.log();

const debugInput = {
  graphId: createGraphResult.graphId
};

console.log("📥 输入:");
console.log(JSON.stringify(debugInput, null, 2));
console.log();

const debugResult = {
  graphId: createGraphResult.graphId,
  executionOrder: executeResult.executionOrder,
  criticalPath: ["scan-codebase", "refactor-tests-integration.ts"],
  criticalPathDuration: 2500,
  bottlenecks: ["scan-codebase"],
  dataFlowRecords: 12,
  nodeDetails: {
    "scan-codebase": {
      duration: 1200,
      toolCalls: 3,
      fanout: 5
    },
    "refactor-utils-auth.ts": {
      duration: 700,
      toolCalls: 2
    },
    "refactor-services-user.ts": {
      duration: 850,
      toolCalls: 3
    },
    "refactor-api-login.ts": {
      duration: 900,
      toolCalls: 2
    },
    "refactor-lib-crypto.ts": {
      duration: 1050,
      toolCalls: 3
    },
    "refactor-tests-integration.ts": {
      duration: 1100,
      toolCalls: 2
    }
  }
};

console.log("📤 输出:");
console.log(JSON.stringify(debugResult, null, 2));
console.log();

console.log("✅ 调试信息获取成功");
console.log(`   关键路径: ${debugResult.criticalPath.join(" → ")}`);
console.log(`   关键路径耗时: ${debugResult.criticalPathDuration}ms`);
console.log(`   瓶颈节点: ${debugResult.bottlenecks.join(", ")} (扇出度: 5)`);
console.log(`   数据流记录: ${debugResult.dataFlowRecords} 条`);
console.log();

// ====================================================================
// 生成最终报告
// ====================================================================

console.log("═".repeat(70));
console.log("📊 最终报告");
console.log("═".repeat(70));
console.log();

console.log("重构任务执行报告");
console.log("-".repeat(70));
console.log();

console.log("📁 重构文件:");
const scanResult = JSON.parse(executeResult.results["scan-codebase"].content);
scanResult.files.forEach(file => {
  const refactorResult = executeResult.results[`refactor-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}`];
  const changes = JSON.parse(refactorResult.content).changes;
  console.log(`   ✅ ${file.path}`);
  console.log(`      oldAPI() 调用: ${file.matches} 处`);
  console.log(`      已修改: ${changes} 处`);
});
console.log();

console.log("📈 统计信息:");
console.log(`   扫描文件: ${scanResult.files.length} 个`);
console.log(`   发现调用: ${scanResult.totalMatches} 处`);
console.log(`   完成重构: ${scanResult.totalMatches} 处`);
console.log(`   成功率: 100%`);
console.log();

console.log("⚡ 性能数据:");
console.log(`   总耗时: ${executeResult.totalDuration}ms`);
console.log(`   节点扩展: 1 → ${executeResult.completedNodes.length}`);
console.log(`   并发度: 5`);
console.log(`   性能提升: ~5x (相比串行执行)`);
console.log();

console.log("🔄 工作流特性:");
console.log(`   ✅ 动态节点生成: 在运行时根据扫描结果生成重构任务`);
console.log(`   ✅ 数据驱动: 文件数量可变 (本次 5 个,可扩展到任意数量)`);
console.log(`   ✅ 并发执行: 所有重构任务同时进行`);
console.log(`   ✅ 完整追踪: 事件流、数据流、性能分析`);
console.log();

// ====================================================================
// 总结
// ====================================================================

console.log("═".repeat(70));
console.log("✅ 工具任务执行完成");
console.log("═".repeat(70));
console.log();

console.log("执行的工具:");
console.log(`  1. createDynamicGraph     → 创建动态图`);
console.log(`  2. addDynamicResolver     → 配置依赖解析器`);
console.log(`  3. executeDynamicGraph    → 执行图 (动态扩展 1→6)`);
console.log(`  4. getGraphStatus         → 查询状态`);
console.log(`  5. visualizeGraph         → 生成 Mermaid 图表`);
console.log(`  6. getGraphDebugInfo      → 获取性能分析`);
console.log();

console.log("核心价值体现:");
console.log(`  ✅ 不需要预先知道文件数量`);
console.log(`  ✅ 根据扫描结果动态生成任务`);
console.log(`  ✅ 自动并发执行提升效率`);
console.log(`  ✅ 完整的可观测性和调试支持`);
console.log();

console.log("🎉 动态图计算工作流执行成功!");
