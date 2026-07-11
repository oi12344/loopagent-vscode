const yauzl = require("yauzl");

const REQUIRED_ENTRIES = [
  "extension/package.json",
  "extension/resources/loopagent.svg",
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
  "extension/dist/sqliteIndexWorker.js",
  "extension/dist/tree-sitter/web-tree-sitter.wasm",
  "extension/dist/tree-sitter/tree-sitter-typescript.wasm",
  "extension/dist/tree-sitter/tree-sitter-tsx.wasm",
  "extension/dist/tree-sitter/tree-sitter-javascript.wasm",
  "extension/dist/tree-sitter/tree-sitter-python.wasm",
];

const FORBIDDEN_PATH =
  /^extension\/(?:dist\/test|test|src|scripts|docs|\.local-vscode-[^/]*|\.artifacts)(?:\/|$)/i;
const SENSITIVE_PATH =
  /(?:^|\/)\.env(?:[./_-]|$)|secret|token|api[-_]?key/i;

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/");
}

function validateVsixEntries(entries) {
  const normalizedEntries = entries.map(normalizeEntry);
  const entrySet = new Set(normalizedEntries);

  return {
    missing: REQUIRED_ENTRIES.filter((entry) => !entrySet.has(entry)),
    forbidden: normalizedEntries.filter(
      (entry) => FORBIDDEN_PATH.test(entry) || SENSITIVE_PATH.test(entry),
    ),
  };
}

function readVsixEntries(vsixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      const entries = [];
      zipFile.on("entry", (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.once("end", () => resolve(entries));
      zipFile.once("error", reject);
      zipFile.readEntry();
    });
  });
}

async function assertVsixContents(vsixPath) {
  const entries = await readVsixEntries(vsixPath);
  const { missing, forbidden } = validateVsixEntries(entries);

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `VSIX content validation failed: missing=${JSON.stringify(missing)} forbidden=${JSON.stringify(forbidden)}`,
    );
  }

  return entries;
}

module.exports = { assertVsixContents, readVsixEntries, validateVsixEntries };
