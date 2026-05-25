import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import Migration from "./033_LegacyModelSelectionEvents.ts";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-033-"));
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

describe("033_LegacyModelSelectionEvents", () => {
  it("backfills required model fields from legacy model selection payloads", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`
            CREATE TABLE orchestration_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL
            )
          `;

          yield* sql`
            INSERT INTO orchestration_events (event_type, payload_json)
            VALUES
              (
                'project.created',
                '{"projectId":"project-1","defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}'
              ),
              (
                'thread.created',
                '{"threadId":"thread-1","modelSelection":{"instanceId":"codex","model":"gpt-5.5"}}'
              )
          `;

          yield* Migration;

          const rows = yield* sql<{
            readonly eventType: string;
            readonly defaultModel: string | null;
            readonly model: string | null;
          }>`
            SELECT
              event_type AS "eventType",
              json_extract(payload_json, '$.defaultModel') AS "defaultModel",
              json_extract(payload_json, '$.model') AS "model"
            FROM orchestration_events
            ORDER BY sequence ASC
          `;

          expect(rows).toEqual([
            { eventType: "project.created", defaultModel: "gpt-5.4", model: null },
            { eventType: "thread.created", defaultModel: null, model: "gpt-5.5" },
          ]);
        }),
      );
    });
  });
});
