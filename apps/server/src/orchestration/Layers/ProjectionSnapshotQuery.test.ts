import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  TaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTaskId = (value: string): TaskId => TaskId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_turns`;

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
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          'gpt-5-codex',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          is_pinned,
          archived_at,
          handoff_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          'gpt-5-codex',
          'full-access',
          'default',
          NULL,
          NULL,
          0,
          NULL,
          '{"sourceThreadId":"thread-source","sourceProvider":"claudeAgent","importedAt":"2026-02-24T00:00:01.500Z","bootstrapStatus":"completed"}',
          'turn-1',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          interaction_mode,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'message-1',
          'plan',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModel: "gpt-5-codex",
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          origin: "user",
          taskId: null,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          title: "Thread 1",
          model: "gpt-5-codex",
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          isPinned: false,
          pinnedAt: null,
          archivedAt: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            interactionMode: "plan",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          handoff: {
            sourceThreadId: ThreadId.makeUnsafe("thread-source"),
            sourceProvider: "claudeAgent",
            importedAt: "2026-02-24T00:00:01.500Z",
            bootstrapStatus: "completed",
          },
        },
      ]);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          is_pinned,
          archived_at,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-2',
          'project-1',
          'Thread 2',
          'gpt-5-codex',
          'full-access',
          'default',
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          '2026-02-24T00:01:02.000Z',
          '2026-02-24T00:01:03.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-2',
          'thread-2',
          NULL,
          'assistant',
          'heavy inactive thread message',
          0,
          '2026-02-24T00:01:04.000Z',
          '2026-02-24T00:01:05.000Z'
        )
      `;

      const focusedSnapshot = yield* snapshotQuery.getSnapshot({
        mode: "focused",
        threadId: ThreadId.makeUnsafe("thread-1"),
      });
      const focusedThread1 = focusedSnapshot.threads.find((thread) => thread.id === "thread-1");
      const focusedThread2 = focusedSnapshot.threads.find((thread) => thread.id === "thread-2");
      assert.equal(focusedThread1?.messages.length, 1);
      assert.equal(focusedThread2?.messages.length, 0);

      const multiFocusedSnapshot = yield* snapshotQuery.getSnapshot({
        mode: "focused",
        threadId: ThreadId.makeUnsafe("thread-1"),
        threadIds: [ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")],
      });
      const multiFocusedThread1 = multiFocusedSnapshot.threads.find(
        (thread) => thread.id === "thread-1",
      );
      const multiFocusedThread2 = multiFocusedSnapshot.threads.find(
        (thread) => thread.id === "thread-2",
      );
      assert.equal(multiFocusedThread1?.messages.length, 1);
      assert.equal(multiFocusedThread2?.messages.length, 1);

      const bootstrapSnapshot = yield* snapshotQuery.getSnapshot({ mode: "bootstrap" });
      assert.equal(
        bootstrapSnapshot.threads.find((thread) => thread.id === "thread-1")?.messages.length,
        0,
      );
      assert.equal(
        bootstrapSnapshot.threads.find((thread) => thread.id === "thread-2")?.messages.length,
        0,
      );
    }),
  );

  it.effect("does not keep task runtime awaiting input after user input is resolved", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_tasks`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_sessions`;

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
        VALUES (
          'project-status',
          'Project Status',
          '/tmp/project-status',
          'gpt-5-codex',
          '[]',
          '2026-02-28T00:00:00.000Z',
          '2026-02-28T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          is_pinned,
          archived_at,
          handoff_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-status',
          'project-status',
          'Thread Status',
          'gpt-5-codex',
          'approval-required',
          'default',
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          '2026-02-28T00:00:01.000Z',
          '2026-02-28T00:00:05.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_tasks (
          task_id,
          project_id,
          title,
          brief,
          acceptance_criteria,
          attachments,
          state,
          priority,
          thread_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'task-status',
          'project-status',
          'Task Status',
          'Run a task',
          '',
          '[]',
          'running',
          NULL,
          'thread-status',
          '2026-02-28T00:00:01.000Z',
          '2026-02-28T00:00:05.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-status',
          'running',
          'opencode',
          'provider-session-status',
          'provider-thread-status',
          'approval-required',
          NULL,
          NULL,
          '2026-02-28T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-user-input-requested-status',
            'thread-status',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"req-status","questions":[]}',
            '2026-02-28T00:00:02.000Z'
          ),
          (
            'activity-user-input-resolved-status',
            'thread-status',
            NULL,
            'info',
            'user-input.resolved',
            'User input submitted',
            '{"requestId":"req-status","answers":{"sandbox_mode":"workspace-write"}}',
            '2026-02-28T00:00:03.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const runtime = snapshot.taskRuntimes.find(
        (entry) => entry.taskId === asTaskId("task-status"),
      );

      assert.equal(runtime?.status, "running");
    }),
  );

  it.effect("loads only the latest turn for each thread in bootstrap snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

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
        VALUES (
          'project-latest-turn',
          'Latest Turn',
          '/tmp/latest-turn',
          'gpt-5-codex',
          '[]',
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          is_pinned,
          archived_at,
          handoff_json,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-latest-pointer',
            'project-latest-turn',
            'Pointer Thread',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            0,
            NULL,
            NULL,
            'turn-pointer-new',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:03.000Z',
            NULL
          ),
          (
            'thread-latest-scan',
            'project-latest-turn',
            'Scan Thread',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            0,
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:03.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          interaction_mode,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-latest-pointer',
            'turn-pointer-old',
            NULL,
            NULL,
            'default',
            'completed',
            '2026-03-01T00:00:01.000Z',
            '2026-03-01T00:00:01.000Z',
            '2026-03-01T00:00:01.000Z',
            '[]'
          ),
          (
            'thread-latest-pointer',
            'turn-pointer-new',
            NULL,
            NULL,
            'plan',
            'completed',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:02.000Z',
            '[]'
          ),
          (
            'thread-latest-scan',
            'turn-scan-old',
            NULL,
            NULL,
            'default',
            'completed',
            '2026-03-01T00:00:01.000Z',
            '2026-03-01T00:00:01.000Z',
            '2026-03-01T00:00:01.000Z',
            '[]'
          ),
          (
            'thread-latest-scan',
            'turn-scan-new',
            NULL,
            NULL,
            'plan',
            'running',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:02.000Z',
            NULL,
            '[]'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot({ mode: "bootstrap" });
      const pointerThread = snapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-latest-pointer"),
      );
      const scanThread = snapshot.threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-latest-scan"),
      );

      assert.equal(pointerThread?.latestTurn?.turnId, asTurnId("turn-pointer-new"));
      assert.equal(pointerThread?.latestTurn?.interactionMode, "plan");
      assert.equal(scanThread?.latestTurn?.turnId, asTurnId("turn-scan-new"));
      assert.equal(scanThread?.latestTurn?.state, "running");
    }),
  );
});
