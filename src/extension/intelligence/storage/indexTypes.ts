import type {
  CodeEdge,
  CodeNode,
  ImportBinding,
  IndexDiagnostic,
  UnresolvedReference,
} from "../graph/graphTypes";
import type { CodeChunk } from "../chunking/chunkTypes";

export type IndexJobEvent = "create" | "change" | "delete";
export type IndexJobStatus = "pending" | "running" | "failed";
export type FileIndexState = "pending" | "indexing" | "ready" | "failed" | "deleted";
export type EmbeddingStatus = "pending" | "ready" | "failed";

export type SnapshotFile = {
  id: string;
  uri: string;
  path: string;
  languageId: string;
  contentHash: string;
  byteLength: number;
};

export type SnapshotNode = CodeNode & { fileId: string; semanticKey: string };
export type SnapshotEdge = CodeEdge & {
  fileId: string;
  sourceNodeId: string;
  targetNodeId: string;
};
export type SnapshotImportBinding = ImportBinding & {
  id: string;
  fileId: string;
  resolvedFileId?: string;
};
export type SnapshotReference = UnresolvedReference & { id: string; fileId: string };
export type SnapshotDiagnostic = IndexDiagnostic & { id: string; fileId: string };

export type ExtractionSnapshot = {
  file: SnapshotFile;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  importBindings: SnapshotImportBinding[];
  unresolvedReferences: SnapshotReference[];
  diagnostics: SnapshotDiagnostic[];
  chunks: CodeChunk[];
};
