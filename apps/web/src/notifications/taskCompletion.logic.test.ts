import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  buildDesktopNotificationPayload,
  collectApprovalRequestCandidates,
  collectCompletedThreadCandidates,
  collectUserInputRequestCandidates,
} from "./taskCompletion.logic";

function createThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as Thread["id"],
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    origin: "user",
    taskId: null,
    title: "Test thread",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: "2026-04-18T12:00:00.000Z",
      updatedAt: "2026-04-18T12:00:00.000Z",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-18T12:00:00.000Z",
    updatedAt: "2026-04-18T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    isPinned: false,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function createActivity(
  overrides: Partial<OrchestrationThreadActivity>,
): OrchestrationThreadActivity {
  return {
    id: "activity-1" as OrchestrationThreadActivity["id"],
    turnId: null,
    kind: "thinking",
    summary: "Activity",
    tone: "info",
    createdAt: "2026-04-18T12:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

describe("taskCompletion notification logic", () => {
  it("detects a fresh completed turn transition", () => {
    const previous = createThread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: "turn-1" as TurnId,
        createdAt: "2026-04-18T12:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      latestTurn: {
        turnId: "turn-1" as TurnId,
        state: "running",
        interactionMode: "default",
        requestedAt: "2026-04-18T12:00:00.000Z",
        startedAt: "2026-04-18T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const next = createThread({
      messages: [
        {
          id: "assistant-1" as Thread["messages"][number]["id"],
          role: "assistant",
          text: "Finished the work successfully.",
          createdAt: "2026-04-18T12:00:05.000Z",
          completedAt: "2026-04-18T12:00:08.000Z",
          streaming: false,
        },
      ],
      latestTurn: {
        turnId: "turn-1" as TurnId,
        state: "completed",
        interactionMode: "default",
        requestedAt: "2026-04-18T12:00:00.000Z",
        startedAt: "2026-04-18T12:00:00.000Z",
        completedAt: "2026-04-18T12:00:08.000Z",
        assistantMessageId: null,
      },
    });

    const candidates = collectCompletedThreadCandidates([previous], [next]);
    const payload = buildDesktopNotificationPayload(candidates[0]!);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.notificationId).toBe("turn-completed:thread-1:2026-04-18T12:00:08.000Z");
    expect(candidates[0]?.assistantSummary).toBe("Finished the work successfully.");
    expect(payload.kind).toBe("turn_completed");
    expect(payload.title).toBe("Test thread");
    expect(payload.body).toBe("Finished the work successfully.");
  });

  it("normalizes markdown-heavy assistant text for compact notification bodies", () => {
    const previous = createThread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: "turn-2" as TurnId,
        createdAt: "2026-04-18T12:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      latestTurn: {
        turnId: "turn-2" as TurnId,
        state: "running",
        interactionMode: "default",
        requestedAt: "2026-04-18T12:00:00.000Z",
        startedAt: "2026-04-18T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const next = createThread({
      messages: [
        {
          id: "assistant-2" as Thread["messages"][number]["id"],
          role: "assistant",
          text: "## Summary\n\n- Updated [`taskCompletion.tsx`](/abs/path)\n- Tightened `toast` copy for **Windows** notifications.",
          createdAt: "2026-04-18T12:00:05.000Z",
          completedAt: "2026-04-18T12:00:08.000Z",
          streaming: false,
        },
      ],
      latestTurn: {
        turnId: "turn-2" as TurnId,
        state: "completed",
        interactionMode: "default",
        requestedAt: "2026-04-18T12:00:00.000Z",
        startedAt: "2026-04-18T12:00:00.000Z",
        completedAt: "2026-04-18T12:00:08.000Z",
        assistantMessageId: null,
      },
    });

    const payload = buildDesktopNotificationPayload(
      collectCompletedThreadCandidates([previous], [next])[0]!,
    );

    expect(payload.kind).toBe("turn_completed");
    expect(payload.body).toBe(
      "Summary Updated taskCompletion.tsx Tightened toast copy for Windows notifications.",
    );
  });

  it("detects a new approval request and builds a typed payload", () => {
    const next = createThread({
      activities: [
        createActivity({
          id: "approval-activity" as OrchestrationThreadActivity["id"],
          kind: "approval.requested",
          summary: "Command approval requested",
          tone: "approval",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
            detail: "Run npm install?",
          },
        }),
      ],
    });

    const candidates = collectApprovalRequestCandidates([], [next]);
    const payload = buildDesktopNotificationPayload(candidates[0]!);

    expect(candidates).toHaveLength(1);
    expect(payload.kind).toBe("approval_required");
    if (payload.kind !== "approval_required") {
      throw new Error("expected approval_required payload");
    }
    expect(payload.requestId).toBe("approval-request-1");
    expect(payload.requestKind).toBe("command");
    expect(payload.title).toBe("Test thread");
    expect(payload.body).toBe("Approval needed: Run npm install?");
  });

  it("detects structured user input requests and maps option ids for desktop selections", () => {
    const next = createThread({
      activities: [
        createActivity({
          id: "user-input-activity" as OrchestrationThreadActivity["id"],
          kind: "user-input.requested",
          summary: "Input requested",
          tone: "info",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which sandbox mode should be used?",
                options: [
                  {
                    label: "Workspace write (Recommended)",
                    description: "Can edit files in the workspace only.",
                  },
                  {
                    label: "Read only",
                    description: "No file edits allowed.",
                  },
                ],
              },
            ],
          },
        }),
      ],
    });

    const candidates = collectUserInputRequestCandidates([], [next]);
    const payload = buildDesktopNotificationPayload(candidates[0]!);

    expect(candidates).toHaveLength(1);
    expect(payload.kind).toBe("user_input_required");
    if (payload.kind !== "user_input_required") {
      throw new Error("expected user_input_required payload");
    }
    expect(payload.title).toBe("Test thread");
    expect(payload.body).toBe("Sandbox: Which sandbox mode should be used?");
    expect(payload.questions[0]?.options[0]?.id).toBe("q0-o0");
    expect(payload.questions[0]?.options[0]?.label).toBe("Workspace write (Recommended)");
  });
});
