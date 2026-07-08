import { describe, expect, it } from "vitest";

import type { CodeNode, ImportBinding, UnresolvedReference } from "../../src/extension/intelligence/graph/graphTypes";
import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";
import { resolveReferences } from "../../src/extension/intelligence/resolution/referenceResolver";

function createFunctionNode(filePath: string, name: string, line = 1): CodeNode {
  return {
    id: `symbol:${filePath}:function:${name}:${line}`,
    kind: "function",
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    languageId: "typescript",
    startLine: line,
    endLine: line + 2,
    isExported: true,
  };
}

describe("resolveReferences", () => {
  it("resolves imported call references into call edges", () => {
    const graph = createSemanticGraph();
    const caller = createFunctionNode("src/a.ts", "run");
    const callee = createFunctionNode("src/b.ts", "createModelRunner");
    graph.upsertNode(caller);
    graph.upsertNode(callee);

    const refs: UnresolvedReference[] = [
      {
        fromNodeId: caller.id,
        referenceName: "createModelRunner",
        referenceKind: "calls",
        filePath: "src/a.ts",
        line: 2,
        languageId: "typescript",
      },
    ];
    const imports: ImportBinding[] = [
      {
        filePath: "src/a.ts",
        localName: "createModelRunner",
        importedName: "createModelRunner",
        source: "./b",
        resolvedFilePath: "src/b.ts",
        languageId: "typescript",
      },
    ];

    const edges = resolveReferences({ graph, references: refs, importBindings: imports });

    expect(edges).toEqual([
      expect.objectContaining({
        id: `edge:${caller.id}:calls:${callee.id}:2`,
        source: caller.id,
        target: callee.id,
        kind: "calls",
        confidence: "exact",
      }),
    ]);
  });

  it("resolves same-file references before global name matches", () => {
    const graph = createSemanticGraph();
    const caller = createFunctionNode("src/a.ts", "run");
    const sameFileTarget = createFunctionNode("src/a.ts", "helper", 10);
    const otherFileTarget = createFunctionNode("src/b.ts", "helper");
    graph.upsertNode(caller);
    graph.upsertNode(sameFileTarget);
    graph.upsertNode(otherFileTarget);

    const edges = resolveReferences({
      graph,
      references: [
        {
          fromNodeId: caller.id,
          referenceName: "helper",
          referenceKind: "calls",
          filePath: "src/a.ts",
          line: 3,
          languageId: "typescript",
        },
      ],
      importBindings: [],
    });

    expect(edges).toEqual([expect.objectContaining({ source: caller.id, target: sameFileTarget.id })]);
  });

  it("does not resolve ambiguous global references", () => {
    const graph = createSemanticGraph();
    const caller = createFunctionNode("src/a.ts", "run");
    graph.upsertNode(caller);
    graph.upsertNode(createFunctionNode("src/b.ts", "helper"));
    graph.upsertNode(createFunctionNode("src/c.ts", "helper"));

    const edges = resolveReferences({
      graph,
      references: [
        {
          fromNodeId: caller.id,
          referenceName: "helper",
          referenceKind: "calls",
          filePath: "src/a.ts",
          line: 3,
          languageId: "typescript",
        },
      ],
      importBindings: [],
    });

    expect(edges).toEqual([]);
  });
});
