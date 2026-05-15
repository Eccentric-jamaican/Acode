import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const CHATS_PROJECT_TITLE = "chats";
const LEGACY_HOME_PROJECT_TITLE = "Home";
const CHAT_THREAD_SLUG_MAX_LENGTH = 64;

type CanonicalProjectRow = {
  readonly projectId: string;
};

type ChatThreadRow = {
  readonly threadId: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly createdAt: string;
};

export type CanonicalChatsProjectMigrationInput = {
  readonly chatWorkspaceRoot?: string;
  readonly legacyChatWorkspaceRoot?: string;
  readonly legacyCodexChatWorkspaceRoot?: string;
  readonly legacyT3ChatWorkspaceRoot?: string;
  readonly makeDirectory?: (directoryPath: string) => void;
};

function defaultChatWorkspaceRoot(): string {
  return path.join(os.homedir(), "Documents", "A Code", "Chats");
}

function defaultLegacyChatWorkspaceRoot(): string {
  return path.join(os.homedir(), ".codex", "chats");
}

function defaultLegacyCodexChatWorkspaceRoot(): string {
  return path.join(os.homedir(), "Documents", "Codex");
}

function defaultLegacyT3ChatWorkspaceRoot(): string {
  return path.join(os.homedir(), "Documents", "T3 Code", "Chats");
}

function isInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function formatChatThreadDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugifyChatThreadTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHAT_THREAD_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  return slug || "chat";
}

function chatThreadRelativePath(input: {
  readonly createdAt: string;
  readonly title: string;
  readonly suffix?: number;
}): string {
  const timestamp = new Date(input.createdAt);
  const date = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const baseSlug = slugifyChatThreadTitle(input.title);
  const slug = input.suffix && input.suffix > 1 ? `${baseSlug}-${input.suffix}` : baseSlug;
  return path.join(formatChatThreadDate(date), slug);
}

export function makeCanonicalChatsProjectMigration(
  input: CanonicalChatsProjectMigrationInput = {},
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chatWorkspaceRoot = input.chatWorkspaceRoot ?? defaultChatWorkspaceRoot();
    const legacyChatWorkspaceRoot =
      input.legacyChatWorkspaceRoot ?? defaultLegacyChatWorkspaceRoot();
    const legacyCodexChatWorkspaceRoot =
      input.legacyCodexChatWorkspaceRoot ?? defaultLegacyCodexChatWorkspaceRoot();
    const legacyT3ChatWorkspaceRoot =
      input.legacyT3ChatWorkspaceRoot ?? defaultLegacyT3ChatWorkspaceRoot();
    const makeDirectory =
      input.makeDirectory ??
      ((directoryPath: string) => fs.mkdirSync(directoryPath, { recursive: true }));

    const canonicalProjects = yield* sql<CanonicalProjectRow>`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE deleted_at IS NULL
        AND workspace_root IN (
          ${chatWorkspaceRoot},
          ${legacyChatWorkspaceRoot},
          ${legacyCodexChatWorkspaceRoot},
          ${legacyT3ChatWorkspaceRoot}
        )
    `;

    if (canonicalProjects.length === 0) {
      return;
    }

    yield* Effect.sync(() => makeDirectory(chatWorkspaceRoot));

    for (const project of canonicalProjects) {
      yield* sql`
        UPDATE projection_projects
        SET
          title = CASE
            WHEN title = ${LEGACY_HOME_PROJECT_TITLE} THEN ${CHATS_PROJECT_TITLE}
            ELSE title
          END,
          workspace_root = ${chatWorkspaceRoot}
        WHERE project_id = ${project.projectId}
          AND deleted_at IS NULL
      `;

      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.title', ${CHATS_PROJECT_TITLE})
        WHERE aggregate_kind = 'project'
          AND stream_id = ${project.projectId}
          AND event_type IN ('project.created', 'project.meta-updated')
          AND json_extract(payload_json, '$.title') = ${LEGACY_HOME_PROJECT_TITLE}
      `;

      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.workspaceRoot', ${chatWorkspaceRoot})
        WHERE aggregate_kind = 'project'
          AND stream_id = ${project.projectId}
          AND event_type IN ('project.created', 'project.meta-updated')
          AND json_extract(payload_json, '$.workspaceRoot') IN (
            ${chatWorkspaceRoot},
            ${legacyChatWorkspaceRoot},
            ${legacyCodexChatWorkspaceRoot},
            ${legacyT3ChatWorkspaceRoot}
          )
      `;

      const chatThreads = yield* sql<ChatThreadRow>`
        SELECT
          thread_id AS "threadId",
          title,
          worktree_path AS "worktreePath",
          created_at AS "createdAt"
        FROM projection_threads
        WHERE project_id = ${project.projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `;

      const usedRelativePaths = new Set<string>();
      for (const thread of chatThreads) {
        const existingWorktreePath = thread.worktreePath?.trim() || null;
        let worktreePath = existingWorktreePath;
        if (worktreePath === null) {
          let suffix = 1;
          let relativePath = chatThreadRelativePath({
            createdAt: thread.createdAt,
            title: thread.title,
          });
          while (usedRelativePaths.has(relativePath.toLowerCase())) {
            suffix += 1;
            relativePath = chatThreadRelativePath({
              createdAt: thread.createdAt,
              title: thread.title,
              suffix,
            });
          }
          usedRelativePaths.add(relativePath.toLowerCase());
          worktreePath = path.join(chatWorkspaceRoot, relativePath);
        } else if (isInsideOrEqual(chatWorkspaceRoot, worktreePath)) {
          usedRelativePaths.add(path.relative(chatWorkspaceRoot, worktreePath).toLowerCase());
        }

        if (
          isInsideOrEqual(chatWorkspaceRoot, worktreePath) ||
          isInsideOrEqual(legacyChatWorkspaceRoot, worktreePath) ||
          isInsideOrEqual(legacyCodexChatWorkspaceRoot, worktreePath) ||
          isInsideOrEqual(legacyT3ChatWorkspaceRoot, worktreePath)
        ) {
          yield* Effect.sync(() => makeDirectory(worktreePath));
        }

        if (existingWorktreePath !== null) {
          continue;
        }

        yield* sql`
          UPDATE projection_threads
          SET worktree_path = ${worktreePath}
          WHERE thread_id = ${thread.threadId}
            AND project_id = ${project.projectId}
            AND deleted_at IS NULL
            AND (worktree_path IS NULL OR trim(worktree_path) = '')
        `;

        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_set(payload_json, '$.worktreePath', ${worktreePath})
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${thread.threadId}
            AND event_type = 'thread.created'
            AND json_extract(payload_json, '$.projectId') = ${project.projectId}
            AND (
              json_type(payload_json, '$.worktreePath') IS NULL
              OR json_extract(payload_json, '$.worktreePath') IS NULL
              OR trim(json_extract(payload_json, '$.worktreePath')) = ''
            )
        `;
      }
    }
  });
}

export default makeCanonicalChatsProjectMigration();
