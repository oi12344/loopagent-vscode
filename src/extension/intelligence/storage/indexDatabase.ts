import { existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { applyIndexMigrations, CURRENT_INDEX_SCHEMA_VERSION } from "./indexMigrations";

export type OpenIndexDatabaseResult = {
  database: DatabaseSync;
  backupPath?: string;
  close(): void;
};

export function openIndexDatabase(databasePath: string, options: { now?: () => number } = {}): OpenIndexDatabaseResult {
  let database = new DatabaseSync(databasePath);
  const version = Number(database.prepare("PRAGMA user_version").get()!.user_version);
  let backupPath: string | undefined;

  if (version > CURRENT_INDEX_SCHEMA_VERSION) {
    database.close();
    backupPath = `${databasePath}.backup-${(options.now ?? Date.now)()}`;
    moveDatabaseFiles(databasePath, backupPath);
    database = new DatabaseSync(databasePath);
  }

  configureDatabase(database);
  applyIndexMigrations(database);
  return {
    database,
    backupPath,
    close: () => checkpointAndCloseIndexDatabase(database),
  };
}

export function checkpointAndCloseIndexDatabase(
  database: Pick<DatabaseSync, "exec" | "close">,
): void {
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
}

function moveDatabaseFiles(databasePath: string, backupPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${databasePath}${suffix}`;
    if (existsSync(source)) {
      renameSync(source, `${backupPath}${suffix}`);
    }
  }
}
