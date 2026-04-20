import type {
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  ProviderKind,
  OrchestrationReadModel,
  ThreadHandoffImportedMessage,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireProject,
  requireProjectAbsent,
  requireTask,
  requireTaskAbsent,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function taskOwnedThreadId(taskId: string): string {
  return `orchestrate:task:${taskId}`;
}

function newThreadIdFromTask(taskId: string): ThreadId {
  return taskOwnedThreadId(taskId) as ThreadId;
}

function newMessageId(): MessageId {
  return crypto.randomUUID() as MessageId;
}

function inferProviderFromModel(model: string): ProviderKind {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("claude")) {
    return "claudeAgent";
  }
  if (normalized === "opencode/default" || /^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return "opencode";
  }
  return "codex";
}

function hasNativeHandoffMessages(
  thread: Pick<OrchestrationReadModel["threads"][number], "messages">,
): boolean {
  return thread.messages.some((message) => message.role === "assistant" && message.turnId !== null);
}

function buildImportedHandoffMessagesFromSourceThread(
  thread: Pick<OrchestrationReadModel["threads"][number], "messages">,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return thread.messages
    .filter(
      (
        message,
      ): message is (typeof thread.messages)[number] & {
        readonly role: "user" | "assistant";
      } =>
        (message.role === "user" || message.role === "assistant") &&
        message.streaming === false,
    )
    .map((message) => ({
      messageId: newMessageId(),
      role: message.role,
      text: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    }));
}

