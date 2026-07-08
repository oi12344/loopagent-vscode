import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../../src/extension/intelligence/languages/typescriptAdapter";
import type { IndexDiagnostic } from "../../src/extension/intelligence/graph/graphTypes";

describe("TypeScript adapter", () => {
  it("extracts imports, exported functions, classes, methods, and call references", () => {
    const adapter = createTypeScriptAdapter();
    const result = adapter.extract({
      filePath: "src/extension/model/providerRegistry.ts",
      languageId: "typescript",
      text: [
        'import { createModelRunner } from "./modelRunner";',
        "export async function createConfiguredAgentRunner() {",
        "  return createModelRunner();",
        "}",
        "class Registry {",
        "  run() {",
        "    createConfiguredAgentRunner();",
        "  }",
        "}",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.importBindings).toContainEqual({
      filePath: "src/extension/model/providerRegistry.ts",
      localName: "createModelRunner",
      importedName: "createModelRunner",
      source: "./modelRunner",
      languageId: "typescript",
    });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "createConfiguredAgentRunner", isExported: true }),
        expect.objectContaining({ kind: "class", name: "Registry" }),
        expect.objectContaining({ kind: "method", name: "run" }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: "calls", referenceName: "createModelRunner" }),
        expect.objectContaining({ referenceKind: "calls", referenceName: "createConfiguredAgentRunner" }),
      ]),
    );
  });

  it("handles aliases, diagnostics, modifiers, and scope exits", () => {
    const adapter = createTypeScriptAdapter();
    const diagnostic: IndexDiagnostic = {
      filePath: "src/extension/model/modelRunner.ts",
      severity: "warning",
      message: "fixture warning",
    };
    const result = adapter.extract({
      filePath: "src/extension/model/modelRunner.ts",
      languageId: "typescript",
      text: [
        'import { createModelRunner as makeRunner } from "./modelRunner";',
        "class Runner {",
        "  private startRun(task: string): void {",
        "    makeRunner();",
        "  }",
        "}",
        "function outside() {",
        "  makeRunner();",
        "}",
      ].join("\n"),
      tree: undefined,
      diagnostics: [diagnostic],
    });

    const classNode = result.nodes.find((node) => node.kind === "class" && node.name === "Runner");
    const methodNode = result.nodes.find((node) => node.kind === "method" && node.name === "startRun");
    const outsideFunctionNode = result.nodes.find((node) => node.kind === "function" && node.name === "outside");

    expect(result.importBindings).toContainEqual({
      filePath: "src/extension/model/modelRunner.ts",
      localName: "makeRunner",
      importedName: "createModelRunner",
      source: "./modelRunner",
      languageId: "typescript",
    });
    expect(result.diagnostics).toEqual([diagnostic]);
    expect(methodNode).toEqual(expect.objectContaining({ kind: "method", name: "startRun" }));
    expect(result.edges).toContainEqual(expect.objectContaining({ source: classNode?.id, target: methodNode?.id }));
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: methodNode?.id, referenceName: "makeRunner" }),
        expect.objectContaining({ fromNodeId: outsideFunctionNode?.id, referenceName: "makeRunner" }),
      ]),
    );
    expect(result.unresolvedReferences).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ referenceName: "startRun" })]),
    );
  });
});
