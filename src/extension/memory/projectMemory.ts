import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { checkpointAndCloseMemoryDatabase, MemoryStore, openMemoryDatabase } from "./memoryStore";
import type { MemoryItem, MemoryKind, ReadRange, RememberInput, WriteResult } from "./types";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

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
  dispose(): void;
};

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

  // readRange is accepted here as a dependency for future evidence-hash validation
  // (Task 2); Task 1 does not exercise it yet.
  void readRange;

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

    dispose(): void {
      clearInterval(renewTimer);
      store.releaseLease(workspaceKey, ownerId);
      checkpointAndCloseMemoryDatabase(database);
    },
  };
}
