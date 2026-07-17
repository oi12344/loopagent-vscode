export type CodeChunkKind = "file_card" | "symbol_card";

export type CodeChunk = {
  id: string;
  fileId: string;
  nodeId?: string;
  semanticKey: string;
  chunkKind: CodeChunkKind;
  sourceText: string;
  searchText: string;
  embeddingText: string;
  sourceHash: string;
  searchHash: string;
  embeddingHash: string;
  startLine?: number;
  endLine?: number;
};
