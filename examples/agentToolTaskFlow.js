/**
 * Agent 执行工具任务的完整流程演示
 *
 * 展示 Agent 如何通过工具 API 完成一个完整的动态图计算工作流
 */

console.log("╔════════════════════════════════════════════════════════════════════╗");
console.log("║  Agent 执行动态图工具任务 - 完整流程演示                          ║");
console.log("╚════════════════════════════════════════════════════════════════════╝");
console.log();

// ============================================================================
// Agent 思考过程
// ============================================================================
console.log("🤖 Agent 思考:");
console.log("   用户要求: 审查最近的代码变更");
console.log("   分析: 这是一个动态任务,文件数量未知");
console.log("   决策: 使用动态图工作流");
console.log("   策略:");
console.log("     1. 先分析获取文件列表");
console.log("     2. 根据文件数量动态生成审查任务");
console.log("     3. 并发执行提高效率");
console.log();

// ============================================================================
// 工具 1: createDynamicGraph
// ============================================================================
console.log("═".repeat(70));
console.log("🔧 工具调用 #1: createDynamicGraph");
console.log("═".repeat(70));
console.log();

console.log("📝 Agent 构造输入:");
const tool1Input = {
  tool: "createDynamicGraph",
  input: {
    initialNodes: [
      {
        id: "analyze-changes",
        task: "分析 Git 变更,获取修改的文件列表",
        role: "explorer",
        toolHints: ["gitDiff", "listFiles"]
      }
    ],
    maxNodes: 100,    // 最多 100 个节点
    maxDepth: 3       // 最大深度 3
  }
};

console.log(JSON.stringify(tool1Input, null, 2));
console.log();

console.log("⚙️  工具执行...");
const tool1Result = {
  graphId: "graph-20260725-001",
  nodeCount: 1,
  status: "created"
};

console.log("✅ 工具返回:");
console.log(JSON.stringify(tool1Result, null, 2));
console.log();

console.log("💭 Agent 解析结果:");
console.log(`   → 图 ID: ${tool1Result.graphId}`);
console.log(`   → 初始节点数: ${tool1Result.nodeCount}`);
console.log(`   → 状态: 已创建,等待执行`);
console.log();

// ============================================================================
// 工具 2: executeDynamicGraph
// ============================================================================
console.log("═".repeat(70));
console.log("🔧 工具调用 #2: executeDynamicGraph");
console.log("═".repeat(70));
console.log();

console.log("📝 Agent 构造输入:");
const tool2Input = {
  tool: "executeDynamicGraph",
  input: {
    graphId: tool1Result.graphId
  }
};

console.log(JSON.stringify(tool2Input, null, 2));
console.log();

console.log("⚙️  工具执行...");
console.log();

// 模拟执行过程
console.log("📡 执行事件流:");
console.log("   T+0ms    ▶️  analyze-changes 开始执行");
console.log("   T+150ms  ✅ analyze-changes 完成");
console.log("            结果: 发现 3 个文件 [src/auth.ts, src/api.ts, test/auth.test.ts]");
console.log();
console.log("   T+160ms  🔥 触发依赖解析器");
console.log("            → 解析器函数被调用");
console.log("            → 传入参数: completedNodes, context");
console.log();
console.log("   T+165ms  🔥 动态生成节点");
console.log("            → 生成节点: review-src-auth-ts");
console.log("            → 生成节点: review-src-api-ts");
console.log("            → 生成节点: review-test-auth-test-ts");
console.log("            → 生成节点: generate-summary");
console.log("            图结构: 1 节点 → 5 节点");
console.log();
console.log("   T+170ms  🚀 并发执行 4 个新节点");
console.log("            [review-src-auth-ts]     ▶️  运行中...");
console.log("            [review-src-api-ts]      ▶️  运行中...");
console.log("            [review-test-auth-test-ts] ▶️  运行中...");
console.log("            [generate-summary]       ▶️  运行中...");
console.log();
console.log("   T+270ms  ✅ review-src-auth-ts 完成 (发现 2 个问题)");
console.log("   T+280ms  ✅ review-src-api-ts 完成 (发现 1 个问题)");
console.log("   T+290ms  ✅ review-test-auth-test-ts 完成 (发现 0 个问题)");
console.log("   T+300ms  ✅ generate-summary 完成");
console.log();
console.log("   T+300ms  🎉 图执行完成");
console.log();

