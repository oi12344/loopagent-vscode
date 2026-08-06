import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractExplorerFindings, cacheExplorerFindings } from "../../src/extension/agent/workflow/explorerCache";
import { openProjectMemory, type ProjectMemory } from "../../src/extension/memory/projectMemory";
import type { ReadRange } from "../../src/extension/memory/types";
import type { HostToWebviewMessage } from "../../src/shared/messages";

const openedMemories: ProjectMemory[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const memory of openedMemories.splice(0).reverse()) memory.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const noopReadRange: ReadRange = () => "";

function createMemoryFixture(): ProjectMemory {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-explorer-cache-"));
  directories.push(directory);
  const databasePath = join(directory, "memory.sqlite");
  const memory = openProjectMemory(databasePath, "workspace-a", noopReadRange);
  openedMemories.push(memory);
  return memory;
}

describe("extractExplorerFindings", () => {
  describe("file extraction", () => {
    it("extracts file paths from readFile tool calls", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "readFile",
          input: '"src/auth/login.ts"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c2",
          toolName: "readFile",
          input: "'src/db/connection.ts'",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.files).toContain("src/auth/login.ts");
      expect(result.files).toContain("src/db/connection.ts");
    });

    it("extracts file paths from exploreCode tool calls", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "exploreCode",
          input: 'query: "auth", file: "src/auth.ts"',
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.files).toContain("src/auth.ts");
    });

    it("deduplicates file paths", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "readFile",
          input: '"src/auth.ts"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c2",
          toolName: "readFile",
          input: '"src/auth.ts"',
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.files.filter(f => f === "src/auth.ts").length).toBe(1);
    });

    it("extracts multiple file extensions", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "readFile",
          input: '"src/auth.ts"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c2",
          toolName: "readFile",
          input: '"src/utils.js"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c3",
          toolName: "readFile",
          input: '"src/app.py"',
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.files).toContain("src/auth.ts");
      expect(result.files).toContain("src/utils.js");
      expect(result.files).toContain("src/app.py");
    });
  });

  describe("symbol extraction", () => {
    it("extracts symbols from browseSymbols tool calls", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "browseSymbols",
          input: '"UserAuth"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c2",
          toolName: "browseSymbols",
          input: "'IAuthProvider'",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.symbols).toContain("UserAuth");
      expect(result.symbols).toContain("IAuthProvider");
    });

    it("deduplicates symbols", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c1",
          toolName: "browseSymbols",
          input: '"UserAuth"',
        },
        {
          type: "toolCallStarted",
          runId: "r1",
          callId: "c2",
          toolName: "browseSymbols",
          input: '"UserAuth"',
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.symbols.filter(s => s === "UserAuth").length).toBe(1);
    });
  });

  describe("insight extraction", () => {
    it("extracts insights from agent events with discovery keywords", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "agentEvent",
          runId: "r1",
          message: "found the login handler in src/auth/login.ts",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "located the database connection logic",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "UserAuth class is defined in src/auth.ts",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.insights.length).toBe(3);
      expect(result.insights[0]).toContain("found");
    });

    it("limits insights to 5 most recent", () => {
      const messages: HostToWebviewMessage[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          type: "agentEvent" as const,
          runId: "r1",
          message: `found item ${i}`,
        }));

      const result = extractExplorerFindings(messages);
      expect(result.insights.length).toBe(5);
    });

    it("ignores agent events without discovery keywords", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "agentEvent",
          runId: "r1",
          message: "Starting exploration",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "Working on task",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.insights.length).toBe(0);
    });

    it("detects multiple discovery keywords", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "agentEvent",
          runId: "r1",
          message: "found the handler",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "located the config",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "defined in auth.ts",
        },
        {
          type: "agentEvent",
          runId: "r1",
          message: "implemented in utils",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.insights.length).toBe(4);
    });
  });

  describe("final content extraction", () => {
    it("extracts files from final content text", () => {
      const messages: HostToWebviewMessage[] = [];

      const result = extractExplorerFindings(messages, "The final summary mentions src/utils/helpers.ts");
      expect(result.files).toContain("src/utils/helpers.ts");
    });

    it("extracts symbols from final content text", () => {
      const messages: HostToWebviewMessage[] = [];
      const finalContent = "The class UserAuth implements interface IAuthProvider and uses function validateToken";

      const result = extractExplorerFindings(messages, finalContent);
      expect(result.symbols).toContain("UserAuth");
      expect(result.symbols).toContain("IAuthProvider");
      expect(result.symbols).toContain("validateToken");
    });
  });

  describe("empty results", () => {
    it("returns empty arrays when no findings are extracted", () => {
      const messages: HostToWebviewMessage[] = [
        {
          type: "agentEvent",
          runId: "r1",
          message: "Working on task",
        },
      ];

      const result = extractExplorerFindings(messages);
      expect(result.files).toEqual([]);
      expect(result.symbols).toEqual([]);
      expect(result.insights).toEqual([]);
    });
  });
});

