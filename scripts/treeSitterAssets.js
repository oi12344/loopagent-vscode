const fs = require("node:fs/promises");
const path = require("node:path");

const TREE_SITTER_ASSETS = [
  {
    packageName: "web-tree-sitter",
    sourcePath: "web-tree-sitter.wasm",
    outputName: "web-tree-sitter.wasm",
  },
  {
    packageName: "@vscode/tree-sitter-wasm",
    sourcePath: path.join("wasm", "tree-sitter-typescript.wasm"),
    outputName: "tree-sitter-typescript.wasm",
  },
  {
    packageName: "@vscode/tree-sitter-wasm",
    sourcePath: path.join("wasm", "tree-sitter-tsx.wasm"),
    outputName: "tree-sitter-tsx.wasm",
  },
  {
    packageName: "@vscode/tree-sitter-wasm",
    sourcePath: path.join("wasm", "tree-sitter-javascript.wasm"),
    outputName: "tree-sitter-javascript.wasm",
  },
  {
    packageName: "@vscode/tree-sitter-wasm",
    sourcePath: path.join("wasm", "tree-sitter-python.wasm"),
    outputName: "tree-sitter-python.wasm",
  },
];

async function copyTreeSitterAssets({ outputDir = path.join(__dirname, "..", "dist", "tree-sitter") } = {}) {
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(
    TREE_SITTER_ASSETS.map(async (asset) => {
      const source = require.resolve(`${asset.packageName}/${asset.sourcePath}`);
      await fs.copyFile(source, path.join(outputDir, asset.outputName));
    }),
  );
}

module.exports = {
  TREE_SITTER_ASSETS,
  copyTreeSitterAssets,
};
