export type SqliteWorkerRequest =
  | { id: number; kind: "probe"; databasePath: string }
  | { id: number; kind: "initialize"; databasePath: string; ownerId: string }
  | { id: number; kind: "getStatus" }
  | { id: number; kind: "dispose" };

export type SqliteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
