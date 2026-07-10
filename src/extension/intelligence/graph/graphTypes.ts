export type CodeNodeKind =
  | "file"
  | "module"
  | "package"
  | "namespace"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "type"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "import"
  | "export";

export type CodeEdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "type_of"
  | "returns"
  | "instantiates";

export type CodeNode = {
  id: string;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  signature?: string;
  isExported?: boolean;
  metadata?: Record<string, unknown>;
};

export type CodeEdge = {
  id: string;
  source: string;
  target: string;
  kind: CodeEdgeKind;
  filePath?: string;
  line?: number;
  column?: number;
  confidence: "exact" | "probable" | "heuristic";
  metadata?: Record<string, unknown>;
};

export type CallCalleeKind = "identifier" | "member" | "dynamic";

export type ImportBinding = {
  filePath: string;
  localName: string;
  importedName: string;
  source: string;
  resolvedFilePath?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
  languageId: string;
};

export type UnresolvedReference = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: "calls" | "references" | "type_of" | "extends" | "implements" | "instantiates";
  filePath: string;
  line: number;
  column?: number;
  localScope?: string;
  importSource?: string;
  languageId: string;
  calleeKind?: CallCalleeKind;
  receiverName?: string;
  confidenceHint?: CodeEdge["confidence"];
  metadata?: Record<string, unknown>;
};

export type IndexDiagnostic = {
  filePath: string;
  severity: "error" | "warning";
  message: string;
};
