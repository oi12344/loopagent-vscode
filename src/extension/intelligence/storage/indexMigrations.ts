import type { DatabaseSync } from "node:sqlite";

import { INDEX_SCHEMA_V1, INDEX_SCHEMA_V2_FTS } from "./indexSchema";

export const CURRENT_INDEX_SCHEMA_VERSION = 2;

export function applyIndexMigrations(database: DatabaseSync): void {
  const version = Number(database.prepare("PRAGMA user_version").get()!.user_version);
  if (version > CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(`Database has newer schema version ${version}`);
  }
  if (version === CURRENT_INDEX_SCHEMA_VERSION) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      database.exec(INDEX_SCHEMA_V1);
      database.prepare("INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)").run(1, "initial index schema", Date.now());
    }
    if (version < 2) {
      database.exec(INDEX_SCHEMA_V2_FTS);
      database.prepare("INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)").run(2, "add FTS search index", Date.now());
    }
    database.exec(`PRAGMA user_version = ${CURRENT_INDEX_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
