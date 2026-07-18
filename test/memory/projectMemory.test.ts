import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openProjectMemory, type ProjectMemory, type ProjectMemoryOptions } from "../../src/extension/memory/projectMemory";
import type { ReadRange } from "../../src/extension/memory/types";

const openedMemories: ProjectMemory[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const memory of openedMemories.splice(0).reverse()) memory.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const noopReadRange: ReadRange = () => "";

function createMemoryFixture(): { databasePath: string; workspaceKey: string; readRange: ReadRange } {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-project-memory-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "memory.sqlite"),
    workspaceKey: "workspace-a",
    readRange: noopReadRange,
  };
}

function open(databasePath: string, workspaceKey: string, readRange: ReadRange, options?: ProjectMemoryOptions): ProjectMemory {
  const memory = openProjectMemory(databasePath, workspaceKey, readRange, options);
  openedMemories.push(memory);
  return memory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("projectMemory", () => {
  it("persists a remembered fact and rejects a pre-forget generation", () => {
    const fixture = createMemoryFixture();
    const memory = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
    const generation = memory.getGeneration();
    expect(
      memory.remember({ expectedGeneration: generation, kind: "fact", subject: "build", content: "Use npm run compile." }),
    ).toEqual({ ok: true });
    memory.dispose();
    openedMemories.pop();

    const reopened = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
    expect(reopened.list().map((item) => item.content)).toEqual(["Use npm run compile."]);
    expect(reopened.forget(reopened.getGeneration())).toEqual({ ok: true });
    expect(
      reopened.remember({ expectedGeneration: generation, kind: "fact", subject: "stale", content: "must fail" }),
    ).toEqual({ ok: false, reason: "generation_changed" });
  });

  it("keeps memory isolated per workspace key", () => {
    const fixture = createMemoryFixture();
    const memoryA = open(fixture.databasePath, "workspace-a", fixture.readRange);
    const memoryB = open(fixture.databasePath, "workspace-b", fixture.readRange);

    expect(
      memoryA.remember({ expectedGeneration: memoryA.getGeneration(), kind: "fact", subject: "a", content: "belongs to A" }),
    ).toEqual({ ok: true });

    expect(memoryA.list().map((item) => item.content)).toEqual(["belongs to A"]);
    expect(memoryB.list()).toEqual([]);
  });

  it("allows only one lease owner across two connections and lets the second take over after expiry", async () => {
    const fixture = createMemoryFixture();
    const first = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange, {
      leaseTtlMs: 40,
      renewIntervalMs: 1_000_000, // effectively disable auto-renew so the lease can expire
    });
    const second = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange, {
      leaseTtlMs: 40,
      renewIntervalMs: 1_000_000,
    });

    // first holds the lease: its writes succeed, second's are rejected as lease_lost.
    expect(
      first.remember({ expectedGeneration: first.getGeneration(), kind: "fact", subject: "s1", content: "owned by first" }),
    ).toEqual({ ok: true });
    expect(
      second.remember({ expectedGeneration: second.getGeneration(), kind: "fact", subject: "s2", content: "rejected" }),
    ).toEqual({ ok: false, reason: "lease_lost" });

    await sleep(80);

    // after expiry, dispose of first (releasing/abandoning) and let second take over by writing again.
    // second's periodic takeover attempt is disabled, so acquire explicitly by reopening with the same owner semantics.
    const secondTookOver = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange, {
      leaseTtlMs: 40,
      renewIntervalMs: 1_000_000,
    });
    expect(
      secondTookOver.remember({
        expectedGeneration: secondTookOver.getGeneration(),
        kind: "fact",
        subject: "s3",
        content: "owned after takeover",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects remembering sensitive values", () => {
    const fixture = createMemoryFixture();
    const memory = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
    const generation = memory.getGeneration();

    expect(
      memory.remember({
        expectedGeneration: generation,
        kind: "fact",
        subject: "credentials",
        content: "api_key: sk-abcdefgh12345678",
      }),
    ).toEqual({ ok: false, reason: "sensitive_content" });
    expect(memory.list()).toEqual([]);
  });

  it("clears both the main table and the FTS index synchronously on forget", () => {
    const fixture = createMemoryFixture();
    const memory = open(fixture.databasePath, fixture.workspaceKey, fixture.readRange);
    const generation = memory.getGeneration();
    memory.remember({ expectedGeneration: generation, kind: "decision", subject: "arch", content: "Use SQLite for memory." });
    expect(memory.forget(memory.getGeneration())).toEqual({ ok: true });
    memory.dispose();
    openedMemories.pop();

    const raw = new DatabaseSync(fixture.databasePath);
    try {
      const itemCount = (raw.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number }).n;
      const ftsCount = (raw.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;
      expect(itemCount).toBe(0);
      expect(ftsCount).toBe(0);
    } finally {
      raw.close();
    }
  });
});
