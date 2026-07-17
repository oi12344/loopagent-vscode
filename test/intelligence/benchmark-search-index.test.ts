/**
 * P4.1 性能基准测试
 *
 * 运行方式：
 *   npm run test -- benchmark-search-index.test.ts
 *   或设置 BENCH_SCALE 环境变量：
 *   BENCH_SCALE=quick npm run test -- benchmark-search-index.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  createWorkspaceIndexer,
  type WorkspaceFileRef,
} from "../../src/extension/intelligence/indexing/workspaceIndexer";
import { openIndexDatabase } from "../../src/extension/intelligence/storage/indexDatabase";
import { SqliteIndexStore } from "../../src/extension/intelligence/storage/sqliteIndexStore";
import { createAsyncSqliteStore } from "./testSupport/asyncSqliteStore";

interface BenchmarkMetrics {
  indexBuildMs: number;
  queryTimeMs: number;
  avgQueryMs: number;
  queriesPerSec: number;
}

function generateSymbolName(index: number): string {
  const prefixes = ["create", "build", "parse", "generate", "transform", "compile", "render", "process", "execute", "validate"];
  const suffixes = ["Config", "Runtime", "Parser", "Compiler", "Handler", "Factory", "Manager", "Service", "Client", "Server"];
  const prefix = prefixes[index % prefixes.length];
  const suffix = suffixes[Math.floor(index / prefixes.length) % suffixes.length];
  return `${prefix}${suffix}${index}`;
}

function generateTestFiles(symbolCount: number, fileCount: number): Map<string, { ref: WorkspaceFileRef; text: string }> {
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

async function runBenchmarkScenario(symbolCount: number, fileCount: number): Promise<BenchmarkMetrics> {
  const directory = mkdtempSync(join(tmpdir(), "bench-search-"));

  try {
    const opened = openIndexDatabase(join(directory, "index.sqlite"));
    const sqliteStore = new SqliteIndexStore(opened.database, { now: () => Date.now() });
    const OWNER_ID = randomBytes(8).toString("hex");
    sqliteStore.acquireWriterLease(OWNER_ID, 10_000_000);
    const store = createAsyncSqliteStore(sqliteStore, OWNER_ID);

    const files = generateTestFiles(symbolCount, fileCount);

    const parserRuntime = {
      parse: async (filePath: string, languageId: string, text: string) => ({
        filePath,
        languageId,
        text,
        tree: undefined,
        diagnostics: [],
      }),
    };

    const indexer = createWorkspaceIndexer({
      ownerId: OWNER_ID,
      store,
      parserRuntime: parserRuntime as any,
      listFiles: async () => [...files.values()].map((f) => f.ref),
      statFile: async (uri) => files.get(uri)?.ref,
      readFile: async (uri) => files.get(uri)?.text || "",
      maxFileBytes: 10_000_000,
    });

    const startIndex = performance.now();
    await indexer.start();
    const indexBuildMs = performance.now() - startIndex;

    // 测试多个查询
    const queryTests = [
      generateSymbolName(0),
      generateSymbolName(Math.floor(symbolCount / 2)),
      generateSymbolName(symbolCount - 1),
      "create",
      "Config",
      "createConfig",
    ];

    const queryTimes: number[] = [];
    for (const query of queryTests) {
      const start = performance.now();
      sqliteStore.searchNodes(query, 12);
      queryTimes.push(performance.now() - start);
    }

    await indexer.dispose();
    opened.close();

    const avgQueryMs = queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length;
    const queriesPerSec = 1000 / avgQueryMs;

    return {
      indexBuildMs: Math.round(indexBuildMs * 100) / 100,
      queryTimeMs: Math.round(queryTimes[0] * 1000) / 1000,
      avgQueryMs: Math.round(avgQueryMs * 1000) / 1000,
      queriesPerSec: Math.round(queriesPerSec * 100) / 100,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Search Index Performance Benchmark (P4.1)", () => {
  const scale = process.env.BENCH_SCALE || "standard";

  const scenarios =
    scale === "quick"
      ? [
          { name: "100 symbols", symbolCount: 100, fileCount: 2, targetQueryMs: 2 },
          { name: "500 symbols", symbolCount: 500, fileCount: 5, targetQueryMs: 3 },
        ]
      : scale === "full"
        ? [
            { name: "500 symbols", symbolCount: 500, fileCount: 10, targetQueryMs: 5 },
            { name: "1K symbols", symbolCount: 1_000, fileCount: 20, targetQueryMs: 5 },
            { name: "5K symbols", symbolCount: 5_000, fileCount: 50, targetQueryMs: 8 },
            { name: "10K symbols", symbolCount: 10_000, fileCount: 100, targetQueryMs: 10 },
            { name: "25K symbols", symbolCount: 25_000, fileCount: 250, targetQueryMs: 15 },
            { name: "50K symbols", symbolCount: 50_000, fileCount: 500, targetQueryMs: 20 },
          ]
        : [
            { name: "500 symbols", symbolCount: 500, fileCount: 10, targetQueryMs: 5 },
            { name: "1K symbols", symbolCount: 1_000, fileCount: 20, targetQueryMs: 5 },
            { name: "5K symbols", symbolCount: 5_000, fileCount: 50, targetQueryMs: 8 },
            { name: "10K symbols", symbolCount: 10_000, fileCount: 100, targetQueryMs: 10 },
          ];

  for (const scenario of scenarios) {
    it(
      `should query ${scenario.name} in <${scenario.targetQueryMs}ms`,
      async () => {
        const metrics = await runBenchmarkScenario(scenario.symbolCount, scenario.fileCount);

        console.log(`
  Scenario: ${scenario.name}
    Index build: ${metrics.indexBuildMs}ms
    First query: ${metrics.queryTimeMs}ms
    Avg query:   ${metrics.avgQueryMs}ms (${metrics.queriesPerSec} Q/s)
    Target:      <${scenario.targetQueryMs}ms
      `);

        expect(metrics.avgQueryMs).toBeLessThan(scenario.targetQueryMs);
      },
      120_000, // Allow 2 minutes for each benchmark scenario
    );
  }
});
