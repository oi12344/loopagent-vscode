import { expect, it, vi } from "vitest";

import { checkpointAndCloseIndexDatabase } from "../../src/extension/intelligence/storage/indexDatabase";

it("closes the database even when the WAL checkpoint fails", () => {
  const checkpointError = new Error("checkpoint failed");
  const database = {
    exec: vi.fn(() => { throw checkpointError; }),
    close: vi.fn(),
  };

  expect(() => checkpointAndCloseIndexDatabase(database)).toThrow(checkpointError);
  expect(database.exec).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(database.close).toHaveBeenCalledOnce();
});