function taskRunPrompt(input: {
  readonly task: OrchestrationReadModel["tasks"][number];
  readonly project: OrchestrationReadModel["projects"][number];
  readonly projectRules: OrchestrationReadModel["projectRules"][number] | undefined;
  readonly mode: "start" | "retry";
}): string {
  const sections = [
    input.projectRules?.promptTemplate?.trim() ?? "",
    `Task: ${input.task.title}`,
    input.task.brief.trim().length > 0 ? input.task.brief.trim() : "",
    input.task.acceptanceCriteria.trim().length > 0
      ? `Acceptance criteria:\n${input.task.acceptanceCriteria.trim()}`
      : "",
    `Project: ${input.project.title}`,
    input.mode === "retry"
      ? "Retry this task using the current thread context. Continue from the existing work, address the previous failure or incomplete state, and end in a reviewable handoff."
      : "Complete this task and leave the work in a reviewable state.",
  ].filter((section) => section.length > 0);

  return sections.join("\n\n");
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModel: command.defaultModel ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModel !== undefined ? { defaultModel: command.defaultModel } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "project.orchestration-rules.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const existingRules = readModel.projectRules.find((entry) => entry.projectId === command.projectId);
      const occurredAt = command.createdAt;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.orchestration-rules-updated",
        payload: {
          projectId: command.projectId,
          promptTemplate: command.promptTemplate ?? existingRules?.promptTemplate ?? "",
          defaultModel:
            command.defaultModel !== undefined
              ? command.defaultModel
              : existingRules?.defaultModel ?? project.defaultModel ?? null,
          defaultRuntimeMode:
            command.defaultRuntimeMode ??
            existingRules?.defaultRuntimeMode ??
            "full-access",
          onSuccessMoveTo: command.onSuccessMoveTo ?? existingRules?.onSuccessMoveTo ?? "review",
          onFailureMoveTo: command.onFailureMoveTo ?? existingRules?.onFailureMoveTo ?? "blocked",
          updatedAt: occurredAt,
        },
      };
    }

    case "task.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireTaskAbsent({
        readModel,
        command,
        taskId: command.taskId,
      });
      return {
        ...withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "task.created",
        payload: {
          taskId: command.taskId,
          projectId: command.projectId,
          title: command.title,
          brief: command.brief,
          acceptanceCriteria: command.acceptanceCriteria ?? "",
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          state: command.state ?? "backlog",
          priority: command.priority ?? null,
          threadId: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "task.meta.update": {
      yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      const occurredAt = command.updatedAt ?? nowIso();
      return {
        ...withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "task.meta-updated",
        payload: {
          taskId: command.taskId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.brief !== undefined ? { brief: command.brief } : {}),
          ...(command.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: command.acceptanceCriteria }
            : {}),
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          ...(command.priority !== undefined ? { priority: command.priority } : {}),
          ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "task.state.set": {
      yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      return {
        ...withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "task.state-set",
        payload: {
          taskId: command.taskId,
          state: command.state,
          updatedAt: command.createdAt,
        },
      };
    }

    case "task.delete": {
      yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      return {
        ...withEventBase({
          aggregateKind: "task",
          aggregateId: command.taskId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "task.deleted",
        payload: {
          taskId: command.taskId,
          deletedAt: command.createdAt,
        },
      };
    }

    case "task.run.start": {
      const task = yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: task.projectId,
      });
      const projectRules = readModel.projectRules.find((entry) => entry.projectId === task.projectId);
      const threadId = task.threadId ?? newThreadIdFromTask(task.id);
      const existingThread = readModel.threads.find((entry) => entry.id === threadId) ?? null;
      const model = projectRules?.defaultModel ?? project.defaultModel ?? "gpt-5";
      const runtimeMode = projectRules?.defaultRuntimeMode ?? "full-access";
      const prompt = taskRunPrompt({ task, project, projectRules, mode: "start" });
      const messageId = newMessageId();
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (!existingThread) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.created",
          payload: {
            threadId,
            projectId: task.projectId,
            origin: "task",
            taskId: task.id,
            title: task.title,
            model,
            runtimeMode,
            interactionMode: "default",
            isPinned: false,
            pinnedAt: null,
            branch: null,
            worktreePath: null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            archivedAt: null,
          },
        });
      }
      events.push(
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.run-start-requested",
          payload: {
            taskId: task.id,
            threadId,
            createdAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.meta-updated",
          payload: {
            taskId: task.id,
            threadId,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.state-set",
          payload: {
            taskId: task.id,
            state: "running",
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId,
            role: "user",
            text: prompt,
            attachments: task.attachments ?? [],
            turnId: null,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-start-requested",
          payload: {
            threadId,
            messageId,
            model,
            assistantDeliveryMode: DEFAULT_ASSISTANT_DELIVERY_MODE,
            runtimeMode,
            interactionMode: "default",
            createdAt: command.createdAt,
          },
        },
      );
      return events;
    }

    case "task.run.stop": {
      const task = yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.state-set",
          payload: {
            taskId: task.id,
            state: "ready",
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.run-stop-requested",
          payload: {
            taskId: task.id,
            threadId: task.threadId,
            createdAt: command.createdAt,
          },
        },
      ];
      if (task.threadId) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: task.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.session-stop-requested",
          payload: {
            threadId: task.threadId,
            createdAt: command.createdAt,
          },
        });
      }
      return events;
    }

    case "task.run.retry": {
      const task = yield* requireTask({
        readModel,
        command,
        taskId: command.taskId,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: task.projectId,
      });
      const projectRules = readModel.projectRules.find((entry) => entry.projectId === task.projectId);
      const threadId = task.threadId ?? newThreadIdFromTask(task.id);
      const model = projectRules?.defaultModel ?? project.defaultModel ?? "gpt-5";
      const runtimeMode = projectRules?.defaultRuntimeMode ?? "full-access";
      const prompt = taskRunPrompt({ task, project, projectRules, mode: "retry" });
      const messageId = newMessageId();
      return [
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.run-retry-requested",
          payload: {
            taskId: task.id,
            threadId,
            createdAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "task",
            aggregateId: task.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "task.state-set",
          payload: {
            taskId: task.id,
            state: "running",
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId,
            messageId,
            role: "user",
            text: prompt,
            attachments: task.attachments ?? [],
            turnId: null,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.turn-start-requested",
          payload: {
            threadId,
            messageId,
            model,
            assistantDeliveryMode: DEFAULT_ASSISTANT_DELIVERY_MODE,
            runtimeMode,
            interactionMode: "default",
            createdAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          origin: command.origin ?? "user",
          taskId: command.taskId ?? null,
          ...(command.parentThreadId !== undefined ? { parentThreadId: command.parentThreadId } : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          title: command.title,
          model: command.model,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          isPinned: command.isPinned ?? false,
          pinnedAt: command.pinnedAt ?? null,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: null,
        },
      };
    }

    case "thread.handoff.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }

      if (sourceThread.handoff != null && !hasNativeHandoffMessages(sourceThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' must contain at least one native assistant message after handoff before it can be handed off again.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          origin: "user",
          taskId: null,
          title: command.title,
          model: command.model,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          isPinned: false,
          pinnedAt: null,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          archivedAt: null,
          handoff: {
            sourceThreadId: command.sourceThreadId,
            sourceProvider: inferProviderFromModel(sourceThread.model),
            importedAt: command.createdAt,
            bootstrapStatus: "completed",
          },
        },
      };

      const importedMessagesFromSource = buildImportedHandoffMessagesFromSourceThread(sourceThread);
      const importedMessages =
        importedMessagesFromSource.length > 0 ? importedMessagesFromSource : command.importedMessages;

      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
        };
    }

    case "thread.archive": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          unarchivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.pinnedAt !== undefined ? { pinnedAt: command.pinnedAt } : {}),
          ...(command.parentThreadId !== undefined ? { parentThreadId: command.parentThreadId } : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.serviceTier !== undefined ? { serviceTier: command.serviceTier } : {}),
          ...(command.modelOptions !== undefined ? { modelOptions: command.modelOptions } : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          runtimeMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.runtimeMode ??
            command.runtimeMode,
          interactionMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.interactionMode ??
            command.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
