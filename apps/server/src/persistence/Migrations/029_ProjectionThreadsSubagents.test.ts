import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import Migration0029 from "./029_ProjectionThreadsSubagents.ts";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-029-"));
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

describe("029_ProjectionThreadsSubagents", () => {
  it("adds parent/subagent columns to projection_threads", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`
            CREATE TABLE projection_threads (
              thread_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              origin TEXT NOT NULL,
              task_id TEXT,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              runtime_mode TEXT NOT NULL,
              interaction_mode TEXT NOT NULL DEFAULT 'default',
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

          yield* Migration0029;

          const rows = yield* sql<{
            readonly parentThreadId: string | null;
            readonly subagentAgentId: string | null;
            readonly subagentNickname: string | null;
            readonly subagentRole: string | null;
          }>`
            SELECT
              parent_thread_id AS "parentThreadId",
              subagent_agent_id AS "subagentAgentId",
              subagent_nickname AS "subagentNickname",
              subagent_role AS "subagentRole"
            FROM projection_threads
          `;

          expect(rows).toEqual([]);
        }),
      );
    });
  });
});
