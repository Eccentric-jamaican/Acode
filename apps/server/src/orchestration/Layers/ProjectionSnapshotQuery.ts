import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  type OrchestrationGetSnapshotInput,
  OrchestrationReadModel,
  ProjectId,
  ProjectScript,
  RuntimeMode,
  TaskId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationProjectRules,
  type OrchestrationSession,
  type OrchestrationTask,
  type OrchestrationTaskRuntime,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  ProjectionThread,
  ProjectionThreadDbRow,
  normalizeProjectionThreadDbRow,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThreadDbRow;
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  interactionMode: ProjectionThread.fields.interactionMode,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionTaskDbRowSchema = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  title: Schema.String,
  brief: Schema.String,
  acceptanceCriteria: Schema.String,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
  state: Schema.Literals(["backlog", "ready", "running", "review", "blocked", "done"]),
  priority: Schema.NullOr(NonNegativeInt),
  threadId: Schema.NullOr(ProjectionThread.fields.threadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionProjectRulesDbRowSchema = Schema.Struct({
  projectId: ProjectId,
  promptTemplate: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  defaultRuntimeMode: RuntimeMode,
  onSuccessMoveTo: Schema.Literals(["backlog", "ready", "running", "review", "blocked", "done"]),
  onFailureMoveTo: Schema.Literals(["backlog", "ready", "running", "review", "blocked", "done"]),
  updatedAt: IsoDateTime,
});

const ThreadScopedSnapshotRowsInput = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.projectRules,
  ORCHESTRATION_PROJECTOR_NAMES.tasks,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;
const SNAPSHOT_INFO_LOG_THRESHOLD_MS = 1_000;
const SNAPSHOT_WARN_LOG_THRESHOLD_MS = 5_000;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function deriveTaskRuntimeStatus(input: {
  readonly task: OrchestrationTask;
  readonly thread: OrchestrationThread | null;
}): OrchestrationTaskRuntime["status"] {
  const { task, thread } = input;
  if (!thread) {
    return task.state === "running" ? "queued" : "idle";
  }
  const latestApprovalActivity = [...thread.activities]
    .reverse()
    .find((activity) => activity.kind.includes("approval") || activity.kind.includes("user-input"));
  if (latestApprovalActivity?.kind.includes("user-input")) {
    return "awaiting_input";
  }
  if (latestApprovalActivity?.kind.includes("approval")) {
    return "awaiting_approval";
  }
  if (thread.session?.status === "starting") {
    return "starting";
  }
  if (thread.session?.status === "running") {
    return "running";
  }
  if (thread.session?.status === "error" || task.state === "blocked") {
    return "error";
  }
  if (task.state === "running") {
    return "queued";
  }
  if (thread.session?.status === "stopped") {
    return "stopped";
  }
  return "idle";
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model AS "defaultModel",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          origin,
          task_id AS "taskId",
          parent_thread_id AS "parentThreadId",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          is_pinned AS "isPinned",
          pinned_at AS "pinnedAt",
          archived_at AS "archivedAt",
          handoff_json AS "handoff",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTaskDbRowSchema,
    execute: () =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          brief,
          acceptance_criteria AS "acceptanceCriteria",
          attachments AS "attachments",
          state,
          priority,
          thread_id AS "threadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_tasks
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const listProjectRulesRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectRulesDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          prompt_template AS "promptTemplate",
          default_model AS "defaultModel",
          default_runtime_mode AS "defaultRuntimeMode",
          on_success_move_to AS "onSuccessMoveTo",
          on_failure_move_to AS "onFailureMoveTo",
          updated_at AS "updatedAt"
        FROM projection_project_rules
        ORDER BY project_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadMessageRowsForThread = SqlSchema.findAll({
    Request: ThreadScopedSnapshotRowsInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${input.threadId}
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadProposedPlanRowsForThread = SqlSchema.findAll({
    Request: ThreadScopedSnapshotRowsInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${input.threadId}
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadActivityRowsForThread = SqlSchema.findAll({
    Request: ThreadScopedSnapshotRowsInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${input.threadId}
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listCheckpointRowsForThread = SqlSchema.findAll({
    Request: ThreadScopedSnapshotRowsInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: (input) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL AND thread_id = ${input.threadId}
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          interaction_mode AS "interactionMode",
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = (input) => {
    const snapshotMode: OrchestrationGetSnapshotInput["mode"] = input?.mode ?? "full";
    const heavyRowsThreadId = snapshotMode === "full" ? null : (input?.threadId ?? null);
    const threadScopedInput =
      heavyRowsThreadId !== null ? { threadId: heavyRowsThreadId } : null;
    const requestStartedAt = Date.now();

    return sql
      .withTransaction(
        Effect.gen(function* () {
          const queryTimings: Array<{
            phase: string;
            rows: number;
            durationMs: number;
          }> = [];
          const measureRows = <A extends ReadonlyArray<unknown>>(
            phase: string,
            effect: Effect.Effect<A, ProjectionRepositoryError>,
          ): Effect.Effect<A, ProjectionRepositoryError> =>
            Effect.gen(function* () {
              const startedAt = Date.now();
              const rows = yield* effect;
              queryTimings.push({
                phase,
                rows: rows.length,
                durationMs: Date.now() - startedAt,
              });
              return rows;
            });

          const projectRows = yield* measureRows(
            "projects",
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
            ),
          );
          const projectRulesRows = yield* measureRows(
            "projectRules",
            listProjectRulesRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectRules:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectRules:decodeRows",
                ),
              ),
            ),
          );
          const taskRows = yield* measureRows(
            "tasks",
            listTaskRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listTasks:query",
                  "ProjectionSnapshotQuery.getSnapshot:listTasks:decodeRows",
                ),
              ),
            ),
          );
          const threadRows = yield* measureRows(
            "threads",
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
            ),
          );
          const messageRows = yield* measureRows(
            "threadMessages",
            (snapshotMode === "full"
              ? listThreadMessageRows(undefined)
              : threadScopedInput
                ? listThreadMessageRowsForThread(threadScopedInput)
                : Effect.succeed([])).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
          );
          const proposedPlanRows = yield* measureRows(
            "threadProposedPlans",
            (snapshotMode === "full"
              ? listThreadProposedPlanRows(undefined)
              : threadScopedInput
                ? listThreadProposedPlanRowsForThread(threadScopedInput)
                : Effect.succeed([])).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
          );
          const activityRows = yield* measureRows(
            "threadActivities",
            (snapshotMode === "full"
              ? listThreadActivityRows(undefined)
              : threadScopedInput
                ? listThreadActivityRowsForThread(threadScopedInput)
                : Effect.succeed([])).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
          );
          const sessionRows = yield* measureRows(
            "threadSessions",
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
          );
          const checkpointRows = yield* measureRows(
            "checkpoints",
            (snapshotMode === "full"
              ? listCheckpointRows(undefined)
              : threadScopedInput
                ? listCheckpointRowsForThread(threadScopedInput)
                : Effect.succeed([])).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
          );
          const latestTurnRows = yield* measureRows(
            "latestTurns",
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
          );
          const stateRows = yield* measureRows(
            "projectionState",
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          );

          const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
          const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of projectRulesRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of taskRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          for (const row of messageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = messagesByThread.get(row.threadId) ?? [];
            threadMessages.push({
              id: row.messageId,
              role: row.role,
              text: row.text,
              ...(row.attachments !== null ? { attachments: row.attachments } : {}),
              turnId: row.turnId,
              streaming: row.isStreaming === 1,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
            messagesByThread.set(row.threadId, threadMessages);
          }

          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push({
              id: row.planId,
              turnId: row.turnId,
              planMarkdown: row.planMarkdown,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }

          for (const row of activityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const threadActivities = activitiesByThread.get(row.threadId) ?? [];
            threadActivities.push({
              id: row.activityId,
              tone: row.tone,
              kind: row.kind,
              summary: row.summary,
              payload: row.payload,
              turnId: row.turnId,
              ...(row.sequence !== null ? { sequence: row.sequence } : {}),
              createdAt: row.createdAt,
            });
            activitiesByThread.set(row.threadId, threadActivities);
          }

          for (const row of checkpointRows) {
            updatedAt = maxIso(updatedAt, row.completedAt);
            const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
            threadCheckpoints.push({
              turnId: row.turnId,
              checkpointTurnCount: row.checkpointTurnCount,
              checkpointRef: row.checkpointRef,
              status: row.status,
              files: row.files,
              assistantMessageId: row.assistantMessageId,
              completedAt: row.completedAt,
            });
            checkpointsByThread.set(row.threadId, threadCheckpoints);
          }

          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, {
              turnId: row.turnId,
              state:
                row.state === "error"
                  ? "error"
                  : row.state === "interrupted"
                    ? "interrupted"
                    : row.state === "completed"
                      ? "completed"
                      : "running",
              interactionMode: row.interactionMode,
              requestedAt: row.requestedAt,
              startedAt: row.startedAt,
              completedAt: row.completedAt,
              assistantMessageId: row.assistantMessageId,
            });
          }

          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, {
              threadId: row.threadId,
              status: row.status,
              providerName: row.providerName,
              runtimeMode: row.runtimeMode,
              activeTurnId: row.activeTurnId,
              lastError: row.lastError,
              updatedAt: row.updatedAt,
            });
          }

          const projects: Array<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModel: row.defaultModel,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const projectRules: Array<OrchestrationProjectRules> = projectRulesRows.map((row) => ({
            projectId: row.projectId,
            promptTemplate: row.promptTemplate,
            defaultModel: row.defaultModel,
            defaultRuntimeMode: row.defaultRuntimeMode,
            onSuccessMoveTo: row.onSuccessMoveTo,
            onFailureMoveTo: row.onFailureMoveTo,
            updatedAt: row.updatedAt,
          }));

          const tasks: Array<OrchestrationTask> = taskRows.map((row) => ({
            id: row.taskId,
            projectId: row.projectId,
            title: row.title,
            brief: row.brief,
            acceptanceCriteria: row.acceptanceCriteria,
            attachments: row.attachments,
            state: row.state,
            priority: row.priority,
            threadId: row.threadId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: Array<OrchestrationThread> = threadRows.map((row) => {
            const normalizedRow = normalizeProjectionThreadDbRow(row);
            const threadBase = {
              id: normalizedRow.threadId,
              projectId: normalizedRow.projectId,
              origin: normalizedRow.origin,
              taskId: normalizedRow.taskId,
              parentThreadId: normalizedRow.parentThreadId,
              subagentAgentId: normalizedRow.subagentAgentId,
              subagentNickname: normalizedRow.subagentNickname,
              subagentRole: normalizedRow.subagentRole,
              title: normalizedRow.title,
              model: normalizedRow.model,
              runtimeMode: normalizedRow.runtimeMode,
              interactionMode: normalizedRow.interactionMode,
              branch: normalizedRow.branch,
              worktreePath: normalizedRow.worktreePath,
              isPinned: normalizedRow.isPinned,
              pinnedAt: normalizedRow.pinnedAt,
              archivedAt: normalizedRow.archivedAt,
              latestTurn: latestTurnByThread.get(normalizedRow.threadId) ?? null,
              createdAt: normalizedRow.createdAt,
              updatedAt: normalizedRow.updatedAt,
              deletedAt: normalizedRow.deletedAt,
              messages: messagesByThread.get(normalizedRow.threadId) ?? [],
              proposedPlans: proposedPlansByThread.get(normalizedRow.threadId) ?? [],
              activities: activitiesByThread.get(normalizedRow.threadId) ?? [],
              checkpoints: checkpointsByThread.get(normalizedRow.threadId) ?? [],
              session: sessionsByThread.get(normalizedRow.threadId) ?? null,
            } satisfies Omit<OrchestrationThread, "handoff">;
            if (normalizedRow.handoff === null) {
              return threadBase;
            }
            return Object.assign({ handoff: normalizedRow.handoff }, threadBase);
          });

          const taskRuntimes: Array<OrchestrationTaskRuntime> = tasks.map((task) => {
            const thread = task.threadId ? threads.find((entry) => entry.id === task.threadId) ?? null : null;
            const lastActivityAt = [
              task.updatedAt,
              thread?.updatedAt ?? null,
              thread?.session?.updatedAt ?? null,
              thread?.latestTurn?.completedAt ?? null,
              thread?.latestTurn?.startedAt ?? null,
            ]
              .filter((value): value is string => value !== null)
              .reduce<string | null>(
                (latest, value) => (latest === null || value > latest ? value : latest),
                null,
              );
            return {
              taskId: task.id,
              status: deriveTaskRuntimeStatus({ task, thread }),
              activeTurnId: thread?.session?.activeTurnId ?? null,
              lastError: thread?.session?.lastError ?? null,
              lastActivityAt,
              updatedAt: lastActivityAt ?? task.updatedAt,
            };
          });

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            tasks,
            taskRuntimes,
            projectRules,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          const readModel = yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );

          const totalDurationMs = Date.now() - requestStartedAt;
          if (totalDurationMs >= SNAPSHOT_INFO_LOG_THRESHOLD_MS) {
            const logEffect =
              totalDurationMs >= SNAPSHOT_WARN_LOG_THRESHOLD_MS ? Effect.logWarning : Effect.logInfo;
            yield* logEffect("projection snapshot query completed", {
              mode: snapshotMode,
              threadId: heavyRowsThreadId,
              totalDurationMs,
              snapshotSequence: readModel.snapshotSequence,
              projectCount: readModel.projects.length,
              taskCount: readModel.tasks.length,
              threadCount: readModel.threads.length,
              queryTimings: queryTimings.map((timing) => ({
                phase: timing.phase,
                rows: timing.rows,
                durationMs: timing.durationMs,
              })),
            });
          }

          return readModel;
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );
  };

  return {
    getSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
