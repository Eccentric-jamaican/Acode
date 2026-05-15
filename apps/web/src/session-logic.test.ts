import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveActivePlanState,
  deriveRevertTurnCountByUserMessageId,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("removes prompts when the provider reports a stale user-input response", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-stale-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "User input response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-user-input-1",
          detail: "Unknown pending user input request: req-stale-user-input-1",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn when the latest turn is in plan mode", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"), "plan")).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("returns null for default-mode latest turns even if they emitted plan updates", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-default-turn",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"), "default")).toBeNull();
  });

  it("ignores older plan-mode turns when the latest turn is default", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-older-turn",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Older plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest-default-turn",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-2",
        payload: {
          explanation: "Implementation details",
          plan: [{ step: "Ship change", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-2"), "default")).toBeNull();
  });

  it("returns null when there is no latest turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-without-latest-turn",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, undefined, "plan")).toBeNull();
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths from nested tool and approval payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              result: {
                changes: [{ path: "apps/web/src/components/ChatView.tsx" }],
              },
            },
          },
        },
      }),
      makeActivity({
        id: "approval-request",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "file-change",
          args: {
            changes: [{ filePath: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "file-tool",
          changedFiles: ["apps/web/src/components/ChatView.tsx"],
          itemType: "file_change",
        }),
        expect.objectContaining({
          id: "approval-request",
          changedFiles: ["apps/web/src/session-logic.ts"],
          requestKind: "file-change",
          tone: "info",
        }),
      ]),
    );
  });

  it("parses canonical invocation diff files from payload.data.diff.files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-with-diff",
        kind: "tool.updated",
        summary: "Edit file",
        payload: {
          itemType: "file_change",
          data: {
            diff: {
              files: [
                {
                  path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                  additions: 4,
                  deletions: 2,
                  status: "modified",
                  before: "before",
                  after: "after",
                },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.invocationDiffFiles).toEqual([
      {
        path: "apps/web/src/components/chat/MessagesTimeline.tsx",
        additions: 4,
        deletions: 2,
        status: "modified",
        before: "before",
        after: "after",
      },
    ]);
    expect(entry?.invocationDiffStat).toEqual({ additions: 4, deletions: 2 });
  });

  it("does not infer invocation diff from non-canonical payload fields", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-no-canonical-diff",
        kind: "tool.completed",
        summary: "Edit file",
        payload: {
          itemType: "file_change",
          data: {
            files: [
              {
                path: "apps/web/src/session-logic.ts",
                additions: 9,
                deletions: 3,
              },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.invocationDiffFiles).toBeUndefined();
    expect(entry?.invocationDiffStat).toBeUndefined();
  });

  it("surfaces generated image artifacts from image tool payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "image-tool",
        kind: "tool.completed",
        summary: "Image view",
        payload: {
          itemType: "image_view",
          title: "Image view",
          data: {
            generatedImagePath: "C:\\Users\\Addis\\.codex\\generated_images\\thread-1\\ig_123.png",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.generatedImages).toEqual([
      {
        cwd: "C:/Users/Addis/.codex/generated_images/thread-1",
        label: "Generated image",
        path: "ig_123.png",
      },
    ]);
  });

  it("surfaces native Codex image generation results as previewable artifacts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "native-image-tool",
        kind: "tool.completed",
        summary: "Image view",
        payload: {
          itemType: "image_view",
          title: "Image view",
          data: {
            item: {
              type: "imageGeneration",
              id: "ig_456",
              result: "iVBORw0KGgoAAAANSUhEUgAAAAE=",
            },
            threadId: "codex-thread-1",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.generatedImages).toEqual([
      {
        label: "Generated image",
        path: "ig_456.png",
        previewUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=",
        providerThreadId: "codex-thread-1",
      },
    ]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("uses command result output as work log detail", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-complete",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "rg foo",
          data: {
            item: {
              command: "rg foo",
              result: {
                stdout: "apps/web/src/session-logic.ts:42:foo",
                stderr: "",
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("rg foo");
    expect(entry?.detail).toBe("apps/web/src/session-logic.ts:42:foo");
  });

  it("merges streamed command output into the matching command work log row", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-complete",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          providerItemId: "item-command-1",
          detail: "rg foo",
          data: {
            item: {
              command: "rg foo",
            },
          },
        },
      }),
      makeActivity({
        id: "command-output",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          providerItemId: "item-command-1",
          detail: "apps/web/src/session-logic.ts:42:foo",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe("rg foo");
    expect(entries[0]?.detail).toBe("apps/web/src/session-logic.ts:42:foo");
  });

  it("normalizes legacy bash lifecycle rows into one command entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "placeholder-progress",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "bash",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          data: {
            toolName: "bash",
            input: {},
          },
        },
      }),
      makeActivity({
        id: "command-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "bash",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          data: {
            toolName: "bash",
            input: {
              command: "rg foo apps/web/src",
              description: "Find foo",
            },
          },
        },
      }),
      makeActivity({
        id: "command-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Find foo",
        payload: {
          itemType: "command_execution",
          data: {
            toolName: "bash",
            input: {
              command: "rg foo apps/web/src",
              description: "Find foo",
            },
            output: "apps/web/src/session-logic.ts:42:foo",
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.itemType).toBe("command_execution");
    expect(entries[0]?.command).toBe("rg foo apps/web/src");
    expect(entries[0]?.detail).toBe("apps/web/src/session-logic.ts:42:foo");
  });

  it("treats legacy read tools as file reads without changed files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "README.md",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            toolName: "read",
            input: {
              filePath: "C:\\Users\\Addis\\source\\repos\\t3code\\README.md",
            },
            output: "file contents",
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.requestKind).toBe("file-read");
    expect(entry?.itemType).toBe("dynamic_tool_call");
    expect(entry?.changedFiles).toBeUndefined();
    expect(entry?.detail).toBe("file contents");
  });

  it("infers legacy write tools as file changes", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "write-complete",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "write",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            toolName: "write",
            input: {
              filePath: "apps/web/src/session-logic.ts",
              content: "hello",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.requestKind).toBe("file-change");
    expect(entry?.itemType).toBe("file_change");
    expect(entry?.changedFiles).toEqual(["apps/web/src/session-logic.ts"]);
  });

  it("extracts compact web search queries and urls", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Web search",
        payload: {
          itemType: "web_search",
          data: {
            item: {
              input: {
                query: "latest OpenAI news",
              },
              result: {
                results: [
                  { url: "https://openai.com/news/company-announcements/" },
                  { url: "https://openai.com/index/gpt-5-5-instant/" },
                ],
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.webSearchQueries).toEqual(["latest OpenAI news"]);
    expect(entry?.webSearchUrls).toEqual([
      "https://openai.com/news/company-announcements/",
      "https://openai.com/index/gpt-5-5-instant/",
    ]);
  });

  it("omits collab subagent tool lifecycle rows from the chat work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "collab-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Spawn subagents",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Spawn agent",
          data: {
            item: {
              receiverAgents: [
                {
                  threadId: "subagent:thread-1:agent-1",
                  agentNickname: "Locke",
                  agentRole: "explorer",
                },
                {
                  threadId: "subagent:thread-1:agent-2",
                  agentNickname: "Ada",
                  agentRole: "worker",
                },
              ],
            },
          },
        },
      }),
      makeActivity({
        id: "collab-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Spawn subagents",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Spawn agent",
          data: {
            item: {
              receiverThreadIds: ["subagent:thread-1:agent-1", "subagent:thread-1:agent-2"],
            },
          },
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
      },
    });
  });
});

