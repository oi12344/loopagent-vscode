import path from "node:path";

import { Language, Parser } from "web-tree-sitter";

import type { IndexDiagnostic } from "../graph/graphTypes";
import type { ParsedSource, ParserRuntime, SyntaxTree } from "./parserRuntime";

export type TreeSitterLanguageId =
  | "typescript"
  | "typescriptreact"
  | "javascript"
  | "javascriptreact"
  | "python"
  | "java";

export type TreeSitterParserRuntimeOptions = {
  wasmDirectory?: string;
  parserWasmPath?: string;
  grammarWasmDirectory?: string;
  languageWasmPaths?: Partial<Record<TreeSitterLanguageId, string>>;
};

const LANGUAGE_WASM_BY_ID: Record<TreeSitterLanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  java: "tree-sitter-java.wasm",
};

const initPromises = new Map<string, Promise<void>>();
const languagePromises = new Map<string, Promise<Language>>();

export async function getTreeSitterParser(
  languageId: string,
  options: TreeSitterParserRuntimeOptions = {},
): Promise<Parser> {
  const normalizedLanguageId = normalizeLanguageId(languageId);
  if (!normalizedLanguageId) {
    throw new Error(`Tree-sitter does not support language ${languageId}`);
  }

  const wasmDirectory = options.wasmDirectory ?? path.join(__dirname, "tree-sitter");
  const parserWasmPath = options.parserWasmPath ?? path.join(wasmDirectory, "web-tree-sitter.wasm");
  const grammarWasmDirectory = options.grammarWasmDirectory ?? wasmDirectory;
  await initializeParser(parserWasmPath);

  const wasmPath =
    options.languageWasmPaths?.[normalizedLanguageId] ??
    path.join(grammarWasmDirectory, LANGUAGE_WASM_BY_ID[normalizedLanguageId]);
  const languageKey = `${parserWasmPath}:${wasmPath}`;
  let languagePromise = languagePromises.get(languageKey);
  if (!languagePromise) {
    languagePromise = Language.load(wasmPath);
    languagePromises.set(languageKey, languagePromise);
  }

  const parser = new Parser();
  parser.setLanguage(await languagePromise);
  return parser;
}

export function createTreeSitterParserRuntime(options: TreeSitterParserRuntimeOptions = {}): ParserRuntime {
  const wasmDirectory = options.wasmDirectory ?? path.join(__dirname, "tree-sitter");
  const parserWasmPath = options.parserWasmPath ?? path.join(wasmDirectory, "web-tree-sitter.wasm");
  const grammarWasmDirectory = options.grammarWasmDirectory ?? wasmDirectory;
  const languages = new Map<TreeSitterLanguageId, Promise<Language>>();

  return {
    async parse(filePath, languageId, text) {
      const normalizedLanguageId = normalizeLanguageId(languageId);
      if (!normalizedLanguageId) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(filePath, `Tree-sitter 不支持语言 ${languageId}，已降级为轻量抽取。`),
        ]);
      }

      let parser: Parser | undefined;
      try {
        await initializeParser(parserWasmPath);
        const language = await loadLanguage(normalizedLanguageId);
        parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(text);
        if (!tree) {
          return createParsedSource(filePath, languageId, text, undefined, [
            createWarning(filePath, "Tree-sitter 未返回语法树，已降级为轻量抽取。"),
          ]);
        }
        return createParsedSource(filePath, languageId, text, tree, []);
      } catch (error) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(
            filePath,
            `Tree-sitter 解析失败，已降级为轻量抽取：${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
      } finally {
        parser?.delete();
      }
    },
  };

  function loadLanguage(languageId: TreeSitterLanguageId): Promise<Language> {
    const existing = languages.get(languageId);
    if (existing) {
      return existing;
    }

    const wasmPath =
      options.languageWasmPaths?.[languageId] ?? path.join(grammarWasmDirectory, LANGUAGE_WASM_BY_ID[languageId]);
    const promise = Language.load(wasmPath);
    languages.set(languageId, promise);
    return promise;
  }
}

function initializeParser(parserWasmPath: string): Promise<void> {
  const existing = initPromises.get(parserWasmPath);
  if (existing) {
    return existing;
  }

  const promise = Parser.init({
    locateFile(scriptName: string) {
      return scriptName.endsWith(".wasm") ? parserWasmPath : scriptName;
    },
  });
  initPromises.set(parserWasmPath, promise);
  return promise;
}

function normalizeLanguageId(languageId: string): TreeSitterLanguageId | undefined {
  if (languageId in LANGUAGE_WASM_BY_ID) {
    return languageId as TreeSitterLanguageId;
  }
  return undefined;
}

function createParsedSource(
  filePath: string,
  languageId: string,
  text: string,
  tree: SyntaxTree | undefined,
  diagnostics: IndexDiagnostic[],
): ParsedSource {
  return {
    filePath,
    languageId,
    text,
    tree,
    diagnostics,
  };
}

function createWarning(filePath: string, message: string): IndexDiagnostic {
  return {
    filePath,
    severity: "warning",
    message,
  };
}
