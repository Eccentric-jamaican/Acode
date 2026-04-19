import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../session-logic";
import type { Thread } from "../types";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { enrichSubagentWorkEntries } from "./subagentWorkEntries";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    origin: "user",
    taskId: null,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    title: id,
    model: "gpt-5.4",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: "2026-03-01T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    isPinned: false,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "work-1",
    createdAt: "2026-03-01T00:00:00.000Z",
    label: "Delegate to subagent",
    tone: "tool",
    itemType: "collab_agent_tool_call",
    payload: {
      data: {
        receiverAgents: [
          {
            threadId: "child-provider-1",
            agentId: "agent-1",
            agentNickname: "Locke",
            agentRole: "explorer",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("enrichSubagentWorkEntries", () => {
  it("enriches collab work entries with resolved child-thread metadata", () => {
    const childThread = makeThread("subagent:thread-1:child-provider-1", {
      parentThreadId: ThreadId.makeUnsafe("thread-1"),
      subagentAgentId: "agent-1",
      subagentNickname: "Locke",
      subagentRole: "explorer",
      title: "Locke [explorer]",
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Searching the repository structure.",
          createdAt: "2026-03-01T00:00:00.000Z",
          streaming: false,
          completedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });

    const [entry] = enrichSubagentWorkEntries({
      entries: [makeEntry()],
      parentThreadId: "thread-1",
      threads: [childThread],
    });

    expect(entry?.subagentAction?.summaryText).toBe("Locke");
    expect(entry?.subagents?.[0]).toMatchObject({
      threadId: "child-provider-1",
      resolvedThreadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
      nickname: "Locke",
      role: "explorer",
      statusLabel: "Running",
      latestUpdate: "Searching the repository structure.",
      isActive: true,
    });
  });

  it("uses a child thread's first assistant update as the fallback subagent label", () => {
    const childThread = makeThread("subagent:thread-1:child-provider-2", {
      parentThreadId: ThreadId.makeUnsafe("thread-1"),
      title: "Subagent child-provider-2",
      messages: [
        {
          id: "assistant-2" as never,
          role: "assistant",
          text: "Mapping the websocket bootstrap path before I touch the routing layer.",
          createdAt: "2026-03-01T00:00:00.000Z",
          streaming: false,
          completedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });

    const [entry] = enrichSubagentWorkEntries({
      entries: [
        makeEntry({
          payload: {
            data: {
              receiverThreadIds: ["child-provider-2"],
            },
          },
        }),
      ],
      parentThreadId: "thread-1",
      threads: [childThread],
    });

    expect(entry?.subagentAction?.summaryText).toBe(
      "Mapping the websocket bootstrap path before I touch the routing layer.",
    );
    expect(entry?.subagents?.[0]?.title).toBe(
      "Mapping the websocket bootstrap path before I touch the routing layer.",
    );
  });

  it("leaves non-collab work entries untouched", () => {
    const entry = makeEntry({ itemType: "command_execution" });

    expect(
      enrichSubagentWorkEntries({
        entries: [entry],
        parentThreadId: "thread-1",
        threads: [],
      }),
    ).toEqual([entry]);
  });
});