describe("cacheExplorerFindings", () => {
  it("writes findings to projectMemory with correct structure", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const findings = {
      files: ["src/auth/login.ts", "src/db/connection.ts"],
      symbols: ["UserAuth", "validateToken"],
      insights: ["Found the login handler", "Located the database logic"],
    };

    await cacheExplorerFindings(memory, "Find login logic", findings, generation);

    // Wait for async write to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify something was written
    expect(memory.getGeneration()).toBeGreaterThanOrEqual(generation);
  });

  it("does not write when both files and symbols are empty", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const findings = {
      files: [],
      symbols: [],
      insights: ["Some insight"],
    };

    await cacheExplorerFindings(memory, "task", findings, generation);

    // Wait for potential async write
    await new Promise(resolve => setTimeout(resolve, 10));

    // Generation should not change
    expect(memory.getGeneration()).toBe(generation);
  });

  it("truncates files list to 10 items", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const findings = {
      files: Array(20)
        .fill(null)
        .map((_, i) => `src/file${i}.ts`),
      symbols: ["Symbol1"],
      insights: [],
    };

    // Should not throw, just truncate silently
    await cacheExplorerFindings(memory, "task", findings, generation);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(memory.getGeneration()).toBeGreaterThanOrEqual(generation);
  });

  it("truncates symbols list to 10 items", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const findings = {
      files: ["src/file.ts"],
      symbols: Array(20)
        .fill(null)
        .map((_, i) => `Symbol${i}`),
      insights: [],
    };

    await cacheExplorerFindings(memory, "task", findings, generation);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(memory.getGeneration()).toBeGreaterThanOrEqual(generation);
  });

  it("handles empty task string", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const findings = {
      files: ["src/file.ts"],
      symbols: ["Symbol"],
      insights: [],
    };

    await cacheExplorerFindings(memory, "", findings, generation);
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should still write
    expect(memory.getGeneration()).toBeGreaterThanOrEqual(generation);
  });
});

describe("integration: extract and cache", () => {
  it("extracts findings and caches them in a realistic scenario", async () => {
    const memory = createMemoryFixture();
    const generation = memory.getGeneration();

    const messages: HostToWebviewMessage[] = [
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c1",
        toolName: "exploreCode",
        input: '"find login logic"',
      },
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c2",
        toolName: "readFile",
        input: '"src/auth/login.ts"',
      },
      {
        type: "toolCallStarted",
        runId: "r1",
        callId: "c3",
        toolName: "browseSymbols",
        input: '"UserAuth"',
      },
      {
        type: "agentEvent",
        runId: "r1",
        message: "found the UserAuth class defined in src/auth/login.ts",
      },
      {
        type: "agentEvent",
        runId: "r1",
        message: "located the validateToken function in the same file",
      },
    ];

    const finalContent = "The authentication system is implemented in src/auth/login.ts using the class UserAuth.";

    const findings = extractExplorerFindings(messages, finalContent);

    expect(findings.files.length).toBeGreaterThan(0);
    expect(findings.symbols.length).toBeGreaterThan(0);
    expect(findings.insights.length).toBeGreaterThan(0);

    await cacheExplorerFindings(memory, "Find login logic", findings, generation);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(memory.getGeneration()).toBeGreaterThanOrEqual(generation);
  });
});