describe("deriveRevertTurnCountByUserMessageId", () => {
  it("maps each user message to the first following assistant checkpoint in the same exchange", () => {
    const userOneId = MessageId.makeUnsafe("message-user-1");
    const assistantOneId = MessageId.makeUnsafe("message-assistant-1");
    const assistantTwoId = MessageId.makeUnsafe("message-assistant-2");
    const userTwoId = MessageId.makeUnsafe("message-user-2");
    const assistantThreeId = MessageId.makeUnsafe("message-assistant-3");
    const turnOneId = TurnId.makeUnsafe("turn-1");
    const turnTwoId = TurnId.makeUnsafe("turn-2");
    const turnThreeId = TurnId.makeUnsafe("turn-3");

    const timelineEntries = deriveTimelineEntries(
      [
        {
          id: userOneId,
          role: "user",
          text: "first prompt",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: assistantOneId,
          role: "assistant",
          text: "first reply",
          turnId: turnOneId,
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
        {
          id: assistantTwoId,
          role: "assistant",
          text: "follow up reply",
          turnId: turnTwoId,
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
        {
          id: userTwoId,
          role: "user",
          text: "second prompt",
          createdAt: "2026-02-23T00:00:04.000Z",
          streaming: false,
        },
        {
          id: assistantThreeId,
          role: "assistant",
          text: "second reply",
          turnId: turnThreeId,
          createdAt: "2026-02-23T00:00:05.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    const byAssistantMessageId = new Map([
      [
        assistantOneId,
        {
          turnId: turnOneId,
          completedAt: "2026-02-23T00:00:02.500Z",
          files: [],
          checkpointTurnCount: 3,
          assistantMessageId: assistantOneId,
        },
      ],
      [
        assistantThreeId,
        {
          turnId: turnThreeId,
          completedAt: "2026-02-23T00:00:05.500Z",
          files: [],
          checkpointTurnCount: 1,
          assistantMessageId: assistantThreeId,
        },
      ],
    ]);

    const result = deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      byAssistantMessageId,
      new Map([
        [
          turnTwoId,
          {
            turnId: turnTwoId,
            completedAt: "2026-02-23T00:00:03.500Z",
            files: [],
            checkpointTurnCount: 4,
            assistantMessageId: assistantTwoId,
          },
        ],
      ]),
      {},
    );

    expect(result).toEqual(
      new Map([
        [userOneId, 2],
        [userTwoId, 0],
      ]),
    );
  });

  it("uses inferred checkpoint turn counts when explicit counts are missing", () => {
    const userId = MessageId.makeUnsafe("message-user-inferred");
    const assistantId = MessageId.makeUnsafe("message-assistant-inferred");
    const turnId = TurnId.makeUnsafe("turn-inferred");
    const timelineEntries = deriveTimelineEntries(
      [
        {
          id: userId,
          role: "user",
          text: "prompt",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: assistantId,
          role: "assistant",
          text: "reply",
          turnId,
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    const result = deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      new Map(),
      new Map([
        [
          turnId,
          {
            turnId,
            completedAt: "2026-02-23T00:00:02.500Z",
            files: [],
          },
        ],
      ]),
      { [turnId]: 2 },
    );

    expect(result).toEqual(new Map([[userId, 1]]));
  });

  it("does not cross into the next user exchange when no checkpoint exists yet", () => {
    const userOneId = MessageId.makeUnsafe("message-user-no-checkpoint");
    const assistantOneId = MessageId.makeUnsafe("message-assistant-no-checkpoint");
    const userTwoId = MessageId.makeUnsafe("message-user-with-checkpoint");
    const assistantTwoId = MessageId.makeUnsafe("message-assistant-with-checkpoint");
    const turnTwoId = TurnId.makeUnsafe("turn-with-checkpoint");
    const timelineEntries = deriveTimelineEntries(
      [
        {
          id: userOneId,
          role: "user",
          text: "first prompt",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: assistantOneId,
          role: "assistant",
          text: "first reply",
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
        {
          id: userTwoId,
          role: "user",
          text: "second prompt",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
        {
          id: assistantTwoId,
          role: "assistant",
          text: "second reply",
          turnId: turnTwoId,
          createdAt: "2026-02-23T00:00:04.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    const result = deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      new Map([
        [
          assistantTwoId,
          {
            turnId: turnTwoId,
            completedAt: "2026-02-23T00:00:04.500Z",
            files: [],
            checkpointTurnCount: 2,
            assistantMessageId: assistantTwoId,
          },
        ],
      ]),
      new Map(),
      {},
    );

    expect(result).toEqual(new Map([[userTwoId, 1]]));
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("includes all providers with correct availability", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "claudeAgent", label: "Claude Code", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude Code",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
