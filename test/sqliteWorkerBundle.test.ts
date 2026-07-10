// @vitest-environment node

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
});
