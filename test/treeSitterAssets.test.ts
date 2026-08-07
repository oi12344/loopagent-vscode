import { describe, expect, it } from "vitest";

import { TREE_SITTER_ASSETS } from "../scripts/treeSitterAssets";

describe("TREE_SITTER_ASSETS", () => {
  it("lists parser runtime and first-stage language wasm files", () => {
    expect(TREE_SITTER_ASSETS.map((asset) => asset.outputName)).toEqual([
      "web-tree-sitter.wasm",
      "tree-sitter-typescript.wasm",
      "tree-sitter-tsx.wasm",
      "tree-sitter-javascript.wasm",
      "tree-sitter-python.wasm",
      "tree-sitter-java.wasm",
    ]);
  });
});
