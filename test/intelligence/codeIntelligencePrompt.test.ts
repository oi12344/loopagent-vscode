import { describe, expect, it } from "vitest";

import type { CodeIntelligenceResult } from "../../src/extension/intelligence/context/codeIntelligenceContext";
import type { SearchNodeResult } from "../../src/extension/intelligence/storage/sqliteIndexStore";
import {
  renderCodeIntelligencePrompt,
  renderPersistedCodeIntelligencePrompt,
} from "../../src/extension/intelligence/context/codeIntelligencePrompt";

const baseResult: CodeIntelligenceResult = {
  query: "configured runner",
  profile: {
    mode: "focused-source",
    reason: "test-fixture",
    maxEntryNodes: 5,
    expandDepth: 2,
    maxRelatedNodes: 14,
    maxEdges: 28,
    maxSnippetNodes: 5,
    maxSnippetChars: 6_000,
    maxSnippetLines: 90,
  },
  entryNodes: [
    {
      id: "a",
      kind: "function",
      name: "createConfiguredAgentRunner",
      qualifiedName: "providerRegistry::createConfiguredAgentRunner",
      filePath: "src/providerRegistry.ts",
      languageId: "typescript",
      startLine: 1,
      endLine: 4,
    },
  ],
  relatedNodes: [
    {
      id: "b",
      kind: "function",
      name: "createModelRunner",
      qualifiedName: "modelRunner::createModelRunner",
      filePath: "src/modelRunner.ts",
      languageId: "typescript",
      startLine: 1,
      endLine: 4,
    },
  ],
  edges: [
    {
      id: "e",
      source: "a",
      target: "b",
      kind: "calls",
      filePath: "src/providerRegistry.ts",
      line: 2,
      confidence: "exact",
    },
  ],
  snippets: [
    {
      filePath: "src/providerRegistry.ts",
      startLine: 1,
      endLine: 4,
      text: "export function createConfiguredAgentRunner() {}",
    },
  ],
  budget: { maxChars: 8_000, usedChars: 48, truncated: false },
};

describe("renderCodeIntelligencePrompt", () => {
  it("renders entries, relations, snippets, and budget", () => {
    const prompt = renderCodeIntelligencePrompt(baseResult);

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createConfiguredAgentRunner");
    expect(prompt).toContain("createModelRunner");
    expect(prompt).toContain("calls");
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("是否截断: 否");
  });

  it("returns an empty prompt when there are no entries or snippets", () => {
    expect(renderCodeIntelligencePrompt({ ...baseResult, entryNodes: [], relatedNodes: [], edges: [], snippets: [] })).toBe(
      "",
    );
  });

  it("escapes fenced code markers inside snippets", () => {
    const prompt = renderCodeIntelligencePrompt({
      ...baseResult,
      snippets: [{ filePath: "script.py", startLine: 1, endLine: 1, text: "print('x')\n```" }],
    });

    expect(prompt).toContain("```python");
    expect(prompt).toContain("``\\`");
  });

  it("caps persisted chunk text at the existing context budget", () => {
    const prompt = renderPersistedCodeIntelligencePrompt("large", [], [
      { filePath: "src/large.ts", startLine: 1, endLine: 1, sourceText: "x".repeat(8_001) },
    ]);

    expect(prompt.length).toBeLessThan(7_000);
  });

  it("counts escaped fence characters against the persisted context budget", () => {
    const prompt = renderPersistedCodeIntelligencePrompt("fences", [], [
      { filePath: "src/fences.ts", startLine: 1, endLine: 1, sourceText: "```".repeat(2_001) },
    ]);
    const bodyStart = prompt.indexOf("```typescript\n") + "```typescript\n".length;
    const bodyEnd = prompt.indexOf("\n```\n", bodyStart);

    expect(prompt.slice(bodyStart, bodyEnd)).toHaveLength(6_000);
  });

  it("renders exact symbol matches ahead of source snippets", () => {
    const nodes: SearchNodeResult[] = [
      {
        nodeId: "n1",
        nodeName: "createConfiguredAgentRunner",
        filePath: "src/providerRegistry.ts",
        score: 3.2,
        qualifiedName: "providerRegistry::createConfiguredAgentRunner",
        kind: "function",
        startLine: 10,
        endLine: 20,
      },
    ];

    const prompt = renderPersistedCodeIntelligencePrompt("configured runner", nodes, []);

    expect(prompt).toContain("### 精确符号匹配");
    expect(prompt).toContain("function providerRegistry::createConfiguredAgentRunner (src/providerRegistry.ts:10-20)");
  });

  it("returns an empty prompt when there are no symbol matches or snippets", () => {
    expect(renderPersistedCodeIntelligencePrompt("nothing", [], [])).toBe("");
  });
});
