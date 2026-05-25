import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import Migration from "./034_LegacyProjectionSchemaRepair.ts";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-034-"));
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

describe("034_LegacyProjectionSchemaRepair", () => {
  it("repairs legacy projection schemas required by snapshot hydration", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`
            CREATE TABLE orchestration_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              stream_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_projects (
              project_id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              scripts_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT,
              default_model_selection_json TEXT
            )
          `;
          yield* sql`
            CREATE TABLE projection_threads (
              thread_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              title TEXT NOT NULL,
              branch TEXT,
              worktree_path TEXT,
              latest_turn_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT,
              model_selection_json TEXT
            )
          `;
          yield* sql`
            CREATE TABLE projection_turns (
              row_id INTEGER PRIMARY KEY AUTOINCREMENT,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              pending_message_id TEXT,
              assistant_message_id TEXT,
              state TEXT NOT NULL,
              requested_at TEXT NOT NULL,
              started_at TEXT,
              completed_at TEXT,
              checkpoint_turn_count INTEGER,
              checkpoint_ref TEXT,
              checkpoint_status TEXT,
              checkpoint_files_json TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_thread_messages (
              message_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              role TEXT NOT NULL,
              text TEXT NOT NULL,
              is_streaming INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_thread_activities (
              activity_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              tone TEXT NOT NULL,
              kind TEXT NOT NULL,
              summary TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_thread_sessions (
              thread_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              provider_name TEXT,
              provider_session_id TEXT,
              provider_thread_id TEXT,
              active_turn_id TEXT,
              last_error TEXT,
              updated_at TEXT NOT NULL
            )
          `;
          yield* sql`
            CREATE TABLE projection_state (
              projector TEXT PRIMARY KEY,
              last_applied_sequence INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
          `;

          yield* sql`
            INSERT INTO projection_projects (
              project_id,
              title,
              workspace_root,
              scripts_json,
              created_at,
              updated_at,
              default_model_selection_json
            )
            VALUES (
              'project-1',
              'Project',
              'C:/work',
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              '{"model":"gpt-5.1"}'
            )
          `;
          yield* sql`
            INSERT INTO projection_threads (
              thread_id,
              project_id,
              title,
              created_at,
              updated_at,
              model_selection_json
            )
            VALUES (
              'thread-1',
              'project-1',
              'Thread',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              '{"model":"gpt-5.2"}'
            )
          `;
          yield* sql`
            INSERT INTO projection_turns (
              thread_id,
              turn_id,
              pending_message_id,
              assistant_message_id,
              state,
              requested_at,
              checkpoint_files_json
            )
            VALUES (
              'thread-1',
              'turn-1',
              'message-1',
              'message-2',
              'completed',
              '2026-01-01T00:01:00.000Z',
              '[]'
            )
          `;

          yield* Migration;

          const snapshotRows = yield* sql<{
            readonly projectDefaultModel: string | null;
            readonly threadModel: string;
            readonly origin: string;
            readonly turnInteractionMode: string;
          }>`
            SELECT
              projection_projects.default_model AS "projectDefaultModel",
              projection_threads.model AS "threadModel",
              projection_threads.origin AS "origin",
              projection_turns.interaction_mode AS "turnInteractionMode"
            FROM projection_projects
            JOIN projection_threads ON projection_threads.project_id = projection_projects.project_id
            JOIN projection_turns ON projection_turns.thread_id = projection_threads.thread_id
          `;
          const taskColumns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(projection_tasks)
          `;
          const proposedPlanColumns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(projection_thread_proposed_plans)
          `;

          expect(snapshotRows).toEqual([
            {
              projectDefaultModel: "gpt-5.1",
              threadModel: "gpt-5.2",
              origin: "user",
              turnInteractionMode: "default",
            },
          ]);
          expect(taskColumns.some((column) => column.name === "attachments")).toBe(true);
          expect(proposedPlanColumns.some((column) => column.name === "implemented_at")).toBe(true);
        }),
      );
    });
  });
});
