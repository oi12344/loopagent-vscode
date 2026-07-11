// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sqliteWorkerConfig } from "../esbuild";

describe("sqlite worker bundle", () => {
  it("targets the extension host runtime as a standalone CommonJS bundle", () => {
    expect(sqliteWorkerConfig.entryPoints).toEqual([
      "src/extension/intelligence/storage/sqliteIndexWorker.ts",
    ]);
    expect(sqliteWorkerConfig.target).toBe("node22");
    expect(sqliteWorkerConfig.format).toBe("cjs");
    expect(sqliteWorkerConfig.outfile).toBe("dist/sqliteIndexWorker.js");
    expect(sqliteWorkerConfig.platform).toBe("node");
    expect(sqliteWorkerConfig.bundle).toBe(true);
    expect(sqliteWorkerConfig.external).toContain("vscode");
  });

  it("builds the worker and integration entry before launching the probe host", () => {
    const runner = readFileSync(
      resolve(process.cwd(), "scripts/run-sqlite-vscode-probe.mjs"),
      "utf8",
    );

    const workerBuild = runner.indexOf("esbuild.build(sqliteWorkerConfig)");
    const probeBuild = runner.indexOf("esbuild.build(sqliteProbeTestConfig)");
    const hostLaunch = runner.indexOf("runTests({");

    expect(workerBuild).toBeGreaterThanOrEqual(0);
    expect(probeBuild).toBeGreaterThanOrEqual(0);
    expect(hostLaunch).toBeGreaterThan(probeBuild);
  });
});
