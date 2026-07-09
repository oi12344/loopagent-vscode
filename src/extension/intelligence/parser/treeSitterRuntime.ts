import path from "node:path";

import { Language, Parser } from "web-tree-sitter";

import type { IndexDiagnostic } from "../graph/graphTypes";
import type { ParsedSource, ParserRuntime } from "./parserRuntime";

export type TreeSitterLanguageId = "typescript" | "typescriptreact" | "javascript" | "javascriptreact" | "python";

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
};

const initPromises = new Map<string, Promise<void>>();

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

      try {
        await initializeParser(parserWasmPath);
        const language = await loadLanguage(normalizedLanguageId);
        const parser = new Parser();
        parser.setLanguage(language);
        return createParsedSource(filePath, languageId, text, parser.parse(text), []);
      } catch (error) {
        return createParsedSource(filePath, languageId, text, undefined, [
          createWarning(
            filePath,
            `Tree-sitter 解析失败，已降级为轻量抽取：${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
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
  tree: unknown,
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
