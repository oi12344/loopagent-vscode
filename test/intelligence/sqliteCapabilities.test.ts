import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { probeSqliteCapabilities } from "../../src/extension/intelligence/storage/sqliteCapabilities";

it("probes sqlite, WAL, foreign keys, and FTS5", () => {
  const directory = mkdtempSync(join(tmpdir(), "loopagent-sqlite-"));
  try {
    expect(probeSqliteCapabilities(join(directory, "probe.sqlite"))).toEqual({
      sqlite: true,
      wal: true,
      foreignKeys: true,
      fts5: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
