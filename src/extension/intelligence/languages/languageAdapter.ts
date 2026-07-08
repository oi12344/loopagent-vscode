import type { CodeEdge, CodeNode, ImportBinding, IndexDiagnostic, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";

export type ExtractionResult = {
  nodes: CodeNode[];
  edges: CodeEdge[];
  importBindings: ImportBinding[];
  unresolvedReferences: UnresolvedReference[];
  diagnostics: IndexDiagnostic[];
};

export type LanguageAdapter = {
  id: string;
  languageIds: string[];
  extensions: string[];
  extract(parsed: ParsedSource): ExtractionResult;
};
