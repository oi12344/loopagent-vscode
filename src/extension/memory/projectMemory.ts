import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { checkpointAndCloseMemoryDatabase, MemoryStore, openMemoryDatabase } from "./memoryStore";
import type {
  MemoryContext,
  MemoryEvidence,
  MemoryExclusionReason,
  MemoryItem,
  MemoryKind,
  ReadRange,
  RememberInput,
  WriteResult,
} from "./types";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

// 读取流程 caps (design doc "容量与保留"): a single retrieval injects at most 4
// fact/decision items and 2 lesson items, totaling at most 2,400 rendered characters.
const MAX_FACT_OR_DECISION_ITEMS = 4;
const MAX_LESSON_ITEMS = 2;
const MAX_PROMPT_CHARS = 2_400;
const MAX_SEARCH_CANDIDATES = 12;

const MEMORY_BLOCK_OPEN = '<project-memory-data trust="untrusted">\n';
const MEMORY_BLOCK_CLOSE = "\n</project-memory-data>";

// Labeled credentials: "api_key: xxx", "the password is xxx", "token=xxx".
const CREDENTIAL_PATTERN =
  /\b(?:api[_ -]?key|(?:access|refresh|auth)[_ -]?token|secret|token|password|credential)\b\s*(?:is|[:=])\s*\S+/i;
// Known vendor token prefixes and auth headers, unlabeled.
const KNOWN_TOKEN_PATTERN =
  /\bbearer\s+\S+|\bsk-[a-z0-9_-]{8,}|\bgh[oprsu]_[a-z0-9]{10,}|\bgithub_pat_[a-z0-9_]{10,}|\bxox[baprs]-[a-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}/i;
// Bare pasted secrets with no label: long runs mixing letter case and digits are very
// unlikely in ordinary prose (unlike hex hashes or UUIDs, which stay one case).
// ponytail: entropy proxy is "mixed char classes + length", not real Shannon entropy;
// widen to a real entropy calculation if false negatives (e.g. long lowercase-only
// secrets) show up in practice.
const TOKEN_CANDIDATE_PATTERN = /[A-Za-z0-9+/_.-]{20,}/g;

function looksLikeBareToken(candidate: string): boolean {
  const hasLower = /[a-z]/.test(candidate);
  const hasUpper = /[A-Z]/.test(candidate);
  const hasDigit = /[0-9]/.test(candidate);
  return [hasLower, hasUpper, hasDigit].filter(Boolean).length >= 2;
}

function containsSensitiveContent(text: string): boolean {
  if (CREDENTIAL_PATTERN.test(text) || KNOWN_TOKEN_PATTERN.test(text)) return true;
  for (const [candidate] of text.matchAll(TOKEN_CANDIDATE_PATTERN)) {
    if (looksLikeBareToken(candidate)) return true;
  }
  return false;
}

const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision"];

export type ProjectMemoryOptions = {
  now?: () => number;
  ownerId?: string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
};

export type ProjectMemory = {
  getGeneration(): number;
  remember(input: RememberInput): WriteResult;
  list(): MemoryItem[];
  forget(expectedGeneration: number): WriteResult;
  loadContext(task: string): Promise<MemoryContext>;
  dispose(): void;
};

const EMPTY_CONTEXT_TRACE = { candidateCount: 0, includedIds: [], excluded: [] };

/** Extracts safe literal word tokens from free-form task text for use as an FTS5 MATCH
 * query. Only unicode letters/digits survive, each individually quoted, so FTS5 query
 * syntax (AND/OR/NOT, column filters, parens, quotes) in the task text can never be
 * interpreted as query syntax -- it is just discarded as non-token noise. */
