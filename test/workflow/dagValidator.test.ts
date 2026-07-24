import { describe, expect, it } from "vitest";

import { calculateDAGDepth, detectCycle, validateDAG } from "../../src/extension/agent/workflow/dagValidator";

describe("DAG validator", () => {
  it("accepts an acyclic dependency graph", () => {
    const graph = new Map<string, Set<string>>([
      ["root", new Set()],
      ["build", new Set(["root"])],
      ["test", new Set(["build"])],
    ]);

    expect(detectCycle(graph)).toBe(false);
    expect(calculateDAGDepth(graph)).toBe(3);
    expect(validateDAG(graph, { maxNestingDepth: 3 })).toEqual({ valid: true });
  });

  it("rejects circular dependencies", () => {
    const graph = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);

    expect(detectCycle(graph)).toBe(true);
    expect(validateDAG(graph, { maxNestingDepth: 3 })).toEqual({
      valid: false,
      error: "Circular dependency detected in subagent graph",
    });
  });

  it("rejects unknown dependencies", () => {
    const graph = new Map<string, Set<string>>([
      ["build", new Set(["missing"])],
    ]);

    expect(validateDAG(graph, { maxNestingDepth: 3 })).toEqual({
      valid: false,
      error: "Unknown dependency: missing",
    });
  });

  it("allows a graph at the nesting limit and rejects one above it", () => {
    const graph = new Map<string, Set<string>>([
      ["root", new Set()],
      ["build", new Set(["root"])],
      ["test", new Set(["build"])],
    ]);

    expect(validateDAG(graph, { maxNestingDepth: 3 })).toEqual({ valid: true });
    expect(validateDAG(graph, { maxNestingDepth: 2 })).toEqual({
      valid: false,
      error: "Subagent nesting depth (3) exceeds limit (2)",
    });
  });
});
