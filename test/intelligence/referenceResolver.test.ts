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

function createReference(overrides: Partial<UnresolvedReference> = {}): UnresolvedReference {
  return {
    fromNodeId: "symbol:src/a.ts:function:run:1",
    referenceName: "helper",
    referenceKind: "calls",
    calleeKind: "identifier",
    filePath: "src/a.ts",
    line: 2,
    languageId: "typescript",
    ...overrides,
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

  it("prefers a concrete implementation over declaration-only overloads", () => {
    const graph = createSemanticGraph();
    const caller = createFunctionNode("src/a.ts", "run");
    const declaration = {
      ...createFunctionNode("src/a.ts", "helper", 5),
      id: "helper:string-overload",
      metadata: { declarationOnly: true },
    };
    const implementation = { ...createFunctionNode("src/a.ts", "helper", 10), id: "helper:implementation" };
    graph.upsertNode(caller);
    graph.upsertNode(declaration);
    graph.upsertNode(implementation);

    const edges = resolveReferences({ graph, references: [createReference()], importBindings: [] });

    expect(edges[0]?.target).toBe(implementation.id);
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

  it("does not resolve a member call to a bare same-file function", () => {
    const graph = createSemanticGraph();
    graph.upsertNode(createFunctionNode("src/a.ts", "run"));
    graph.upsertNode(createFunctionNode("src/a.ts", "helper", 10));

    const edges = resolveReferences({
      graph,
      importBindings: [],
      references: [createReference({ calleeKind: "member", receiverName: "service" })],
    });

    expect(edges).toEqual([]);
  });

  it("uses evidence-based confidence levels", () => {
    const importedGraph = createSemanticGraph();
    importedGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
    importedGraph.upsertNode(createFunctionNode("src/b.ts", "helper"));
    const [importedEdge] = resolveReferences({
      graph: importedGraph,
      references: [createReference()],
      importBindings: [
        {
          filePath: "src/a.ts",
          localName: "helper",
          importedName: "helper",
          source: "./b",
          resolvedFilePath: "src/b.ts",
          languageId: "typescript",
        },
      ],
    });

    const sameFileGraph = createSemanticGraph();
    sameFileGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
    sameFileGraph.upsertNode(createFunctionNode("src/a.ts", "helper", 10));
    const [sameFileEdge] = resolveReferences({
      graph: sameFileGraph,
      references: [createReference()],
      importBindings: [],
    });

    const globalGraph = createSemanticGraph();
    globalGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
    globalGraph.upsertNode(createFunctionNode("src/c.ts", "helper"));
    const [globalEdge] = resolveReferences({
      graph: globalGraph,
      references: [createReference()],
      importBindings: [],
    });

    expect(importedEdge?.confidence).toBe("exact");
    expect(sameFileEdge?.confidence).toBe("probable");
    expect(globalEdge?.confidence).toBe("heuristic");
  });
});