function buildFtsMatchQuery(task: string): string | undefined {
  const tokens = [...task.matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
  const uniqueTokens = [...new Set(tokens)].slice(0, 12);
  if (uniqueTokens.length === 0) return undefined;
  return uniqueTokens.map((token) => `"${token}"`).join(" OR ");
}

async function verifyEvidence(evidence: MemoryEvidence[], readRange: ReadRange): Promise<boolean> {
  for (const entry of evidence) {
    if (!entry.sha256 || entry.startLine === undefined || entry.endLine === undefined) continue;
    if (entry.required === false) continue;
    try {
      const content = await readRange(entry.filePath, entry.startLine, entry.endLine);
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (actualHash !== entry.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function toMemoryEntry(item: MemoryItem): { kind: MemoryKind; subject: string; content: string; sources: string[] } {
  return {
    kind: item.kind,
    subject: item.subject,
    content: item.content,
    sources: item.evidence.length > 0 ? item.evidence.map((entry) => entry.filePath) : ["user_confirmation"],
  };
}

/** Escapes "<" so a memory item's content can never contain a literal
 * "</project-memory-data>" (or any other tag-like text) that reads as real markup once
 * embedded in the prompt -- escaping must hold regardless of where this block sits in the
 * final prompt, not rely on it happening to be appended last. */
function escapeMemoryJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function renderMemoryPrompt(payload: ReturnType<typeof toMemoryEntry>[]): string {
  return `${MEMORY_BLOCK_OPEN}${escapeMemoryJson(JSON.stringify(payload))}${MEMORY_BLOCK_CLOSE}`;
}

/**
 * Public service for manual project memory: remember/list/forget, backed by the
 * V1 SQLite schema in memoryStore.ts. Holds a renewable writer lease for as long
 * as this instance is open so at most one process can mutate a workspace's memory.
 *
 * ponytail: leases renew on a plain setInterval; only move this to a worker thread
 * if a real workspace shows main-thread stalls from SQLite calls.
 */
export function openProjectMemory(
  databasePath: string,
  workspaceKey: string,
  readRange: ReadRange,
  options: ProjectMemoryOptions = {},
): ProjectMemory {
  const database: DatabaseSync = openMemoryDatabase(databasePath);
  const store = new MemoryStore(database, options.now ?? Date.now);
  const ownerId = options.ownerId ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;

  // Result intentionally discarded: if another owner currently holds the lease this is a
  // read-only instance until the renew loop below successfully takes over after expiry.
  store.acquireLease(workspaceKey, ownerId, leaseTtlMs);
  const renewTimer = setInterval(() => {
    if (!store.renewLease(workspaceKey, ownerId, leaseTtlMs)) {
      store.acquireLease(workspaceKey, ownerId, leaseTtlMs);
    }
  }, renewIntervalMs);
  renewTimer.unref?.();

  return {
    getGeneration: () => store.getGeneration(workspaceKey),

    remember(input: RememberInput): WriteResult {
      if (!MEMORY_KINDS.includes(input.kind)) {
        return { ok: false, reason: "invalid_input" };
      }
      if (containsSensitiveContent(input.subject) || containsSensitiveContent(input.content)) {
        return { ok: false, reason: "sensitive_content" };
      }
      return store.remember(workspaceKey, ownerId, input.expectedGeneration, {
        kind: input.kind,
        subject: input.subject,
        content: input.content,
        confidence: input.confidence ?? "stated",
        evidence: input.evidence ?? [],
        expiresAt: input.expiresAt,
      });
    },

    list: () => store.list(workspaceKey),

    forget: (expectedGeneration: number) => store.forget(workspaceKey, ownerId, expectedGeneration),

    async loadContext(task: string): Promise<MemoryContext> {
      // Any exception anywhere in this method -- including reading the generation itself --
      // degrades to an empty-prompt context; a broken store must never block a run.
      try {
        const generation = store.getGeneration(workspaceKey);
        const matchQuery = buildFtsMatchQuery(task);
        if (!matchQuery) return { generation, prompt: "", trace: EMPTY_CONTEXT_TRACE };

        const candidates = store.search(workspaceKey, matchQuery, MAX_SEARCH_CANDIDATES);
        const included: MemoryItem[] = [];
        const payload: ReturnType<typeof toMemoryEntry>[] = [];
        const staleIds: number[] = [];
        const excluded: { id: number; reason: MemoryExclusionReason }[] = [];
        let factOrDecisionCount = 0;
        let lessonCount = 0;

        for (const item of candidates) {
          if (item.kind === "lesson" ? lessonCount >= MAX_LESSON_ITEMS : factOrDecisionCount >= MAX_FACT_OR_DECISION_ITEMS) {
            excluded.push({ id: item.id, reason: "cap" });
            continue;
          }
          const fresh = await verifyEvidence(item.evidence, readRange);
          if (!fresh) {
            staleIds.push(item.id);
            excluded.push({ id: item.id, reason: "evidence_mismatch" });
            continue;
          }
          // Measure the exact rendered array length with this candidate appended (not just
          // the entry's own length) so brackets/commas count toward the real 2,400-char cap.
          const tentativePayload = [...payload, toMemoryEntry(item)];
          if (JSON.stringify(tentativePayload).length > MAX_PROMPT_CHARS) {
            excluded.push({ id: item.id, reason: "budget" });
            continue;
          }
          payload.push(toMemoryEntry(item));
          included.push(item);
          if (item.kind === "lesson") lessonCount++;
          else factOrDecisionCount++;
        }

        if (staleIds.length > 0) store.markStale(workspaceKey, ownerId, staleIds);

        const prompt = payload.length > 0 ? renderMemoryPrompt(payload) : "";
        return {
          generation,
          prompt,
          trace: { candidateCount: candidates.length, includedIds: included.map((item) => item.id), excluded },
        };
      } catch {
        // Generation is unknown if the store itself failed; 0 matches the documented
        // fallback for a workspace with no meta row yet.
        return { generation: 0, prompt: "", trace: EMPTY_CONTEXT_TRACE };
      }
    },

    dispose(): void {
      clearInterval(renewTimer);
      store.releaseLease(workspaceKey, ownerId);
      checkpointAndCloseMemoryDatabase(database);
    },
  };
}
