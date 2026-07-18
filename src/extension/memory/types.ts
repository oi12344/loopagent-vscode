export type MemoryKind = "fact" | "decision" | "lesson";

export type MemoryRunOutcome = "success" | "failure" | "partial";

export type MemoryEvidence = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  note?: string;
  /** SHA-256 hex digest of the exact range content at write time, used for freshness checks. */
  sha256?: string;
  /** Defaults to true: an item is excluded from retrieval if any required evidence no longer matches. */
  required?: boolean;
};

/** Reads a byte/line range of a file, used for future evidence-hash validation (Task 2). */
export type ReadRange = (filePath: string, startLine: number, endLine: number) => Promise<string> | string;

export type RememberInput = {
  expectedGeneration: number;
  kind: MemoryKind;
  subject: string;
  content: string;
  confidence?: string;
  evidence?: MemoryEvidence[];
  expiresAt?: number;
};

export type MemoryItem = {
  id: number;
  kind: MemoryKind;
  subject: string;
  content: string;
  status: string;
  confidence: string;
  evidence: MemoryEvidence[];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  supersedesId?: number;
};

export type WriteFailReason = "generation_changed" | "sensitive_content" | "lease_lost" | "invalid_input";

export type WriteResult = { ok: true } | { ok: false; reason: WriteFailReason };

export type MemoryExclusionReason = "evidence_mismatch" | "budget" | "cap";

export type MemoryLoadTrace = {
  candidateCount: number;
  includedIds: number[];
  excluded: { id: number; reason: MemoryExclusionReason }[];
};

export type MemoryContext = {
  generation: number;
  prompt: string;
  trace: MemoryLoadTrace;
};
