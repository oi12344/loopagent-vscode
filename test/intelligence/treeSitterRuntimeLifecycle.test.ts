import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  loadLanguage: vi.fn(async () => ({})),
  parse: vi.fn(),
  parserDelete: vi.fn(),
  treeDelete: vi.fn(),
}));

vi.mock("web-tree-sitter", () => ({
  Language: { load: mocks.loadLanguage },
  Parser: class FakeParser {
    static init = mocks.initialize;

    setLanguage(): void {}

    parse(): unknown {
      return mocks.parse();
    }

    delete(): void {
      mocks.parserDelete();
    }
  },
}));

import { createTreeSitterParserRuntime } from "../../src/extension/intelligence/parser/treeSitterRuntime";

function createTree() {
  return {
    rootNode: {
      type: "program",
      text: "",
      isNamed: true,
      hasError: false,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 0 },
      namedChildren: [],
      childForFieldName: () => null,
    },
    delete: mocks.treeDelete,
  };
}

describe("Tree-sitter parser lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parse.mockReturnValue(createTree());
  });

  it("releases the parser after returning ownership of the tree", async () => {
    const runtime = createTreeSitterParserRuntime({
      parserWasmPath: "parser.wasm",
      grammarWasmDirectory: "grammars",
    });

    const parsed = await runtime.parse("src/a.ts", "typescript", "function run() {}");

    expect(parsed.tree).toBeDefined();
    expect(mocks.parserDelete).toHaveBeenCalledOnce();
    expect(mocks.treeDelete).not.toHaveBeenCalled();
  });

  it("releases the parser when parsing throws", async () => {
    mocks.parse.mockImplementationOnce(() => {
      throw new Error("parse failed");
    });
    const runtime = createTreeSitterParserRuntime({
      parserWasmPath: "parser.wasm",
      grammarWasmDirectory: "grammars",
    });

    const parsed = await runtime.parse("src/a.ts", "typescript", "function run() {}");

    expect(parsed.tree).toBeUndefined();
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", message: expect.stringContaining("parse failed") }),
    ]);
    expect(mocks.parserDelete).toHaveBeenCalledOnce();
  });
});
