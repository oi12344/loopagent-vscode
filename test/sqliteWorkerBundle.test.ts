// @vitest-environment node

import { describe, expect, it } from "vitest";

import { sqliteWorkerConfig } from "../esbuild";

describe("sqlite worker bundle", () => {
  it("targets the extension host runtime as a standalone CommonJS bundle", () => {
    expect(sqliteWorkerConfig).toMatchObject({
      target: "node22",
      format: "cjs",
      outfile: "dist/sqliteIndexWorker.js",
    });
  });
});
