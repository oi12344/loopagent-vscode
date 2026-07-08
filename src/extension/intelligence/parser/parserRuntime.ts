import type { IndexDiagnostic } from "../graph/graphTypes";

export type ParsedSource = {
  filePath: string;
  languageId: string;
  text: string;
  tree: unknown;
  diagnostics: IndexDiagnostic[];
};

export type ParserRuntime = {
  parse(filePath: string, languageId: string, text: string): Promise<ParsedSource>;
};