const tool2Result = {
  graphId: "graph-20260725-001",
  completedNodes: [
    "analyze-changes",
    "review-src-auth-ts",
    "review-src-api-ts",
    "review-test-auth-test-ts",
    "generate-summary"
  ],
  results: {
    "analyze-changes": {
      status: "completed",
      content: JSON.stringify({
        files: ["src/auth.ts", "src/api.ts", "test/auth.test.ts"],
        totalChanges: 45
      })
    },
    "review-src-auth-ts": {
      status: "completed",
      content: JSON.stringify({
        file: "src/auth.ts",
        issues: 2,
        severity: "warning",
        suggestions: ["添加输入验证", "处理边界情况"]
      })
    },
    "review-src-api-ts": {
      status: "completed",
      content: JSON.stringify({
        file: "src/api.ts",
        issues: 1,
        severity: "info",
        suggestions: ["添加错误日志"]
      })
    },
    "review-test-auth-test-ts": {
      status: "completed",
      content: JSON.stringify({
        file: "test/auth.test.ts",
        issues: 0,
        message: "测试文件没有问题"
      })
    },
    "generate-summary": {
      status: "completed",
      content: JSON.stringify({
        totalFiles: 3,
        totalIssues: 3,
        criticalIssues: 0,
        warningIssues: 2,
        infoIssues: 1
      })
    }
  },
  executionOrder: [
    "analyze-changes",
    "review-src-auth-ts",
    "review-src-api-ts",
    "review-test-auth-test-ts",
    "generate-summary"
  ]
};

console.log("✅ 工具返回:");
console.log(`   完成节点数: ${tool2Result.completedNodes.length}`);
console.log(`   执行顺序: ${tool2Result.executionOrder.join(" → ")}`);
console.log();

console.log("💭 Agent 解析结果:");
console.log("   → 所有节点执行成功");
console.log("   → 从 1 个节点动态扩展到 5 个节点");
console.log("   → 发现 3 个文件,生成了 4 个新任务");
console.log("   → 总共发现 3 个代码问题");
console.log();

// ============================================================================
// 工具 3: visualizeGraph
// ============================================================================
console.log("═".repeat(70));
console.log("🔧 工具调用 #3: visualizeGraph");
console.log("═".repeat(70));
console.log();

console.log("📝 Agent 构造输入:");
const tool3Input = {
  tool: "visualizeGraph",
  input: {
    graphId: tool1Result.graphId,
    format: "mermaid"
  }
};

console.log(JSON.stringify(tool3Input, null, 2));
console.log();

console.log("⚙️  工具执行...");
const tool3Result = {
  graphId: "graph-20260725-001",
  format: "mermaid",
  diagram: `graph TD
    analyze-changes["✓ 分析变更"]:::completed
    review-src-auth-ts["✓ 审查 auth.ts"]:::completed
    analyze-changes --> review-src-auth-ts
    review-src-api-ts["✓ 审查 api.ts"]:::completed
    analyze-changes --> review-src-api-ts
    review-test-auth-test-ts["✓ 审查测试文件"]:::completed
    analyze-changes --> review-test-auth-test-ts
    generate-summary["✓ 生成报告"]:::completed
    analyze-changes --> generate-summary

    classDef completed fill:#90EE90`
};

console.log("✅ 工具返回:");
console.log("```mermaid");
console.log(tool3Result.diagram);
console.log("```");
console.log();

console.log("💭 Agent 解析结果:");
console.log("   → 图结构清晰,1 个根节点扇出 4 个子节点");
console.log("   → 所有节点状态为已完成 (绿色)");
console.log();

// ============================================================================
// 工具 4: getGraphDebugInfo
// ============================================================================
console.log("═".repeat(70));
console.log("🔧 工具调用 #4: getGraphDebugInfo");
console.log("═".repeat(70));
console.log();

console.log("📝 Agent 构造输入:");
const tool4Input = {
  tool: "getGraphDebugInfo",
  input: {
    graphId: tool1Result.graphId
  }
};

console.log(JSON.stringify(tool4Input, null, 2));
console.log();

