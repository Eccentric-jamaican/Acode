import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import Migration from "./038_LegacyRuntimeModeRepair.ts";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-038-"));
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

describe("038_LegacyRuntimeModeRepair", () => {
  it("maps legacy auto-accept-edits runtime mode to full-access", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`
            CREATE TABLE provider_session_runtime (
              thread_id TEXT PRIMARY KEY,
              runtime_mode TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_threads (
              thread_id TEXT PRIMARY KEY,
              runtime_mode TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_thread_sessions (
              thread_id TEXT PRIMARY KEY,
              runtime_mode TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_project_rules (
              project_id TEXT PRIMARY KEY,
              default_runtime_mode TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE orchestration_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL
            )
          `;

          yield* sql`
            INSERT INTO provider_session_runtime (thread_id, runtime_mode)
            VALUES ('thread-provider', 'auto-accept-edits')
          `;
          yield* sql`
            INSERT INTO projection_threads (thread_id, runtime_mode)
            VALUES ('thread-projection', 'auto-accept-edits')
          `;
          yield* sql`
            INSERT INTO projection_thread_sessions (thread_id, runtime_mode)
            VALUES ('thread-session', 'auto-accept-edits')
          `;
          yield* sql`
            INSERT INTO projection_project_rules (project_id, default_runtime_mode)
            VALUES ('project-1', 'auto-accept-edits')
          `;
          yield* sql`
            INSERT INTO orchestration_events (event_type, payload_json)
            VALUES
              ('thread.created', '{"runtimeMode":"auto-accept-edits"}'),
              ('project.orchestration-rules-updated', '{"defaultRuntimeMode":"auto-accept-edits"}'),
              ('thread.session-set', '{"session":{"runtimeMode":"auto-accept-edits"}}')
          `;

          yield* Migration;

          const rows = yield* sql<{
            readonly source: string;
            readonly runtimeMode: string;
          }>`
            SELECT 'provider' AS "source", runtime_mode AS "runtimeMode"
            FROM provider_session_runtime
            UNION ALL
            SELECT 'thread' AS "source", runtime_mode AS "runtimeMode"
            FROM projection_threads
            UNION ALL
            SELECT 'session' AS "source", runtime_mode AS "runtimeMode"
            FROM projection_thread_sessions
            UNION ALL
            SELECT 'rules' AS "source", default_runtime_mode AS "runtimeMode"
            FROM projection_project_rules
            UNION ALL
            SELECT event_type AS "source",
              COALESCE(
                json_extract(payload_json, '$.runtimeMode'),
                json_extract(payload_json, '$.defaultRuntimeMode'),
                json_extract(payload_json, '$.session.runtimeMode')
              ) AS "runtimeMode"
            FROM orchestration_events
            ORDER BY "source" ASC
          `;

          expect(rows).toEqual([
            { source: "project.orchestration-rules-updated", runtimeMode: "full-access" },
            { source: "provider", runtimeMode: "full-access" },
            { source: "rules", runtimeMode: "full-access" },
            { source: "session", runtimeMode: "full-access" },
            { source: "thread", runtimeMode: "full-access" },
            { source: "thread.created", runtimeMode: "full-access" },
            { source: "thread.session-set", runtimeMode: "full-access" },
          ]);
        }),
      );
    });
  });
});
