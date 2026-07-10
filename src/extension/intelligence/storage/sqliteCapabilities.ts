import { DatabaseSync } from "node:sqlite";

export type SqliteCapabilities = {
  sqlite: boolean;
  wal: boolean;
  foreignKeys: boolean;
  fts5: boolean;
};

export function probeSqliteCapabilities(databasePath: string): SqliteCapabilities {
  const database = new DatabaseSync(databasePath);

  try {
    const journalMode = database.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    database.exec("PRAGMA foreign_keys = ON");
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    database.exec("CREATE VIRTUAL TABLE __loopagent_fts_probe USING fts5(text)");
    database.exec("DROP TABLE __loopagent_fts_probe");

    return {
      sqlite: true,
      wal: journalMode.journal_mode.toLowerCase() === "wal",
      foreignKeys: foreignKeys.foreign_keys === 1,
      fts5: true,
    };
  } finally {
    database.close();
  }
}
