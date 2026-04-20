import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProjectRules,
  OrchestrationSession,
  OrchestrationTask,
  OrchestrationTaskRuntime,
  OrchestrationThread,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ProjectOrchestrationRulesUpdatedPayload,
  TaskCreatedPayload,
  TaskDeletedPayload,
  TaskMetaUpdatedPayload,
  TaskStateSetPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadUnarchivedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
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
  if (thread.session?.status === "error") {
    return "error";
  }
  if (task.state === "blocked") {
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

function deriveTaskRuntimes(model: OrchestrationReadModel): Array<OrchestrationTaskRuntime> {
  return model.tasks.map((task) => {
    const thread = task.threadId ? model.threads.find((entry) => entry.id === task.threadId) ?? null : null;
    const lastActivityAt = [
      task.updatedAt,
      thread?.updatedAt ?? null,
      thread?.session?.updatedAt ?? null,
      thread?.latestTurn?.completedAt ?? null,
      thread?.latestTurn?.startedAt ?? null,
    ]
      .filter((value): value is string => value !== null)
      .reduce<string | null>((latest, value) => (latest === null || value > latest ? value : latest), null);
    return {
      taskId: task.id,
      status: deriveTaskRuntimeStatus({ task, thread }),
      activeTurnId: thread?.session?.activeTurnId ?? null,
      lastError: thread?.session?.lastError ?? null,
      lastActivityAt,
      updatedAt: lastActivityAt ?? task.updatedAt,
    };
  });
}

function withDerivedTaskRuntimes(model: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...model,
    taskRuntimes: deriveTaskRuntimes(model),
  };
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModel: payload.defaultModel,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModel !== undefined
                    ? { defaultModel: payload.defaultModel }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "project.orchestration-rules-updated":
      return decodeForEvent(
        ProjectOrchestrationRulesUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const nextRules: OrchestrationProjectRules = {
            projectId: payload.projectId,
            promptTemplate: payload.promptTemplate,
            defaultModel: payload.defaultModel,
            defaultRuntimeMode: payload.defaultRuntimeMode,
            onSuccessMoveTo: payload.onSuccessMoveTo,
            onFailureMoveTo: payload.onFailureMoveTo,
            updatedAt: payload.updatedAt,
          };
          const existing = nextBase.projectRules.find((entry) => entry.projectId === payload.projectId);
          return withDerivedTaskRuntimes({
            ...nextBase,
            projectRules: existing
              ? nextBase.projectRules.map((entry) =>
                  entry.projectId === payload.projectId ? nextRules : entry,
                )
              : [...nextBase.projectRules, nextRules],
          });
        }),
      );

    case "task.created":
      return decodeForEvent(TaskCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const nextTask: OrchestrationTask = {
            id: payload.taskId,
            projectId: payload.projectId,
            title: payload.title,
            brief: payload.brief,
            acceptanceCriteria: payload.acceptanceCriteria,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            state: payload.state,
            priority: payload.priority,
            threadId: payload.threadId,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };
          const existing = nextBase.tasks.find((entry) => entry.id === payload.taskId);
          return withDerivedTaskRuntimes({
            ...nextBase,
            tasks: existing
              ? nextBase.tasks.map((entry) => (entry.id === payload.taskId ? nextTask : entry))
              : [...nextBase.tasks, nextTask],
          });
        }),
      );

    case "task.meta-updated":
      return decodeForEvent(TaskMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) =>
          withDerivedTaskRuntimes({
            ...nextBase,
            tasks: nextBase.tasks.map((task) =>
              task.id === payload.taskId
                ? {
                    ...task,
                    ...(payload.title !== undefined ? { title: payload.title } : {}),
                    ...(payload.brief !== undefined ? { brief: payload.brief } : {}),
                    ...(payload.acceptanceCriteria !== undefined
                      ? { acceptanceCriteria: payload.acceptanceCriteria }
                      : {}),
                    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                    ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
                    ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}),
                    updatedAt: payload.updatedAt,
                  }
                : task,
            ),
          }),
        ),
      );

    case "task.state-set":
      return decodeForEvent(TaskStateSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) =>
          withDerivedTaskRuntimes({
            ...nextBase,
            tasks: nextBase.tasks.map((task) =>
              task.id === payload.taskId
                ? {
                    ...task,
                    state: payload.state,
                    updatedAt: payload.updatedAt,
                  }
                : task,
            ),
          }),
        ),
      );

    case "task.deleted":
      return decodeForEvent(TaskDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) =>
          withDerivedTaskRuntimes({
            ...nextBase,
            tasks: nextBase.tasks.map((task) =>
              task.id === payload.taskId
                ? {
                    ...task,
                    deletedAt: payload.deletedAt,
                    updatedAt: payload.deletedAt,
                  }
                : task,
            ),
          }),
        ),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            origin: payload.origin,
            taskId: payload.taskId,
            parentThreadId: payload.parentThreadId,
            subagentAgentId: payload.subagentAgentId,
            subagentNickname: payload.subagentNickname,
            subagentRole: payload.subagentRole,
            title: payload.title,
            model: payload.model,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            isPinned: payload.isPinned,
            pinnedAt: payload.pinnedAt,
            archivedAt: payload.archivedAt,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
            ...(payload.handoff !== undefined ? { handoff: payload.handoff } : {}),
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return withDerivedTaskRuntimes({
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        });
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
            ...(payload.pinnedAt !== undefined ? { pinnedAt: payload.pinnedAt } : {}),
            ...(payload.parentThreadId !== undefined ? { parentThreadId: payload.parentThreadId } : {}),
            ...(payload.subagentAgentId !== undefined
              ? { subagentAgentId: payload.subagentAgentId }
              : {}),
            ...(payload.subagentNickname !== undefined
              ? { subagentNickname: payload.subagentNickname }
              : {}),
            ...(payload.subagentRole !== undefined ? { subagentRole: payload.subagentRole } : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(
        ThreadRuntimeModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return withDerivedTaskRuntimes({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    interactionMode:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.interactionMode
                        : thread.interactionMode,
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        });
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        return withDerivedTaskRuntimes({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              interactionMode:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.interactionMode
                  : thread.interactionMode,
              requestedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? thread.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                thread.latestTurn?.turnId === payload.turnId
                  ? (thread.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          }),
        });
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  interactionMode:
                    thread.latestTurn?.turnId === latestCheckpoint.turnId
                      ? thread.latestTurn.interactionMode
                      : thread.interactionMode,
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return withDerivedTaskRuntimes({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          });
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return withDerivedTaskRuntimes({
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          });
        }),
      );

    default:
      return Effect.succeed(withDerivedTaskRuntimes(nextBase));
  }
}