console.log("⚙️  工具执行...");
const tool4Result = {
  graphId: "graph-20260725-001",
  criticalPath: ["analyze-changes", "review-test-auth-test-ts"],
  criticalPathDuration: 290,
  bottlenecks: ["analyze-changes"],
  dataFlowRecords: 10,
  nodePerformance: {
    "analyze-changes": { duration: 150, toolCalls: 2 },
    "review-src-auth-ts": { duration: 100, toolCalls: 3 },
    "review-src-api-ts": { duration: 110, toolCalls: 3 },
    "review-test-auth-test-ts": { duration: 140, toolCalls: 3 },
    "generate-summary": { duration: 30, toolCalls: 1 }
  }
};

console.log("✅ 工具返回:");
console.log(JSON.stringify(tool4Result, null, 2));
console.log();

console.log("💭 Agent 分析性能:");
console.log(`   → 关键路径: ${tool4Result.criticalPath.join(" → ")}`);
console.log(`   → 关键路径总耗时: ${tool4Result.criticalPathDuration}ms`);
console.log(`   → 瓶颈节点: ${tool4Result.bottlenecks[0]} (扇出度: 4)`);
console.log("   → 优化建议: analyze-changes 是瓶颈,可考虑缓存结果");
console.log();

// ============================================================================
// Agent 生成最终报告
// ============================================================================
console.log("═".repeat(70));
console.log("📊 Agent 生成最终报告");
console.log("═".repeat(70));
console.log();

console.log("代码审查报告");
console.log("-".repeat(70));
console.log();

console.log("📁 审查范围:");
console.log("   • src/auth.ts");
console.log("   • src/api.ts");
console.log("   • test/auth.test.ts");
console.log();

console.log("🔍 发现问题:");
console.log("   总计: 3 个问题");
console.log("   • ⚠️  警告 (2):");
console.log("      - [auth.ts] 添加输入验证");
console.log("      - [auth.ts] 处理边界情况");
console.log("   • ℹ️  信息 (1):");
console.log("      - [api.ts] 添加错误日志");
console.log();

console.log("⚡ 性能统计:");
console.log("   • 总执行时间: 300ms");
console.log("   • 节点数: 1 → 5 (动态扩展)");
console.log("   • 并发度: 4");
console.log("   • 性能提升: ~4x (相比串行)");
console.log();

console.log("📈 工作流效率:");
console.log("   • 动态节点生成: 15ms");
console.log("   • 并发执行节点: 4 个同时");
console.log("   • 数据流传递: 10 条记录");
console.log();

// ============================================================================
// 总结
// ============================================================================
console.log("═".repeat(70));
console.log("✅ 工具任务执行完成");
console.log("═".repeat(70));
console.log();

console.log("Agent 工作流程回顾:");
console.log("  1️⃣  createDynamicGraph    → 创建动态图 (1 个初始节点)");
console.log("  2️⃣  executeDynamicGraph   → 执行图");
console.log("       ├─ analyze-changes 完成");
console.log("       ├─ 🔥 触发解析器");
console.log("       ├─ 🔥 动态生成 4 个新节点");
console.log("       └─ 并发执行所有节点");
console.log("  3️⃣  visualizeGraph       → 生成 Mermaid 图表");
console.log("  4️⃣  getGraphDebugInfo    → 获取性能分析");
console.log("  5️⃣  生成用户报告         → 整合所有结果");
console.log();

console.log("核心特性展示:");
console.log("  ✅ 运行时动态构建配置 (1 节点 → 5 节点)");
console.log("  ✅ 数据驱动的任务生成 (基于文件列表)");
console.log("  ✅ 智能并发执行 (4 个任务同时运行)");
console.log("  ✅ 完整的可观测性 (可视化 + 调试信息)");
console.log("  ✅ 性能优化 (关键路径分析)");
console.log();

console.log("🎯 关键价值:");
console.log("  • Agent 不需要预先知道有多少文件");
console.log("  • 配置在运行时根据实际数据生成");
console.log("  • 自动扩展到任意规模 (3 文件或 100 文件)");
console.log("  • 通过工具 API 完全控制整个流程");
console.log();

console.log("🎉 动态图计算工具任务执行成功!");
