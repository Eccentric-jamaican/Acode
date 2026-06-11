import {
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProjectId,
  TaskId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { markThreadUnread, syncServerReadModel, type AppState } from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    origin: "user",
    taskId: null,
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    isPinned: false,
    pinnedAt: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        scripts: [],
      },
    ],
    projectRules: [],
    tasks: [],
    taskRuntimes: [],
    errorInbox: [],
    threads: [thread],
    threadsHydrated: true,
    hydrationStatus: "ready",
    hydrationError: null,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]> = {}) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    origin: "user",
    taskId: null,
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    isPinned: false,
    pinnedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [thread],
  };
}

function makeTaskReadModel(
  threadId: ThreadId | null = null,
): OrchestrationReadModel["tasks"][number] {
  return {
    id: TaskId.makeUnsafe("task-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Task",
    brief: "Brief",
    acceptanceCriteria: "",
    state: "running",
    priority: null,
    threadId,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          interactionMode: "default",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("sanitizes lightweight markdown in hydrated subagent thread titles", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        id: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "**Current Shape**",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.title).toBe("Current Shape");
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });
});

describe("store read model sync", () => {
  it("preserves Claude models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-fable-5",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-fable-5");
  });

  it("maps legacy Claude session providers to Claude instead of Codex", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-sonnet-4-6",
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          providerName: "claudeAgent",
          status: "ready",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.session?.provider).toBe("claudeAgent");
    expect(next.threads[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to the codex default for unsupported provider models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "unknown-model",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("maps thread pin state from the read model", () => {
    const initialState = makeState(makeThread({ isPinned: false }));
    const readModel = makeReadModel(
      makeReadModelThread({
        isPinned: true,
        pinnedAt: "2026-03-03T00:00:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.isPinned).toBe(true);
    expect(next.threads[0]?.pinnedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("defaults missing thread pin state to false during read model sync", () => {
    const initialState = makeState(makeThread({ isPinned: true }));
    const thread = makeReadModelThread();
    const readModel = makeReadModel(thread);
    Reflect.deleteProperty(readModel.threads[0] as Record<string, unknown>, "isPinned");

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.isPinned).toBe(false);
    expect(next.threads[0]?.pinnedAt).toBeNull();
  });

  it("maps tasks and task-owned thread metadata from the read model", () => {
    const initialState = makeState(makeThread({ origin: "user", taskId: null }));
    const readModel = {
      ...makeReadModel(
        makeReadModelThread({
          origin: "task",
          taskId: TaskId.makeUnsafe("task-1"),
        }),
      ),
      tasks: [makeTaskReadModel(ThreadId.makeUnsafe("thread-1"))],
      taskRuntimes: [
        {
          taskId: TaskId.makeUnsafe("task-1"),
          status: "running",
          activeTurnId: null,
          lastError: null,
          lastActivityAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      ],
      projectRules: [
        {
          projectId: ProjectId.makeUnsafe("project-1"),
          promptTemplate: "Do the work",
          defaultModel: "gpt-5.3-codex",
          defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
          onSuccessMoveTo: "review",
          onFailureMoveTo: "blocked",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    } satisfies OrchestrationReadModel;

    const next = syncServerReadModel(initialState, readModel);

    expect(next.tasks).toHaveLength(1);
    expect(next.taskRuntimes[0]?.status).toBe("running");
    expect(next.projectRules[0]?.onSuccessMoveTo).toBe("review");
    expect(next.threads[0]?.origin).toBe("task");
    expect(next.threads[0]?.taskId).toBe(TaskId.makeUnsafe("task-1"));
  });

  it("returns the same state object when a read model snapshot has no effective changes", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(makeReadModelThread());

    const hydrated = syncServerReadModel(initialState, readModel);
    const repeated = syncServerReadModel(hydrated, readModel);

    expect(repeated).toBe(hydrated);
  });

  it("preserves loaded thread messages during lightweight snapshot sync", () => {
    const initialState = makeState(makeThread());
    const loadedThread = makeReadModelThread({
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          turnId: null,
          role: "assistant",
          text: "Loaded message body",
          streaming: false,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          attachments: [],
        },
      ],
    });
    const hydrated = syncServerReadModel(initialState, makeReadModel(loadedThread));
    const lightweightThread = makeReadModelThread({
      title: "Updated title",
      updatedAt: "2026-02-27T00:01:00.000Z",
      messages: [],
    });

    const next = syncServerReadModel(hydrated, makeReadModel(lightweightThread), {
      preserveThreadDetails: true,
    });

    expect(next.threads[0]?.title).toBe("Updated title");
    expect(next.threads[0]?.messages).toBe(hydrated.threads[0]?.messages);
    expect(next.threads[0]?.messages[0]?.text).toBe("Loaded message body");
  });

  it("preserves omitted thread details while accepting empty authoritative focused details", () => {
    const initialState = makeState(makeThread());
    const firstThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          turnId: null,
          role: "assistant",
          text: "Keep this already loaded body",
          streaming: false,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          attachments: [],
        },
      ],
    });
    const secondThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-2"),
      title: "Focused thread",
      messages: [
        {
          id: MessageId.makeUnsafe("message-2"),
          turnId: null,
          role: "assistant",
          text: "Replace this with the focused snapshot result",
          streaming: false,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
          attachments: [],
        },
      ],
    });
    const hydrated = syncServerReadModel(initialState, {
      ...makeReadModel(firstThread),
      threads: [firstThread, secondThread],
    });
    const focusedSnapshot = {
      ...makeReadModel(firstThread),
      threads: [
        { ...firstThread, messages: [] },
        { ...secondThread, messages: [] },
      ],
    } satisfies OrchestrationReadModel;

    const next = syncServerReadModel(hydrated, focusedSnapshot, {
      authoritativeThreadDetailIds: new Set([ThreadId.makeUnsafe("thread-2")]),
      preserveThreadDetails: true,
    });

    expect(next.threads[0]?.messages).toBe(hydrated.threads[0]?.messages);
    expect(next.threads[0]?.messages[0]?.text).toBe("Keep this already loaded body");
    expect(next.threads[1]?.messages).toEqual([]);
  });

  it("reuses unchanged threads and messages when another thread changes", () => {
    const initialState = makeState(makeThread());
    const firstThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          turnId: null,
          role: "assistant",
          text: "Stable",
          streaming: false,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          attachments: [],
        },
      ],
    });
    const secondThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-2"),
      title: "Streaming",
      messages: [
        {
          id: MessageId.makeUnsafe("message-2"),
          turnId: null,
          role: "assistant",
          text: "Hel",
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
          attachments: [],
        },
      ],
    });
    const readModel = {
      ...makeReadModel(firstThread),
      threads: [firstThread, secondThread],
    } satisfies OrchestrationReadModel;
    const hydrated = syncServerReadModel(initialState, readModel);
    const changedSecondThread = {
      ...secondThread,
      messages: [
        {
          ...secondThread.messages[0]!,
          text: "Hello",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      ],
    } satisfies OrchestrationReadModel["threads"][number];

    const next = syncServerReadModel(hydrated, {
      ...readModel,
      threads: [firstThread, changedSecondThread],
    });

    expect(next.threads[0]).toBe(hydrated.threads[0]);
    expect(next.threads[0]?.messages[0]).toBe(hydrated.threads[0]?.messages[0]);
    expect(next.threads[1]).not.toBe(hydrated.threads[1]);
    expect(next.threads[1]?.messages[0]).not.toBe(hydrated.threads[1]?.messages[0]);
  });
});
