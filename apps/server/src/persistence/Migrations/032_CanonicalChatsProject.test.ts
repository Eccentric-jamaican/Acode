import { ManagedRuntime, Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeCanonicalChatsProjectMigration } from "./032_CanonicalChatsProject.ts";

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-migration-032-"));
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

describe("032_CanonicalChatsProject", () => {
  it("renames only the canonical chats project and backfills its thread worktree folders", async () => {
    await withTempSqlite(async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tempRoot = path.join(os.tmpdir(), `t3-chat-root-${process.pid}-${Date.now()}`);
          const chatWorkspaceRoot = path.join(tempRoot, "Documents", "A Code", "Chats");
          const legacyChatWorkspaceRoot = path.join(tempRoot, ".codex", "chats");
          const legacyCodexChatWorkspaceRoot = path.join(tempRoot, "Documents", "Codex");
          const legacyT3ChatWorkspaceRoot = path.join(tempRoot, "Documents", "T3 Code", "Chats");
          const userHomeRoot = path.join(tempRoot, "Addis");
          const existingLegacyThreadPath = path.join(
            legacyChatWorkspaceRoot,
            "thread-chat-existing",
          );
          const missingChatThreadPath = path.join(
            chatWorkspaceRoot,
            "2026-05-01",
            "chat-missing-worktree",
          );
          const createdDirectories: string[] = [];

          yield* sql`
            CREATE TABLE projection_projects (
              project_id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              default_model TEXT,
              scripts_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            )
          `;

          yield* sql`
            CREATE TABLE projection_threads (
              thread_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              title TEXT NOT NULL,
              model TEXT NOT NULL,
              worktree_path TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            )
          `;

          yield* sql`
            CREATE TABLE orchestration_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id TEXT NOT NULL UNIQUE,
              aggregate_kind TEXT NOT NULL,
              stream_id TEXT NOT NULL,
              stream_version INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              occurred_at TEXT NOT NULL,
              command_id TEXT,
              causation_event_id TEXT,
              correlation_id TEXT,
              actor_kind TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL
            )
          `;

          yield* sql`
            INSERT INTO projection_projects (
              project_id,
              title,
              workspace_root,
              default_model,
              scripts_json,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES
              (
                'project-chat',
                'Home',
                ${legacyCodexChatWorkspaceRoot},
                'gpt-5-codex',
                '[]',
                '2026-05-01T12:00:00.000Z',
                '2026-05-01T12:00:00.000Z',
                NULL
              ),
              (
                'project-user-home',
                'Home',
                ${userHomeRoot},
                'gpt-5-codex',
                '[]',
                '2026-05-01T12:00:00.000Z',
                '2026-05-01T12:00:00.000Z',
                NULL
              )
          `;

          yield* sql`
            INSERT INTO projection_threads (
              thread_id,
              project_id,
              title,
              model,
              worktree_path,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES
              (
                'thread-chat-missing',
                'project-chat',
                'Chat missing worktree',
                'gpt-5-codex',
                NULL,
                '2026-05-01T12:00:00.000Z',
                '2026-05-01T12:00:00.000Z',
                NULL
              ),
              (
                'thread-chat-existing',
                'project-chat',
                'Chat existing worktree',
                'gpt-5-codex',
                ${existingLegacyThreadPath},
                '2026-05-01T12:00:00.000Z',
                '2026-05-01T12:00:00.000Z',
                NULL
              ),
              (
                'thread-user-home',
                'project-user-home',
                'User home thread',
                'gpt-5-codex',
                NULL,
                '2026-05-01T12:00:00.000Z',
                '2026-05-01T12:00:00.000Z',
                NULL
              )
          `;

          yield* sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            )
            VALUES
              (
                'event-project-chat',
                'project',
                'project-chat',
                1,
                'project.created',
                '2026-05-01T12:00:00.000Z',
                NULL,
                NULL,
                NULL,
                'client',
                json_object('projectId', 'project-chat', 'title', 'Home', 'workspaceRoot', ${legacyCodexChatWorkspaceRoot}),
                '{}'
              ),
              (
                'event-project-user-home',
                'project',
                'project-user-home',
                1,
                'project.created',
                '2026-05-01T12:00:00.000Z',
                NULL,
                NULL,
                NULL,
                'client',
                json_object('projectId', 'project-user-home', 'title', 'Home', 'workspaceRoot', ${userHomeRoot}),
                '{}'
              ),
              (
                'event-thread-chat',
                'thread',
                'thread-chat-missing',
                1,
                'thread.created',
                '2026-05-01T12:00:00.000Z',
                NULL,
                NULL,
                NULL,
                'client',
                json_object('threadId', 'thread-chat-missing', 'projectId', 'project-chat', 'worktreePath', NULL),
                '{}'
              ),
              (
                'event-thread-user-home',
                'thread',
                'thread-user-home',
                1,
                'thread.created',
                '2026-05-01T12:00:00.000Z',
                NULL,
                NULL,
                NULL,
                'client',
                json_object('threadId', 'thread-user-home', 'projectId', 'project-user-home', 'worktreePath', NULL),
                '{}'
              )
          `;

          yield* makeCanonicalChatsProjectMigration({
            chatWorkspaceRoot,
            legacyChatWorkspaceRoot,
            legacyCodexChatWorkspaceRoot,
            legacyT3ChatWorkspaceRoot,
            makeDirectory: (directoryPath) => {
              createdDirectories.push(directoryPath);
            },
          });

          const projects = yield* sql<{
            readonly projectId: string;
            readonly title: string;
            readonly workspaceRoot: string;
          }>`
            SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
            FROM projection_projects
            ORDER BY project_id ASC
          `;

          expect(projects).toEqual([
            { projectId: "project-chat", title: "chats", workspaceRoot: chatWorkspaceRoot },
            { projectId: "project-user-home", title: "Home", workspaceRoot: userHomeRoot },
          ]);

          const threads = yield* sql<{
            readonly threadId: string;
            readonly worktreePath: string | null;
          }>`
            SELECT thread_id AS "threadId", worktree_path AS "worktreePath"
            FROM projection_threads
            ORDER BY thread_id ASC
          `;

          expect(threads).toEqual([
            {
              threadId: "thread-chat-existing",
              worktreePath: existingLegacyThreadPath,
            },
            {
              threadId: "thread-chat-missing",
              worktreePath: missingChatThreadPath,
            },
            { threadId: "thread-user-home", worktreePath: null },
          ]);

          const eventPayloads = yield* sql<{
            readonly eventId: string;
            readonly title: string | null;
            readonly workspaceRoot: string | null;
            readonly worktreePath: string | null;
          }>`
            SELECT
              event_id AS "eventId",
              json_extract(payload_json, '$.title') AS "title",
              json_extract(payload_json, '$.workspaceRoot') AS "workspaceRoot",
              json_extract(payload_json, '$.worktreePath') AS "worktreePath"
            FROM orchestration_events
            ORDER BY event_id ASC
          `;

          expect(eventPayloads).toEqual([
            {
              eventId: "event-project-chat",
              title: "chats",
              workspaceRoot: chatWorkspaceRoot,
              worktreePath: null,
            },
            {
              eventId: "event-project-user-home",
              title: "Home",
              workspaceRoot: userHomeRoot,
              worktreePath: null,
            },
            {
              eventId: "event-thread-chat",
              title: null,
              workspaceRoot: null,
              worktreePath: missingChatThreadPath,
            },
            {
              eventId: "event-thread-user-home",
              title: null,
              workspaceRoot: null,
              worktreePath: null,
            },
          ]);

          expect(createdDirectories).toEqual([
            chatWorkspaceRoot,
            existingLegacyThreadPath,
            missingChatThreadPath,
          ]);
        }),
      );
    });
  });
});
