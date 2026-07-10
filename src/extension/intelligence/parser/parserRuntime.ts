import type { IndexDiagnostic } from "../graph/graphTypes";

export type SyntaxPoint = {
  row: number;
  column: number;
};

export type SyntaxNode = {
  type: string;
  text: string;
  isNamed: boolean;
  hasError: boolean;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  namedChildren: readonly SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
};

export type SyntaxTree = {
  rootNode: SyntaxNode;
  delete(): void;
};

export type ParsedSource = {
  filePath: string;
  languageId: string;
  text: string;
  tree: SyntaxTree | undefined;
  diagnostics: IndexDiagnostic[];
};

export type ParserRuntime = {
  parse(filePath: string, languageId: string, text: string): Promise<ParsedSource>;
};
