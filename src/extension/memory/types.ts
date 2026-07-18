export type MemoryKind = "fact" | "decision";

export type MemoryRunOutcome = "success" | "failure" | "partial";

export type MemoryEvidence = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  note?: string;
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
