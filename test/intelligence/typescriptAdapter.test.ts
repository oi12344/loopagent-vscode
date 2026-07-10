import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../../src/extension/intelligence/languages/typescriptAdapter";
import type { IndexDiagnostic } from "../../src/extension/intelligence/graph/graphTypes";
import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

async function extractWithTree(text: string, languageId = "typescript") {
  const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
  const parsed = await runtime.parse("src/sample.ts", languageId, text);
  try {
    return createTypeScriptAdapter().extract(parsed);
  } finally {
    parsed.tree?.delete();
  }
}

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

  it("sets symbol ranges to full function, class, and method bodies", () => {
    const adapter = createTypeScriptAdapter();
    const result = adapter.extract({
      filePath: "src/extension.ts",
      languageId: "typescript",
      text: [
        "export function activate() {",
        "  registerCommands();",
        "  createConfiguredAgentRunner();",
        "}",
        "class LoopAgentChatViewProvider {",
        "  private startRun(): void {",
        "    createConfiguredAgentRunner();",
        "  }",
        "}",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "activate", startLine: 1, endLine: 4 }),
        expect.objectContaining({ kind: "class", name: "LoopAgentChatViewProvider", startLine: 5, endLine: 9 }),
        expect.objectContaining({
          kind: "method",
          name: "startRun",
          qualifiedName: "src/extension.ts::LoopAgentChatViewProvider.startRun",
          startLine: 6,
          endLine: 8,
        }),
      ]),
    );
  });

  it("extracts async generator and generator functions", () => {
    const adapter = createTypeScriptAdapter();
    const result = adapter.extract({
      filePath: "src/extension/model/openAiCompatibleClient.ts",
      languageId: "typescript",
      text: [
        "async function* streamChatCompletion({",
        "  request,",
        "}: {",
        "  request: ModelRequest;",
        "}) {",
        "  for (const event of mapChunkEvents()) {",
        "    yield event;",
        "  }",
        "}",
        "function* mapChunkEvents() {",
        '  yield { type: "contentDelta" as const, content: "" };',
        "}",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "streamChatCompletion", startLine: 1, endLine: 9 }),
        expect.objectContaining({ kind: "function", name: "mapChunkEvents", startLine: 10, endLine: 12 }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "symbol:src/extension/model/openAiCompatibleClient.ts:function:streamChatCompletion:1",
          referenceName: "mapChunkEvents",
        }),
      ]),
    );
  });

  it("extracts AST-backed declarations and exact ranges", async () => {
    const result = await extractWithTree(
      [
        'export const run = async () => { const marker = "}"; helper(); };',
        "export class Service { constructor() {} start() { this.run(); } }",
        "export interface Config { name: string }",
        'export type Mode = "fast" | "safe";',
        "export enum State { Ready }",
      ].join("\n"),
    );

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "run", startLine: 1, endLine: 1, isExported: true }),
        expect.objectContaining({ kind: "class", name: "Service", startLine: 2, endLine: 2, isExported: true }),
        expect.objectContaining({
          kind: "constructor",
          name: "constructor",
          qualifiedName: "src/sample.ts::Service.constructor",
          isExported: false,
        }),
        expect.objectContaining({
          kind: "method",
          name: "start",
          qualifiedName: "src/sample.ts::Service.start",
          isExported: false,
        }),
        expect.objectContaining({ kind: "interface", name: "Config", isExported: true }),
        expect.objectContaining({ kind: "type", name: "Mode", isExported: true }),
        expect.objectContaining({ kind: "enum", name: "State", isExported: true }),
      ]),
    );
  });

  it("uses AST ranges when braces appear inside strings", async () => {
    const result = await extractWithTree(
      ["export function run() {", '  const marker = "}";', "  helper();", "}"].join("\n"),
    );
    const runNode = result.nodes.find((node) => node.kind === "function" && node.name === "run");

    expect(runNode).toEqual(expect.objectContaining({ startLine: 1, endLine: 4 }));
    expect(result.unresolvedReferences).toContainEqual(
      expect.objectContaining({ fromNodeId: runNode?.id, referenceName: "helper", calleeKind: "identifier" }),
    );
  });

  it("extracts generator declarations from AST", async () => {
    const result = await extractWithTree(
      ["export async function* streamEvents() {", "  yield createEvent();", "}"].join("\n"),
    );

    expect(result.nodes).toContainEqual(
      expect.objectContaining({ kind: "function", name: "streamEvents", startLine: 1, endLine: 3 }),
    );
  });

  it("extracts multiline imports and preserves callee shape", async () => {
    const result = await extractWithTree(
      [
        "import DefaultRunner, {",
        "  createRunner as makeRunner,",
        '} from "./runner";',
        'import * as api from "./api";',
        "function run() { makeRunner(); api.send(); new DefaultRunner(); }",
      ].join("\n"),
    );

    expect(result.importBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localName: "DefaultRunner",
          importedName: "default",
          source: "./runner",
          isDefault: true,
        }),
        expect.objectContaining({ localName: "makeRunner", importedName: "createRunner", source: "./runner" }),
        expect.objectContaining({ localName: "api", importedName: "*", source: "./api", isNamespace: true }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "makeRunner",
          calleeKind: "identifier",
          referenceKind: "calls",
        }),
        expect.objectContaining({
          referenceName: "send",
          receiverName: "api",
          calleeKind: "member",
          referenceKind: "calls",
        }),
        expect.objectContaining({
          referenceName: "DefaultRunner",
          calleeKind: "identifier",
          referenceKind: "instantiates",
        }),
      ]),
    );
  });
});
