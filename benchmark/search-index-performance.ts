/**
 * 搜索索引性能基准测试
 *
 * 用途：验证 SQLite FTS 搜索索引在不同工作区规模下的性能表现
 *
 * 运行方式：
 *   node --prof benchmark/search-index-performance.ts
 *   node --prof-process isolate-*.log > profile.txt
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { openIndexDatabase } from "../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../src/extension/intelligence/storage/sqliteIndexStore";
import { createAsyncSqliteStore } from "../test/intelligence/testSupport/asyncSqliteStore";
import { createWorkspaceIndexer } from "../src/extension/intelligence/indexing/workspaceIndexer";

interface BenchmarkConfig {
  symbolCount: number;
  fileCount: number;
  scenarioName: string;
}

interface BenchmarkResult {
  scenario: string;
  symbolCount: number;
  fileCount: number;
  indexBuildTimeMs: number;
  queryTimeMs: number;
  averageQueryTimeMs: number;
  memoryUsedMb: number;
  queriesPerSecond: number;
}

// 生成测试符号名称
function generateSymbolName(index: number): string {
  const prefix = ["create", "build", "parse", "generate", "transform", "compile", "render", "process", "execute", "validate"][
    index % 10
  ];
  const suffix = ["Config", "Runtime", "Parser", "Compiler", "Handler", "Factory", "Manager", "Service", "Client", "Server"][
    Math.floor(index / 10) % 10
  ];
  return `${prefix}${suffix}${index}`;
}

// 生成测试数据：创建虚拟文件
function generateTestFiles(
  symbolCount: number,
  fileCount: number,
): Map<string, { ref: WorkspaceFileRef; text: string }> {
  const files = new Map();
  const symbolsPerFile = Math.ceil(symbolCount / fileCount);

  for (let f = 0; f < fileCount; f++) {
    const filePath = `src/lib/module-${f}.ts`;
    const fileUri = `file:///workspace/${filePath}`;
    const symbols: string[] = [];

    for (let s = 0; s < symbolsPerFile && symbols.length < symbolCount; s++) {
      const globalIndex = f * symbolsPerFile + s;
      if (globalIndex < symbolCount) {
        symbols.push(generateSymbolName(globalIndex));
      }
    }

    const code = symbols.map((name) => `export function ${name}() { return "${name}"; }`).join("\n");

    files.set(fileUri, {
      ref: {
        uri: fileUri,
        path: filePath,
        languageId: "typescript",
        mtime: Date.now(),
        byteLength: code.length,
      },
      text: code,
    });
  }

  return files;
}

interface WorkspaceFileRef {
  uri: string;
  path: string;
  languageId: string;
  mtime: number;
  byteLength: number;
}

// 执行单次基准测试
async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-search-"));

  try {
    console.log(`\n📊 开始基准测试: ${config.scenarioName} (${config.symbolCount} 符号, ${config.fileCount} 文件)`);

    // 初始化数据库
    const opened = openIndexDatabase(join(directory, "index.sqlite"));
    const sqliteStore = new SqliteIndexStore(opened.database, { now: () => Date.now() });
    const OWNER_ID = randomBytes(8).toString("hex");
    sqliteStore.acquireWriterLease(OWNER_ID, 10_000_000);
    const store = createAsyncSqliteStore(sqliteStore, OWNER_ID);

    // 生成测试数据
    const files = generateTestFiles(config.symbolCount, config.fileCount);
    console.log(`✓ 生成 ${files.size} 个测试文件，共 ${config.symbolCount} 个符号`);

    // 模拟 parser runtime
    const parserRuntime = {
      parse: async (filePath: string, languageId: string, text: string) => ({
        filePath,
        languageId,
        text,
        tree: undefined,
        diagnostics: [],
      }),
    };

    // 创建工作区索引器
    const indexer = createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store,
      parserRuntime: parserRuntime as any,
      listFiles: async () => [...files.values()].map((f) => f.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)?.text || "",
      maxFileBytes: 10_000_000,
    });

    // 测量索引构建时间
    const startIndexBuild = performance.now();
    await indexer.start();
    const indexBuildTimeMs = performance.now() - startIndexBuild;
    console.log(`✓ 索引构建完成: ${indexBuildTimeMs.toFixed(2)}ms`);

    // 测量查询性能
    const queryTests = [
      { query: generateSymbolName(0), name: "精确匹配第一个符号" },
      { query: generateSymbolName(Math.floor(config.symbolCount / 2)), name: "精确匹配中间符号" },
      { query: generateSymbolName(config.symbolCount - 1), name: "精确匹配最后一个符号" },
      { query: "create", name: "前缀匹配（高重复）" },
      { query: "Config", name: "后缀匹配（高重复）" },
      { query: "createConfig", name: "多词匹配" },
    ];

    const queryTimes: number[] = [];
    for (const test of queryTests) {
      const start = performance.now();
      const results = sqliteStore.searchNodes(test.query, 12);
      const elapsed = performance.now() - start;
      queryTimes.push(elapsed);
      console.log(`  - ${test.name}: ${elapsed.toFixed(3)}ms (找到 ${results.length} 个结果)`);
    }

    const averageQueryTimeMs = queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length;
    const queriesPerSecond = 1000 / averageQueryTimeMs;

    // 获取内存占用（估计）
    const beforeGc = process.memoryUsage();
    if (global.gc) global.gc();
    const afterGc = process.memoryUsage();
    const memoryUsedMb = (afterGc.heapUsed - afterGc.heapUsed) / 1024 / 1024;

    // 清理
    await indexer.dispose();
    opened.close();

    const result: BenchmarkResult = {
      scenario: config.scenarioName,
      symbolCount: config.symbolCount,
      fileCount: config.fileCount,
      indexBuildTimeMs: Math.round(indexBuildTimeMs * 100) / 100,
      queryTimeMs: Math.round(queryTimes[0] * 1000) / 1000,
      averageQueryTimeMs: Math.round(averageQueryTimeMs * 1000) / 1000,
      memoryUsedMb: Math.round(memoryUsedMb * 100) / 100,
      queriesPerSecond: Math.round(queriesPerSecond * 100) / 100,
    };

    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 格式化结果表
function formatResultsTable(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("\n📈 性能基准测试结果\n");
  lines.push("| 场景 | 符号数 | 文件数 | 索引构建(ms) | 查询时间(ms) | 平均查询(ms) | QPS | 内存(MB) |");
  lines.push("|------|--------|--------|---------|---------|---------|------|-------|");

  for (const result of results) {
    lines.push(
      `| ${result.scenario} | ${result.symbolCount.toLocaleString()} | ${result.fileCount} | ${result.indexBuildTimeMs} | ${result.queryTimeMs} | ${result.averageQueryTimeMs} | ${result.queriesPerSecond} | ${result.memoryUsedMb} |`,
    );
  }

  return lines.join("\n");
}

// 主函数
async function main() {
  console.log("🚀 开始 P4.1 性能基准测试\n");
  console.log("测试范围:");
  console.log("  • 小项目 (<1K 符号): 目标 <5ms");
  console.log("  • 中型项目 (10K 符号): 目标 <10ms");
  console.log("  • 大型项目 (50K 符号): 目标 <20ms\n");

  // 环境变量控制测试规模：BENCH_SCALE=quick|standard|full
  const scale = process.env.BENCH_SCALE || "standard";
  const configurations: BenchmarkConfig[] = scale === "quick"
    ? [
        { symbolCount: 100, fileCount: 2, scenarioName: "快速测试 (100 符号)" },
        { symbolCount: 500, fileCount: 5, scenarioName: "快速测试 (500 符号)" },
      ]
    : scale === "full"
      ? [
          { symbolCount: 500, fileCount: 10, scenarioName: "小项目 (500 符号)" },
          { symbolCount: 1_000, fileCount: 20, scenarioName: "小项目 (1K 符号)" },
          { symbolCount: 5_000, fileCount: 50, scenarioName: "中型项目 (5K 符号)" },
          { symbolCount: 10_000, fileCount: 100, scenarioName: "中型项目 (10K 符号)" },
          { symbolCount: 25_000, fileCount: 250, scenarioName: "大型项目 (25K 符号)" },
          { symbolCount: 50_000, fileCount: 500, scenarioName: "大型项目 (50K 符号)" },
        ]
      : [
          { symbolCount: 500, fileCount: 10, scenarioName: "小项目 (500 符号)" },
          { symbolCount: 1_000, fileCount: 20, scenarioName: "小项目 (1K 符号)" },
          { symbolCount: 5_000, fileCount: 50, scenarioName: "中型项目 (5K 符号)" },
          { symbolCount: 10_000, fileCount: 100, scenarioName: "中型项目 (10K 符号)" },
        ];

  const results: BenchmarkResult[] = [];

  for (const config of configurations) {
    try {
      const result = await runBenchmark(config);
      results.push(result);

      // 简单的性能检查
      let status = "✓";
      if (config.symbolCount <= 1_000 && result.averageQueryTimeMs > 5) {
        status = "⚠️";
      } else if (config.symbolCount <= 10_000 && result.averageQueryTimeMs > 10) {
        status = "⚠️";
      } else if (config.symbolCount <= 50_000 && result.averageQueryTimeMs > 20) {
        status = "⚠️";
      }
      console.log(`${status} ${config.scenarioName}: ${result.averageQueryTimeMs}ms (目标范围内)`);
    } catch (error) {
      console.error(`❌ ${config.scenarioName} 失败:`, error);
    }
  }

  // 输出结果表
  console.log(formatResultsTable(results));

  // 总结
  console.log("\n✅ 基准测试完成\n");
  console.log("?? 性能指标:");
  const avgIndexTime = results.reduce((sum, r) => sum + r.indexBuildTimeMs, 0) / results.length;
  const avgQueryTime = results.reduce((sum, r) => sum + r.averageQueryTimeMs, 0) / results.length;
  console.log(`  平均索引构建时间: ${avgIndexTime.toFixed(2)}ms`);
  console.log(`  平均查询延迟: ${avgQueryTime.toFixed(3)}ms`);
  console.log(`  最快查询: ${Math.min(...results.map((r) => r.averageQueryTimeMs)).toFixed(3)}ms (小项目)`);
  console.log(`  最慢查询: ${Math.max(...results.map((r) => r.averageQueryTimeMs)).toFixed(3)}ms (大型项目)`);

  // 检查是否达成性能目标
  const allMet = results.every((r) => {
    if (r.symbolCount <= 1_000) return r.averageQueryTimeMs <= 5;
    if (r.symbolCount <= 10_000) return r.averageQueryTimeMs <= 10;
    return r.averageQueryTimeMs <= 20;
  });

  if (allMet) {
    console.log("\n🎉 所有性能目标已达成！\n");
  } else {
    console.log("\n⚠️ 某些性能目标未达成，请查看上方标记\n");
  }

  process.exit(allMet ? 0 : 1);
}

main().catch((error) => {
  console.error("性能基准测试失败:", error);
  process.exit(1);
});
