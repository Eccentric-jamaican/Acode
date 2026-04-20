import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import Migration from "./030_ProjectionThreadsPinnedAt.ts";
type SqliteClientModule = {
  layer: (config: { filename: string }) => Layer.Layer<SqlClient.SqlClient>;
};

async function loadSqliteLayer(dbPath: string): Promise<Layer.Layer<SqlClient.SqlClient>> {
  if (process.versions.bun !== undefined) {
    const clientModule = (await import("@effect/sql-sqlite-bun/SqliteClient")) as SqliteClientModule;
    return clientModule.layer({ filename: dbPath });
  }
  const clientModule = (await import("../NodeSqliteClient.ts")) as SqliteClientModule;
  return clientModule.layer({ filename: dbPath });
}

async function withTempSqlite<A>(
  callback: (runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>) => Promise<A>,
): Promise<A> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-030-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const sqliteLayer = await loadSqliteLayer(dbPath);
  const runtime = ManagedRuntime.make(sqliteLayer);

  try {
    return await callback(runtime);
  } finally {
    await runtime.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("030_ProjectionThreadsPinnedAt", () => {
  it("adds pinned_at to projection_threads", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`
            CREATE TABLE projection_threads (
              thread_id TEXT PRIMARY KEY NOT NULL,
              project_id TEXT NOT NULL,
              origin TEXT NOT NULL,
              task_id TEXT,
              parent_thread_id TEXT,
              subagent_agent_id TEXT,
              subagent_nickname TEXT,
              subagent_role TEXT,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              runtime_mode TEXT NOT NULL,
              interaction_mode TEXT NOT NULL,
              branch TEXT,
              worktree_path TEXT,
              is_pinned INTEGER NOT NULL DEFAULT 0,
              handoff_json TEXT,
              latest_turn_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            )
          `;

          yield* Migration;

          const rows = yield* sql<{
            readonly pinnedAt: string | null;
          }>`
            SELECT pinned_at AS "pinnedAt"
            FROM projection_threads
          `;

          expect(rows).toEqual([]);
        }),
      );
    });
  });
});
