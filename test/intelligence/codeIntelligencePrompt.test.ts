import { describe, expect, it } from "vitest";

import type { CodeIntelligenceResult } from "../../src/extension/intelligence/context/codeIntelligenceContext";
import { renderCodeIntelligencePrompt } from "../../src/extension/intelligence/context/codeIntelligencePrompt";

const baseResult: CodeIntelligenceResult = {
  query: "configured runner",
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
});
