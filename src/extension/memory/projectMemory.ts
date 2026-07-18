import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { checkpointAndCloseMemoryDatabase, MemoryStore, openMemoryDatabase } from "./memoryStore";
import type { MemoryItem, MemoryKind, ReadRange, RememberInput, WriteResult } from "./types";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

const CREDENTIAL_PATTERN =
  /\b(?:api[_ -]?key|(?:access|refresh|auth)[_ -]?token|secret|token|password|credential)\b\s*[:=]\s*\S+/i;
const BEARER_PATTERN = /\bbearer\s+\S+|\bsk-[a-z0-9_-]{8,}/i;

function containsSensitiveContent(text: string): boolean {
  return CREDENTIAL_PATTERN.test(text) || BEARER_PATTERN.test(text);
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
