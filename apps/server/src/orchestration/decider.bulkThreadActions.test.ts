import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

async function applyEvent(
  readModel: OrchestrationReadModel,
  event: OrchestrationEvent,
): Promise<OrchestrationReadModel> {
  return Effect.runPromise(projectEvent(readModel, event));
}

function threadCreatedEvent(input: {
  sequence: number;
  threadId: ThreadId;
  projectId: ProjectId;
  parentThreadId: ThreadId | null;
  createdAt: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: asEventId(`evt-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    type: "thread.created",
    occurredAt: input.createdAt,
    commandId: CommandId.makeUnsafe(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`cmd-${input.sequence}`),
    metadata: {},
    payload: {
      threadId: input.threadId,
      projectId: input.projectId,
      origin: "user",
      taskId: null,
      parentThreadId: input.parentThreadId,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      title: `Thread ${input.sequence}`,
      model: "gpt-5-codex",
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      isPinned: false,
      pinnedAt: null,
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

describe("decider bulk thread actions", () => {
  it("deletes project threads before the project, with child threads first", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const projectId = asProjectId("project-bulk-delete");
    const parentThreadId = asThreadId("thread-parent");
    const childThreadId = asThreadId("thread-child");
    let readModel = createEmptyReadModel(now);

    readModel = await applyEvent(readModel, {
      sequence: 1,
      eventId: asEventId("evt-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project"),
      metadata: {},
      payload: {
        projectId,
        title: "Bulk Delete",
        workspaceRoot: "/tmp/bulk-delete",
        defaultModel: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    readModel = await applyEvent(
      readModel,
      threadCreatedEvent({
        sequence: 2,
        threadId: parentThreadId,
        projectId,
        parentThreadId: null,
        createdAt: now,
      }),
    );
    readModel = await applyEvent(
      readModel,
      threadCreatedEvent({
        sequence: 3,
        threadId: childThreadId,
        projectId,
        parentThreadId: parentThreadId,
        createdAt: now,
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-project"),
          projectId,
          deleteThreads: true,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.deleted",
      "thread.deleted",
      "project.deleted",
    ]);
    expect(events.map((event) => event.aggregateId)).toEqual([
      childThreadId,
      parentThreadId,
      projectId,
    ]);
  });
});
