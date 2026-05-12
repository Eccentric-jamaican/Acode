// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  type CheckpointRef,
  type BrowserPaneBounds,
  type BrowserSessionSnapshot,
  EventId,
  type DesktopBridge,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationProposedPlanId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type TurnId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { applyDesktopWindowChromeMetrics } from "../desktopWindowChrome";
import { useBrowserPaneStore } from "../browserPaneStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import { estimateTimelineMessageHeight } from "./timelineHeight";

const THREAD_ID = "thread-browser-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
const USER_MARKDOWN_TEXT = [
  "# User heading",
  "",
  "- first item",
  "- second item",
  "",
  "> quoted note",
  "",
  "Inline `code` sample",
  "",
  "```ts",
  "const value = 1;",
  "```",
].join("\n");

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
  wsRpcResults?: Partial<Record<string, unknown>>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024, textTolerancePx: 44, attachmentTolerancePx: 56 },
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 120, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 120, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}

interface MountedChatView {
  cleanup: () => Promise<void>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  navigate: (path: string) => Promise<void>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    providerAccounts: [],
    availableEditors: [],
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  turnId?: TurnId | null;
}) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: options.turnId ?? null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Browser test thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
    wsRpcResults: {},
  };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function createChatViewSnapshot(options: {
  messages: OrchestrationReadModel["threads"][number]["messages"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Browser test thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: options.messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createSelectionFeatureSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Selection feature thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createUserMessage({
            id: "msg-user-selection" as MessageId,
            text: "User question about daemons",
            offsetSeconds: 0,
          }),
          createAssistantMessage({
            id: "msg-assistant-selection" as MessageId,
            text: "A daemon is a background process that runs without direct user interaction.",
            offsetSeconds: 3,
          }),
        ],
        activities: [],
        proposedPlans: [
          {
            id: "plan-selection-1" as OrchestrationProposedPlanId,
            turnId: null,
            planMarkdown: "# Plan heading\n\nExplain this planned change.",
            createdAt: isoAt(6),
            updatedAt: isoAt(6),
          },
        ],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createActivePlanRegressionSnapshot(options: {
  latestTurnInteractionMode: "default" | "plan";
}): OrchestrationReadModel {
  const historicalTurnId = "turn-plan-history" as TurnId;
  const latestTurnId = "turn-plan-latest" as TurnId;

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Plan regression thread",
        model: "gpt-5",
        interactionMode: options.latestTurnInteractionMode,
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: {
          turnId: latestTurnId,
          state: "running",
          interactionMode: options.latestTurnInteractionMode,
          requestedAt: isoAt(9),
          startedAt: isoAt(10),
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createUserMessage({
            id: "msg-user-plan-regression" as MessageId,
            text: "Implement the plan",
            offsetSeconds: 0,
          }),
          createAssistantMessage({
            id: "msg-assistant-plan-regression" as MessageId,
            text: "Starting implementation",
            offsetSeconds: 3,
          }),
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-plan-latest"),
            tone: "info",
            kind: "turn.plan.updated",
            summary: "Plan updated",
            payload: {
              explanation: "Active plan explanation",
              plan: [{ step: "Active implementation step", status: "inProgress" }],
            },
            turnId: latestTurnId,
            createdAt: isoAt(12),
          },
        ],
        proposedPlans: [
          {
            id: "plan-history-1" as OrchestrationProposedPlanId,
            turnId: historicalTurnId,
            planMarkdown: "# Historical plan card\n\nKeep this visible.",
            createdAt: isoAt(6),
            updatedAt: isoAt(6),
          },
        ],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: latestTurnId,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createPlanFollowUpRegressionSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: USER_MARKDOWN_TEXT,
  });
  const [thread] = snapshot.threads;
  if (!thread) {
    throw new Error("Expected an initial thread snapshot.");
  }

  const latestTurnId = "turn-plan-follow-up-latest" as TurnId;
  const assistantMessageId = thread.messages
    .toReversed()
    .find((message) => message.role === "assistant")?.id;

  if (!assistantMessageId) {
    throw new Error("Expected a latest assistant message for the plan follow-up fixture.");
  }

  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        title: "Plan follow-up regression thread",
        interactionMode: "plan",
        latestTurn: {
          turnId: latestTurnId,
          state: "completed",
          interactionMode: "plan",
          requestedAt: isoAt(120),
          startedAt: isoAt(121),
          completedAt: isoAt(122),
          assistantMessageId,
        },
        proposedPlans: [
          {
            id: "plan-follow-up-1" as OrchestrationProposedPlanId,
            turnId: latestTurnId,
            planMarkdown: [
              "# Restore chat shell containment",
              "",
              "1. Constrain the thread shell to the viewport.",
              "2. Keep the message viewport scrollable.",
              "3. Preserve the composer and branch controls in plan follow-up mode.",
            ].join("\n"),
            createdAt: isoAt(123),
            updatedAt: isoAt(123),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createCodexThreadContextProgressSnapshot(): OrchestrationReadModel {
  const latestTurnId = "turn-context-codex-plan" as TurnId;
  const snapshot = createChatViewSnapshot({
    messages: [
      createUserMessage({
        id: "msg-user-context-codex-plan" as MessageId,
        text: "Create a plan",
        offsetSeconds: 0,
      }),
      createAssistantMessage({
        id: "msg-assistant-context-codex-plan" as MessageId,
        text: "Plan ready",
        offsetSeconds: 7,
        turnId: latestTurnId,
      }),
    ],
  });
  const thread = snapshot.threads[0];
  if (!thread) {
    throw new Error("Expected Codex progress fixture thread.");
  }
  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        latestTurn: {
          turnId: latestTurnId,
          state: "completed",
          interactionMode: "plan",
          requestedAt: isoAt(1),
          startedAt: isoAt(2),
          completedAt: isoAt(8),
          assistantMessageId: "msg-assistant-context-codex-plan" as MessageId,
        },
        proposedPlans: [
          {
            id: "plan-context-codex-1" as OrchestrationProposedPlanId,
            turnId: latestTurnId,
            planMarkdown: [
              "# Test Plan",
              "",
              "## 4 Steps",
              "",
              "1. Confirm the progress header appears.",
              "   This wrapped line should not break the numbered list collection.",
              "2. Verify the Codex step labels are shown.",
              "3. Confirm later scenario bullets are ignored.",
              "4. Finish with a clean rail state.",
              "",
              "## Test Cases",
              "",
              "- This scenario bullet should stay out of the rail.",
            ].join("\n"),
            createdAt: isoAt(3),
            updatedAt: isoAt(6),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createOpenCodeThreadContextProgressSnapshot(): OrchestrationReadModel {
  const latestTurnId = "turn-context-opencode-tool" as TurnId;
  return {
    ...createChatViewSnapshot({
      messages: [
        createUserMessage({
          id: "msg-user-context-opencode-tool" as MessageId,
          text: "Use your todo tool",
          offsetSeconds: 0,
        }),
      ],
    }),
    threads: [
      {
        ...createChatViewSnapshot({ messages: [] }).threads[0]!,
        title: "OpenCode progress thread",
        model: "opencode/openai/gpt-4.1",
        latestTurn: {
          turnId: latestTurnId,
          state: "running",
          interactionMode: "default",
          requestedAt: isoAt(1),
          startedAt: isoAt(2),
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [
          createUserMessage({
            id: "msg-user-context-opencode-tool" as MessageId,
            text: "Use your todo tool",
            offsetSeconds: 0,
          }),
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-opencode-read-file"),
            tone: "info",
            kind: "tool.started",
            summary: "Read started",
            payload: {
              itemType: "file_change",
              status: "inProgress",
              data: { toolName: "Read" },
            },
            turnId: latestTurnId,
            createdAt: isoAt(3),
          },
          {
            id: EventId.makeUnsafe("activity-opencode-todo"),
            tone: "info",
            kind: "tool.updated",
            summary: "TodoWrite",
            payload: {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              data: { toolName: "TodoWrite" },
            },
            turnId: latestTurnId,
            createdAt: isoAt(4),
          },
        ],
        proposedPlans: [],
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: latestTurnId,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createStaleThreadContextProgressSnapshot(): OrchestrationReadModel {
  const oldTurnId = "turn-context-stale-old" as TurnId;
  const newTurnId = "turn-context-stale-new" as TurnId;
  return {
    ...createChatViewSnapshot({
      messages: [
        createUserMessage({
          id: "msg-user-context-stale-old" as MessageId,
          text: "Old prompt",
          offsetSeconds: 0,
        }),
        createAssistantMessage({
          id: "msg-assistant-context-stale-old" as MessageId,
          text: "Old answer",
          offsetSeconds: 4,
          turnId: oldTurnId,
        }),
        createUserMessage({
          id: "msg-user-context-stale-new" as MessageId,
          text: "New prompt",
          offsetSeconds: 10,
        }),
      ],
    }),
    threads: [
      {
        ...createChatViewSnapshot({ messages: [] }).threads[0]!,
        title: "Stale progress thread",
        latestTurn: {
          turnId: newTurnId,
          state: "running",
          interactionMode: "default",
          requestedAt: isoAt(11),
          startedAt: isoAt(12),
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [
          createUserMessage({
            id: "msg-user-context-stale-old" as MessageId,
            text: "Old prompt",
            offsetSeconds: 0,
          }),
          createAssistantMessage({
            id: "msg-assistant-context-stale-old" as MessageId,
            text: "Old answer",
            offsetSeconds: 4,
            turnId: oldTurnId,
          }),
          createUserMessage({
            id: "msg-user-context-stale-new" as MessageId,
            text: "New prompt",
            offsetSeconds: 10,
          }),
        ],
        activities: [],
        proposedPlans: [
          {
            id: "plan-context-stale-old" as OrchestrationProposedPlanId,
            turnId: oldTurnId,
            planMarkdown: "# Old plan\n\n1. Old progress should not remain.",
            createdAt: isoAt(2),
            updatedAt: isoAt(3),
          },
        ],
      },
    ],
  };
}

function createCheckpointRevertSnapshot(): OrchestrationReadModel {
  const firstTurnId = "turn-checkpoint-first" as TurnId;
  const secondTurnId = "turn-checkpoint-second" as TurnId;
  const firstUserId = "msg-user-revert-first" as MessageId;
  const secondUserId = "msg-user-revert-second" as MessageId;
  const firstAssistantId = "msg-assistant-revert-first" as MessageId;
  const secondAssistantId = "msg-assistant-revert-second" as MessageId;

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Checkpoint revert thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createUserMessage({
            id: firstUserId,
            text: "Make the first change",
            offsetSeconds: 0,
          }),
          createAssistantMessage({
            id: firstAssistantId,
            text: "Applied the first change",
            turnId: firstTurnId,
            offsetSeconds: 3,
          }),
          createUserMessage({
            id: secondUserId,
            text: "Now make a second change",
            offsetSeconds: 6,
          }),
          createAssistantMessage({
            id: secondAssistantId,
            text: "Applied the second change",
            turnId: secondTurnId,
            offsetSeconds: 9,
          }),
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [
          {
            turnId: firstTurnId,
            checkpointTurnCount: 2,
            checkpointRef: "checkpoint-first" as CheckpointRef,
            status: "ready",
            files: [
              {
                path: "apps/web/src/components/ChatView.tsx",
                kind: "modified",
                additions: 8,
                deletions: 2,
              },
            ],
            assistantMessageId: firstAssistantId,
            completedAt: isoAt(4),
          },
          {
            turnId: secondTurnId,
            checkpointTurnCount: 3,
            checkpointRef: "checkpoint-second" as CheckpointRef,
            status: "ready",
            files: [
              {
                path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                kind: "modified",
                additions: 4,
                deletions: 1,
              },
            ],
            assistantMessageId: secondAssistantId,
            completedAt: isoAt(10),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createSubagentTimelineSnapshot(): OrchestrationReadModel {
  const childThreadId = "subagent:thread-browser-test:child-provider-1" as ThreadId;
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    tasks: [],
    taskRuntimes: [],
    projectRules: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        title: "Parent thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createUserMessage({
            id: "msg-user-subagent-parent" as MessageId,
            text: "Delegate this search",
            offsetSeconds: 0,
          }),
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-subagent-tool"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Delegate to subagent",
            payload: {
              itemType: "collab_agent_tool_call",
              title: "Delegate to subagent",
              data: {
                receiverAgents: [
                  {
                    threadId: "child-provider-1",
                    agentId: "agent-1",
                    agentNickname: "Locke",
                    agentRole: "explorer",
                    model: "gpt-5.4-mini",
                    prompt: "Search the repository",
                  },
                ],
              },
            },
            turnId: null,
            createdAt: isoAt(3),
          },
        ],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
      {
        id: childThreadId,
        projectId: PROJECT_ID,
        origin: "user",
        taskId: null,
        parentThreadId: THREAD_ID,
        subagentAgentId: "agent-1",
        subagentNickname: "Locke",
        subagentRole: "explorer",
        title: "Locke [explorer]",
        model: "gpt-5.4-mini",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        isPinned: false,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createAssistantMessage({
            id: "msg-assistant-subagent-child" as MessageId,
            text: "Searching the repository structure.",
            offsetSeconds: 6,
          }),
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: childThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function resolveWsRpc(tag: string): unknown {
  const override = fixture.wsRpcResults?.[tag];
  if (override !== undefined) {
    return override;
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", async (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      let request: WsRequestEnvelope;
      try {
        request = JSON.parse(rawData) as WsRequestEnvelope;
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") return;
      wsRequests.push(request.body);
      const result = await Promise.resolve(resolveWsRpc(method));
      client.send(
        JSON.stringify({
          id: request.id,
          result,
        }),
      );
    });
  }),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForChatViewRoot(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>("[data-testid='chat-view-root']"),
    "Unable to find the ChatView root container.",
  );
}

async function waitForMessagesScrollContainer(): Promise<HTMLDivElement> {
  return waitForElement(
    () => document.querySelector<HTMLDivElement>("[data-testid='chat-messages-scroll-container']"),
    "Unable to find ChatView message scroll container.",
  );
}

function visibleSidebarToggleCount(label: "Collapse Sidebar" | "Expand Sidebar"): number {
  return [...document.querySelectorAll<HTMLElement>(`[aria-label='${label}']`)].filter(
    (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    },
  ).length;
}

async function collapseDesktopSidebar(): Promise<void> {
  await expect.poll(() => visibleSidebarToggleCount("Collapse Sidebar")).toBe(1);
  await page.getByRole("button", { name: "Collapse Sidebar" }).click();
  await expect.poll(() => visibleSidebarToggleCount("Expand Sidebar")).toBe(1);
  await waitForLayout();
}

function isElementFullyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
}

function desktopTitlebarBandMetrics(): {
  bandBottom: number;
  bandHeight: number;
} {
  const band = document.querySelector<HTMLElement>("[data-testid='desktop-titlebar-band']");
  expect(band).not.toBeNull();

  const bandRect = band!.getBoundingClientRect();

  return {
    bandBottom: Math.round(bandRect.bottom),
    bandHeight: Math.round(bandRect.height),
  };
}

function desktopTitlebarBandClearance(targetTestId: string): {
  bandBottom: number;
  targetTop: number;
} {
  const band = document.querySelector<HTMLElement>("[data-testid='desktop-titlebar-band']");
  const target = document.querySelector<HTMLElement>(`[data-testid='${targetTestId}']`);
  expect(band).not.toBeNull();
  expect(target).not.toBeNull();

  const bandRect = band!.getBoundingClientRect();
  const targetRect = target!.getBoundingClientRect();

  return {
    bandBottom: Math.round(bandRect.bottom),
    targetTop: Math.round(targetRect.top),
  };
}

function desktopCaptionButtonLaneMetrics(targetTestId: string): {
  laneWidth: number;
  targetRight: number;
} {
  const target = document.querySelector<HTMLElement>(`[data-testid='${targetTestId}']`);
  expect(target).not.toBeNull();

  const actionElements = Array.from(
    target!.querySelectorAll<HTMLElement>("button, [role='button'], a, input, textarea, select"),
  );
  const targetRight = actionElements.length
    ? Math.max(...actionElements.map((element) => element.getBoundingClientRect().right))
    : target!.getBoundingClientRect().right;
  const laneWidth = Number.parseFloat(
    window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--desktop-caption-button-lane-width"),
  );

  return {
    laneWidth: Number.isFinite(laneWidth) ? Math.round(laneWidth) : 0,
    targetRight: Math.round(targetRight),
  };
}

function chatHeaderTrailingInsetPx(): number {
  const chatSurface = document.querySelector<HTMLElement>("[data-testid='chat-view-root']");
  const trailingControl = document.querySelector<HTMLElement>(
    "button[aria-label='Toggle diff panel']",
  );
  if (!chatSurface || !trailingControl) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round(
    chatSurface.getBoundingClientRect().right - trailingControl.getBoundingClientRect().right,
  );
}

function computedBackgroundColorByTestId(testId: string): string {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  return window.getComputedStyle(element!).backgroundColor;
}

function selectorBackgroundColor(selector: string): string {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return window.getComputedStyle(element!).backgroundColor;
}

function sidebarSurfaceWidth(): number {
  const element = document.querySelector<HTMLElement>(
    "[data-testid='desktop-titlebar-band-sidebar-surface']",
  );
  expect(element).not.toBeNull();
  return Math.round(element!.getBoundingClientRect().width);
}

function elementHeightByTestId(testId: string): number {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  return Math.round(element!.getBoundingClientRect().height);
}

function elementWidthBySelector(selector: string): number {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return Math.round(element!.getBoundingClientRect().width);
}

async function waitForThreadContextPanelText(): Promise<string> {
  const panel = await waitForElement(
    () => document.querySelector<HTMLElement>("aside[aria-label='Branch details']"),
    "Unable to find the thread context panel.",
  );
  return panel.textContent ?? "";
}

const DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS: BrowserPaneBounds = {
  x: 980,
  y: 22,
  width: 480,
  height: 860,
};

function createDesktopBrowserSnapshot(
  projectId: ProjectId,
  paneBounds: BrowserPaneBounds = DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS,
): BrowserSessionSnapshot {
  const tab = {
    tabId: "tab-1",
    sessionId: "browser-session-chat-test",
    projectId,
    inspectMode: false,
    hasSelection: false,
    navigation: {
      url: "https://www.google.com/search",
      title: "Google",
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      lastCommittedAt: NOW_ISO,
    },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  } as const;
  return {
    paneOpen: true,
    paneProjectId: projectId,
    paneBounds,
    session: {
      sessionId: tab.sessionId,
      projectId: tab.projectId,
      inspectMode: tab.inspectMode,
      hasSelection: tab.hasSelection,
      navigation: tab.navigation,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
    },
    tabs: [tab],
    activeTabId: tab.tabId,
  };
}

function createDesktopBrowserBridge(
  projectId: ProjectId,
  overrides: Partial<DesktopBridge["browser"]> = {},
): DesktopBridge["browser"] {
  let paneBounds = { ...DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS };
  let tabs = [createDesktopBrowserSnapshot(projectId, paneBounds).tabs?.[0]].filter(
    Boolean,
  ) as NonNullable<BrowserSessionSnapshot["tabs"]>;
  let activeTabId = tabs[0]?.tabId ?? null;
  const buildSnapshot = (): BrowserSessionSnapshot => {
    const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0] ?? null;
    return {
      paneOpen: true,
      paneProjectId: projectId,
      paneBounds,
      session: activeTab
        ? {
            sessionId: activeTab.sessionId,
            projectId: activeTab.projectId,
            inspectMode: activeTab.inspectMode,
            hasSelection: activeTab.hasSelection,
            navigation: activeTab.navigation,
            createdAt: activeTab.createdAt,
            updatedAt: activeTab.updatedAt,
          }
        : null,
      tabs,
      activeTabId,
    };
  };

  return {
    getState: async () => buildSnapshot(),
    open: async (input) => {
      paneBounds = { ...input.bounds };
      return buildSnapshot();
    },
    closePane: async () => undefined,
    newTab: async () => {
      const tabId = `tab-${tabs.length + 1}`;
      const base = buildSnapshot().tabs?.[0];
      if (!base) {
        return buildSnapshot();
      }
      tabs = [
        ...tabs,
        {
          ...base,
          tabId,
          sessionId: `browser-session-chat-test-${tabId}`,
          navigation: {
            ...base.navigation,
            url: "about:blank",
            title: "",
            canGoBack: false,
            canGoForward: false,
          },
        },
      ];
      activeTabId = tabId;
      return buildSnapshot();
    },
    activateTab: async (input) => {
      activeTabId = input.tabId;
      return buildSnapshot();
    },
    closeTab: async (input) => {
      tabs = tabs.filter((tab) => tab.tabId !== input.tabId);
      if (tabs.length === 0) {
        const fallback = createDesktopBrowserSnapshot(projectId, paneBounds).tabs?.[0];
        if (fallback) {
          tabs = [fallback];
        }
      }
      if (!tabs.some((tab) => tab.tabId === activeTabId)) {
        activeTabId = tabs[0]?.tabId ?? null;
      }
      return buildSnapshot();
    },
    navigate: async (input) => {
      tabs = tabs.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              navigation: {
                ...tab.navigation,
                url: input.url,
              },
            }
          : tab,
      );
      return buildSnapshot();
    },
    back: async () => buildSnapshot(),
    forward: async () => buildSnapshot(),
    reload: async () => buildSnapshot(),
    kill: async () => undefined,
    getSettings: async () => ({
      approvalPolicy: "alwaysAsk",
      historyPolicy: "alwaysAsk",
      blockedDomains: [],
      allowedDomains: [],
    }),
    updateSettings: async (input) => ({
      approvalPolicy: input.approvalPolicy ?? "alwaysAsk",
      historyPolicy: input.historyPolicy ?? "alwaysAsk",
      blockedDomains: input.blockedDomains ?? [],
      allowedDomains: input.allowedDomains ?? [],
    }),
    clearBrowsingData: async () => undefined,
    setInspectMode: async (input) => {
      tabs = tabs.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              inspectMode: input.enabled,
            }
          : tab,
      );
      return buildSnapshot();
    },
    captureInspectSelection: async () => null,
    onEvent: () => () => {},
    ...overrides,
  };
}

function findFirstTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current.textContent?.trim().length) {
      return current as Text;
    }
    current = walker.nextNode();
  }
  return null;
}

async function selectTextInElement(element: Element): Promise<void> {
  const textNode = findFirstTextNode(element);
  if (!textNode || !textNode.textContent) {
    throw new Error("Unable to find selectable text node.");
  }

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent.length);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await waitForLayout();
}

async function clearSelectedText(): Promise<void> {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  await waitForLayout();
}

async function waitForSelectionActionButton(
  ariaLabel: "Quote selected text" | "Pin selected text",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`),
    `Unable to find selection action button: ${ariaLabel}.`,
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Chat" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLDivElement>("div.overflow-y-auto.overscroll-y-contain"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  const timelineRoot =
    row!.closest<HTMLElement>('[data-timeline-root="true"]') ??
    host.querySelector<HTMLElement>('[data-timeline-root="true"]');
  if (!(timelineRoot instanceof HTMLElement)) {
    throw new Error("Unable to locate timeline root container.");
  }

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  let renderedInVirtualizedRegion = false;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = timelineRoot.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow!.closest("[data-index]") instanceof HTMLElement;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntries?: string[];
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);
  applyDesktopWindowChromeMetrics(document.documentElement);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: options.initialEntries ?? [`/${THREAD_ID}`],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await expect.poll(() => useStore.getState().threadsHydrated).toBe(true);
  await waitForLayout();

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    navigate: async (path: string) => {
      await router.navigate({ to: path });
      await waitForLayout();
    },
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
  };
}

async function measureUserRowAtViewport(options: {
  snapshot: OrchestrationReadModel;
  targetMessageId: MessageId;
  viewport: ViewportSpec;
}): Promise<UserRowMeasurement> {
  const mounted = await mountChatView({
    viewport: options.viewport,
    snapshot: options.snapshot,
  });

  try {
    return await mounted.measureUserRow(options.targetMessageId);
  } finally {
    await mounted.cleanup();
  }
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(async () => {
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    window.desktopBridge = {
      getWsUrl: () => `ws://${window.location.host}`,
      getWindowChromeMetrics: () => ({
        platform: "win32",
        titlebarHeightPx: 22,
        leadingInsetPx: 0,
        trailingInsetPx: 138,
        captionButtonLaneWidthPx: 104,
      }),
      openExternal: async () => true,
      pickFolder: async () => null,
      confirm: async () => true,
    } as unknown as DesktopBridge;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useBrowserPaneStore.setState({
      width: 480,
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "desktopBridge");
    applyDesktopWindowChromeMetrics(document.documentElement);
    document.body.innerHTML = "";
  });

  it("renders the desktop thread shell with rounded corners and no shell dividers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-shell-check" as MessageId,
        targetText: "check shell chrome",
      }),
    });

    try {
      const sidebarInset = document.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
      const shell = document.querySelector<HTMLElement>("[data-testid='chat-view-root']");
      const sidebarContainer = document.querySelector<HTMLElement>(
        "[data-slot='sidebar-container']",
      );
      const header = document.querySelector<HTMLElement>("header");
      const headerTitle = document.querySelector<HTMLElement>("[data-testid='chat-header-title']");
      const headerActions = document.querySelector<HTMLElement>(
        "[data-testid='chat-header-actions']",
      );
      const diffToggle = document.querySelector<HTMLElement>(
        "button[aria-label='Toggle diff panel']",
      );

      expect(sidebarInset).not.toBeNull();
      expect(shell).not.toBeNull();
      expect(sidebarContainer).not.toBeNull();
      expect(header).not.toBeNull();
      expect(headerTitle).not.toBeNull();
      expect(headerActions).not.toBeNull();
      expect(diffToggle).not.toBeNull();
      expect(desktopTitlebarBandMetrics().bandHeight).toBe(22);
      expect(elementHeightByTestId("chat-top-header")).toBe(40);
      expect(elementHeightByTestId("sidebar-top-header")).toBeGreaterThanOrEqual(0);
      expect(computedBackgroundColorByTestId("desktop-titlebar-band-main-surface")).toBe(
        selectorBackgroundColor("[data-testid='chat-view-root']"),
      );
      expect(computedBackgroundColorByTestId("desktop-titlebar-band-sidebar-surface")).toBe(
        selectorBackgroundColor("[data-slot='sidebar-container']"),
      );

      expect(
        desktopTitlebarBandClearance("chat-header-title").targetTop -
          desktopTitlebarBandClearance("chat-header-title").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(
        desktopTitlebarBandClearance("chat-header-actions").targetTop -
          desktopTitlebarBandClearance("chat-header-actions").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      await collapseDesktopSidebar();

      const shellStyle = window.getComputedStyle(shell!);
      const sidebarInsetStyle = window.getComputedStyle(sidebarInset!);
      const shellRect = shell!.getBoundingClientRect();

      expect(Number.parseFloat(shellStyle.borderTopLeftRadius)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(shellStyle.borderTopRightRadius)).toBeGreaterThanOrEqual(0);
      expect(shellRect.height).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(sidebarInsetStyle.paddingLeft).toBe("0px");
      expect(sidebarSurfaceWidth()).toBe(52);
      expect(elementHeightByTestId("chat-top-header")).toBe(40);
      expect(elementHeightByTestId("sidebar-top-header")).toBeGreaterThanOrEqual(0);
      expect(computedBackgroundColorByTestId("desktop-titlebar-band-main-surface")).toBe(
        selectorBackgroundColor("[data-testid='chat-view-root']"),
      );
      expect(computedBackgroundColorByTestId("desktop-titlebar-band-sidebar-surface")).toBe(
        selectorBackgroundColor("[data-slot='sidebar-container']"),
      );
      expect(
        desktopTitlebarBandClearance("chat-header-title").targetTop -
          desktopTitlebarBandClearance("chat-header-title").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(
        desktopTitlebarBandClearance("chat-header-actions").targetTop -
          desktopTitlebarBandClearance("chat-header-actions").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(isElementFullyVisible(diffToggle!)).toBe(true);
      expect(window.getComputedStyle(sidebarContainer!).borderRightWidth).toBe("0px");
      expect(window.getComputedStyle(header!).borderBottomWidth).toBe("0px");
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("keeps the mobile header single-row with truncated title and compact actions", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-header-collision-check" as MessageId,
      targetText: "check medium narrow header actions",
    });
    const activeThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (activeThread) {
      Object.assign(activeThread, {
        title:
          "Use browser_show and browser_navigate to open https://example.com in the integrated browser pane",
      });
    }

    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "mobile-header-actions",
        width: 390,
        height: 700,
      },
      snapshot,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
        nextFixture.wsRpcResults = {
          ...nextFixture.wsRpcResults,
          [WS_METHODS.gitListBranches]: {
            isRepo: false,
            branches: [],
          },
        };
      },
    });

    try {
      const header = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-testid='chat-top-header']"),
        "Unable to find the chat header.",
      );
      const headerTitle = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-testid='chat-header-title']"),
        "Unable to find the chat title.",
      );
      const projectBadge = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-testid='chat-header-project-badge']"),
        "Unable to find the project badge.",
      );
      const addActionButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) =>
              button.title === "Add action" || button.getAttribute("aria-label") === "Add action",
          ) ?? null,
        "Unable to find the Add action button.",
      );
      const initializeGitButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.title === "Initialize Git",
          ) ?? null,
        "Unable to find the Initialize Git button.",
      );

      await waitForLayout();

      const headerOverflowPx = header.scrollWidth - header.clientWidth;
      const headerTitleIsTruncated = headerTitle.scrollWidth > headerTitle.clientWidth + 1;
      const badgeRect = projectBadge.getBoundingClientRect();
      const titleRect = headerTitle.getBoundingClientRect();
      const addActionRect = addActionButton.getBoundingClientRect();
      const initializeGitRect = initializeGitButton.getBoundingClientRect();
      const singleRowVerticalDeltaPx = Math.abs(titleRect.top - addActionRect.top);
      const badgeOverlapsAddAction =
        badgeRect.left < addActionRect.right &&
        addActionRect.left < badgeRect.right &&
        badgeRect.top < addActionRect.bottom &&
        addActionRect.top < badgeRect.bottom;
      const badgeOverlapsInitializeGit =
        badgeRect.left < initializeGitRect.right &&
        initializeGitRect.left < badgeRect.right &&
        badgeRect.top < initializeGitRect.bottom &&
        initializeGitRect.top < badgeRect.bottom;

      expect(headerOverflowPx).toBeLessThanOrEqual(1);
      expect(headerTitleIsTruncated).toBe(true);
      expect(singleRowVerticalDeltaPx).toBeLessThanOrEqual(8);
      expect(titleRect.right).toBeLessThanOrEqual(addActionRect.left + 1);
      expect(badgeOverlapsAddAction).toBe(false);
      expect(badgeOverlapsInitializeGit).toBe(false);
      expect(addActionRect.width).toBeLessThanOrEqual(40);
      expect(initializeGitRect.width).toBeLessThanOrEqual(40);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("keeps integrated browser and diff top chrome below the desktop titlebar band", async () => {
    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "desktop-wide",
        width: 1680,
        height: 960,
      },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-top-chrome-check" as MessageId,
        targetText: "check top chrome",
      }),
      initialEntries: [`/${THREAD_ID}?panel=browser`],
    });

    try {
      const diffToggle = await waitForElement(
        () => document.querySelector<HTMLElement>("button[aria-label='Toggle diff panel']"),
        "Unable to find the diff toggle.",
      );

      diffToggle.click();
      await waitForLayout();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='integrated-browser-header-actions']",
            ) ?? null,
        )
        .toBeNull();
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='diff-panel-header-actions']") ??
            null,
        )
        .not.toBeNull();
      expect(desktopTitlebarBandMetrics().bandHeight).toBe(22);
      expect(elementHeightByTestId("chat-top-header")).toBe(40);
      expect(elementHeightByTestId("diff-panel-top-header")).toBe(40);

      expect(
        desktopTitlebarBandClearance("chat-header-actions").targetTop -
          desktopTitlebarBandClearance("chat-header-actions").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(
        window.innerWidth - desktopCaptionButtonLaneMetrics("chat-header-actions").laneWidth,
      ).toBeGreaterThanOrEqual(desktopCaptionButtonLaneMetrics("chat-header-actions").targetRight);
      expect(
        desktopTitlebarBandClearance("diff-panel-header-actions").targetTop -
          desktopTitlebarBandClearance("diff-panel-header-actions").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(
        window.innerWidth - desktopCaptionButtonLaneMetrics("diff-panel-header-actions").laneWidth,
      ).toBeGreaterThanOrEqual(
        desktopCaptionButtonLaneMetrics("diff-panel-header-actions").targetRight,
      );
      expect(chatHeaderTrailingInsetPx()).toBeLessThanOrEqual(24);

      const browserToggle = await waitForElement(
        () => document.querySelector<HTMLElement>("button[aria-label='Toggle browser pane']"),
        "Unable to find the browser toggle.",
      );
      browserToggle.click();
      await waitForLayout();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='integrated-browser-header-actions']",
            ) ?? null,
        )
        .not.toBeNull();
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='diff-panel-header-actions']") ??
            null,
        )
        .toBeNull();
      expect(elementHeightByTestId("integrated-browser-top-header")).toBeGreaterThanOrEqual(40);
      expect(
        desktopTitlebarBandClearance("integrated-browser-header-actions").targetTop -
          desktopTitlebarBandClearance("integrated-browser-header-actions").bandBottom,
      ).toBeGreaterThanOrEqual(0);
      expect(
        window.innerWidth -
          desktopCaptionButtonLaneMetrics("integrated-browser-header-actions").laneWidth,
      ).toBeGreaterThanOrEqual(
        desktopCaptionButtonLaneMetrics("integrated-browser-header-actions").targetRight,
      );
      expect(chatHeaderTrailingInsetPx()).toBeLessThanOrEqual(24);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("closes the native pane off-thread and restores it when returning to chat", async () => {
    const closePane = vi.fn(async () => undefined);
    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID, { closePane }),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-route-scope" as MessageId,
        targetText: "route scope",
      }),
      initialEntries: [`/${THREAD_ID}?panel=browser`],
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
        )
        .not.toBeNull();

      await mounted.navigate("/orchestrate");

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
        )
        .toBeNull();
      await vi.waitFor(() => {
        expect(closePane).toHaveBeenCalled();
      });

      await mounted.navigate(`/${THREAD_ID}?panel=browser`);

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
        )
        .not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("keeps the browser panel open when switching to a same-project thread", async () => {
    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const secondThreadId = "thread-browser-test-secondary" as ThreadId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-browser-same-project-switch" as MessageId,
      targetText: "same project switch",
    });
    const baseThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (!baseThread) {
      throw new Error("Unable to build same-project browser switch snapshot.");
    }
    const snapshotWithSecondaryThread: OrchestrationReadModel = {
      ...snapshot,
      threads: [
        ...snapshot.threads,
        {
          ...baseThread,
          id: secondThreadId,
          title: "Browser secondary thread",
          ...(baseThread.session
            ? { session: { ...baseThread.session, threadId: secondThreadId } }
            : {}),
        },
      ],
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithSecondaryThread,
      initialEntries: [`/${THREAD_ID}?panel=browser`],
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
        )
        .not.toBeNull();

      await mounted.navigate(`/${secondThreadId}`);

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
        )
        .not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("keeps the browser toolbar usable at the widened minimum width", async () => {
    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "desktop-browser-min-width",
        width: 1440,
        height: 960,
      },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-toolbar-min-width" as MessageId,
        targetText: "toolbar width",
      }),
      initialEntries: [`/${THREAD_ID}?panel=browser`],
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='integrated-browser-top-header']") ??
            null,
        )
        .not.toBeNull();
      await expect.element(page.getByLabelText("Back")).toBeVisible();
      await expect.element(page.getByLabelText("Forward")).toBeVisible();
      await expect.element(page.getByLabelText("Reload")).toBeVisible();
      await expect.element(page.getByLabelText("Browser URL")).toBeVisible();
      await expect.element(page.getByLabelText("Inspect element")).toBeVisible();
      await expect.element(page.getByLabelText("Collapse browser")).toBeVisible();
      await expect
        .poll(() => elementHeightByTestId("integrated-browser-top-header"))
        .toBeGreaterThanOrEqual(40);
      await expect
        .poll(() => elementWidthBySelector("input[aria-label='Browser URL']"))
        .toBeGreaterThanOrEqual(150);
      await expect
        .poll(() => {
          const metrics = desktopCaptionButtonLaneMetrics("integrated-browser-header-actions");
          return window.innerWidth - metrics.targetRight;
        })
        .toBeLessThanOrEqual(16);
      await expect
        .poll(() => {
          const header = document.querySelector<HTMLElement>(
            "[data-testid='integrated-browser-top-header']",
          );
          expect(header).not.toBeNull();
          return header!.scrollWidth - header!.clientWidth;
        })
        .toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("resends the latest browser pane bounds after the pane widens during an in-flight open", async () => {
    let resolveFirstOpen: () => void = () => undefined;
    const firstOpenGate = new Promise<void>((resolve) => {
      resolveFirstOpen = () => resolve();
    });
    let paneBounds = { ...DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS };
    const openCalls: BrowserPaneBounds[] = [];
    let openCallCount = 0;

    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID, {
        open: async (input) => {
          openCallCount += 1;
          openCalls.push({ ...input.bounds });
          if (openCallCount === 1) {
            await firstOpenGate;
          }
          paneBounds = { ...input.bounds };
          return createDesktopBrowserSnapshot(PROJECT_ID, paneBounds);
        },
      }),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "desktop-browser-open-race",
        width: 1440,
        height: 960,
      },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-open-race" as MessageId,
        targetText: "browser open race",
      }),
      initialEntries: [`/${THREAD_ID}?panel=browser`],
    });

    try {
      await expect.poll(() => openCalls.length).toBeGreaterThanOrEqual(1);

      useBrowserPaneStore.setState({
        width: 620,
      });
      await waitForLayout();

      const pane = document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']");
      expect(pane).not.toBeNull();

      resolveFirstOpen();

      await expect.poll(() => openCalls.length).toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => {
          return Math.abs(
            (openCalls.at(-1)?.width ?? 0) - Math.round(pane!.getBoundingClientRect().width),
          );
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() => {
          return Math.abs(
            (openCalls.at(-1)?.x ?? -1) - Math.round(pane!.getBoundingClientRect().left),
          );
        })
        .toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the thread message viewport scrollable", async () => {
    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "desktop-short",
        height: 700,
      },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scroll-check" as MessageId,
        targetText: "scroll check",
      }),
    });

    try {
      const chatViewRoot = await waitForChatViewRoot();
      const header = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-testid='chat-view-root'] > header"),
        "Unable to find the ChatView header.",
      );
      const scrollContainer = await waitForMessagesScrollContainer();

      await expect
        .poll(() => scrollContainer.scrollHeight > scrollContainer.clientHeight)
        .toBe(true);

      scrollContainer.scrollTop = 240;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      await expect.poll(() => scrollContainer.scrollTop).toBeGreaterThan(0);
      expect(window.getComputedStyle(chatViewRoot).overflowY).toBe("hidden");
      expect(chatViewRoot.scrollHeight).toBeLessThanOrEqual(chatViewRoot.clientHeight + 1);
      expect(isElementFullyVisible(header)).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(TEXT_VIEWPORT_MATRIX)(
    "keeps long user message estimate close at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: Array<
        UserRowMeasurement & { viewport: ViewportSpec; estimatedHeightPx: number }
      > = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: measurement.timelineWidthMeasuredPx },
        );

        expect(measurement.renderedInVirtualizedRegion).toBe(true);
        expect(Math.abs(measurement.measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
        measurements.push({ ...measurement, viewport, estimatedHeightPx });
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      expect(narrowest.measuredRowHeightPx).toBeGreaterThan(widest.measuredRowHeightPx);
      expect(narrowest.estimatedHeightPx).toBeGreaterThan(widest.estimatedHeightPx);
    } finally {
      await mounted.cleanup();
    }
  });

  it("tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports", async () => {
    const userText = "x".repeat(2_400);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktopMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot,
      targetMessageId,
    });
    const mobileMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[2],
      snapshot,
      targetMessageId,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktopMeasurement.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobileMeasurement.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx =
      mobileMeasurement.measuredRowHeightPx - desktopMeasurement.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "keeps user attachment estimate close at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          {
            role: "user",
            text: userText,
            attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
          },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.attachmentTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.skip("renders user-authored markdown and keeps actions in a detached footer row", async () => {
    const targetMessageId = "msg-user-markdown-render" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: USER_MARKDOWN_TEXT,
      }),
    });

    try {
      const row = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
          ),
        "Unable to find targeted markdown user row.",
      );
      const bubble = await waitForElement(
        () => row.querySelector<HTMLElement>('[data-user-message-bubble="true"]'),
        "Unable to find user message bubble.",
      );
      const footer = await waitForElement(
        () => row.querySelector<HTMLElement>('[data-user-message-footer="true"]'),
        "Unable to find user message footer.",
      );

      expect(bubble.querySelector("h1")?.textContent).toContain("User heading");
      expect(bubble.querySelectorAll("li")).toHaveLength(2);
      expect(bubble.querySelector("blockquote")?.textContent).toContain("quoted note");
      expect(bubble.querySelector("p code")?.textContent).toBe("code");
      expect(bubble.querySelector("pre code")?.textContent).toContain("const value = 1;");

      const copyButton = row.querySelector<HTMLButtonElement>('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
      expect(footer.contains(copyButton)).toBe(true);
      expect(bubble.contains(copyButton)).toBe(false);
      expect(footer.previousElementSibling).toBe(bubble);
      expect(footer.querySelector("p")?.textContent?.trim().length).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders assistant markdown and keeps copy actions in a detached footer row", async () => {
    const assistantMessageId = "msg-assistant-copy-render" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createChatViewSnapshot({
        messages: [
          {
            id: "msg-user-assistant-copy-render" as MessageId,
            role: "user",
            text: "hello",
            turnId: null,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            streaming: false,
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "## Assistant heading\n\nSome assistant text.",
            turnId: "turn-assistant-copy-render" as TurnId,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            streaming: false,
          },
        ],
      }),
    });

    try {
      const row = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${assistantMessageId}"][data-message-role="assistant"]`,
          ),
        "Unable to find targeted assistant row.",
      );
      const markdownBody = await waitForElement(
        () => row.querySelector<HTMLElement>('[data-chat-selection-region="assistant-output"]'),
        "Unable to find assistant markdown body.",
      );
      const footer = await waitForElement(
        () => row.querySelector<HTMLElement>('[data-assistant-message-footer="true"]'),
        "Unable to find assistant message footer.",
      );

      expect(markdownBody.querySelector("h2")?.textContent).toContain("Assistant heading");
      const copyButton = row.querySelector<HTMLButtonElement>('button[title="Copy message"]');
      expect(copyButton).toBeTruthy();
      expect(footer.contains(copyButton)).toBe(true);
      expect(markdownBody.contains(copyButton)).toBe(false);
      expect(footer.querySelector("p")?.textContent?.trim().length).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches checkpoint revert for the targeted user message undo control", async () => {
    const targetMessageId = "msg-user-revert-first" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createCheckpointRevertSnapshot(),
    });

    try {
      const row = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
          ),
        "Unable to find the checkpoint revert target row.",
      );
      const revertButton = await waitForElement(
        () => row.querySelector<HTMLButtonElement>('button[title="Revert to this message"]'),
        "Unable to find the checkpoint revert button.",
      );

      revertButton.click();

      await vi.waitFor(
        () => {
          const revertRequest = wsRequests.findLast((request) => {
            const command = (request as { command?: { type?: string } }).command;
            return (
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              command?.type === "thread.checkpoint.revert"
            );
          }) as
            | {
                command?: {
                  type?: string;
                  turnCount?: number;
                  threadId?: ThreadId;
                };
              }
            | undefined;
          expect(revertRequest?.command).toMatchObject({
            type: "thread.checkpoint.revert",
            threadId: THREAD_ID,
            turnCount: 1,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps markdown-heavy user rows measurable in the virtualized region", async () => {
    const targetMessageId = "msg-user-target-markdown-heavy" as MessageId;
    const userText = `${USER_MARKDOWN_TEXT}\n\n${"x".repeat(2_000)}`;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const { measuredRowHeightPx, renderedInVirtualizedRegion } =
        await mounted.measureUserRow(targetMessageId);

      expect(renderedInVirtualizedRegion).toBe(true);
      expect(measuredRowHeightPx).toBeGreaterThan(0);

      const heading = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"] [data-user-message-bubble="true"] h1`,
          ),
        "Unable to find markdown heading in the heavy user row.",
      );
      expect(heading.textContent).toContain("User heading");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the quote selection action for assistant markdown and inserts the quoted text into the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSelectionFeatureSnapshot(),
    });

    try {
      const assistantParagraph = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-message-role="assistant"] [data-chat-selection-region="assistant-output"] p',
          ),
        "Unable to find assistant markdown paragraph.",
      );

      await selectTextInElement(assistantParagraph);

      const quoteButton = await waitForSelectionActionButton("Quote selected text");
      quoteButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      quoteButton.click();

      await vi.waitFor(
        () => {
          const prompt = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "";
          expect(prompt).toBe(
            "> A daemon is a background process that runs without direct user interaction.\n\n",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      const composerEditor = await waitForComposerEditor();
      expect(document.activeElement).toBe(composerEditor);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("does not show the selection action for user-authored messages", async () => {
    const targetMessageId = "msg-user-markdown-selection" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: USER_MARKDOWN_TEXT,
      }),
    });

    try {
      const userMessage = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"] [data-user-message-bubble="true"] h1`,
          ),
        "Unable to find user message text.",
      );

      await selectTextInElement(userMessage);
      await waitForLayout();

      expect(document.querySelector('button[aria-label="Quote selected text"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Pin selected text"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows both selection actions for proposed plan markdown", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSelectionFeatureSnapshot(),
    });

    try {
      const planHeading = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-timeline-row-kind="proposed-plan"] [data-chat-selection-region="assistant-output"] h1',
          ),
        "Unable to find proposed plan heading.",
      );

      await selectTextInElement(planHeading);
      await waitForSelectionActionButton("Quote selected text");
      await waitForSelectionActionButton("Pin selected text");
      await clearSelectedText();

      await vi.waitFor(
        () => {
          expect(document.querySelector('button[aria-label="Quote selected text"]')).toBeNull();
          expect(document.querySelector('button[aria-label="Pin selected text"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("pins multiple passages, keeps them after send, and sends only the typed prompt", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSelectionFeatureSnapshot(),
    });

    try {
      const assistantParagraph = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-message-role="assistant"] [data-chat-selection-region="assistant-output"] p',
          ),
        "Unable to find assistant markdown paragraph.",
      );
      await selectTextInElement(assistantParagraph);
      const pinButton = await waitForSelectionActionButton("Pin selected text");
      pinButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      pinButton.click();

      const planHeading = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-timeline-row-kind="proposed-plan"] [data-chat-selection-region="assistant-output"] h1',
          ),
        "Unable to find proposed plan heading.",
      );
      await selectTextInElement(planHeading);
      const secondPinButton = await waitForSelectionActionButton("Pin selected text");
      secondPinButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      secondPinButton.click();

      await vi.waitFor(
        () => {
          expect(
            Array.from(document.querySelectorAll("button")).some((button) =>
              button.textContent?.includes("A daemon is a background process"),
            ),
          ).toBe(true);
          expect(
            Array.from(document.querySelectorAll("button")).some((button) =>
              button.textContent?.includes("Plan heading"),
            ),
          ).toBe(true);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.pinnedSelections,
          ).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Can you clarify these points?");
      await waitForLayout();

      const sendButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "Unable to find send button.",
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.findLast(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as { command?: { type?: string; message?: { text?: string } } } | undefined;
          expect(turnStartRequest?.command?.type).toBe("thread.turn.start");
          expect(turnStartRequest?.command?.message?.text).toBe("Can you clarify these points?");
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.pinnedSelections ?? [],
      ).toHaveLength(2);
      expect(
        Array.from(document.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("A daemon is a background process"),
        ),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("opens the project cwd for draft threads without a worktree path", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the minimal new-thread landing for local drafts without started thread state", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='chat-new-thread-landing']") ?? null,
        )
        .not.toBeNull();
      await expect
        .element(page.getByTestId("chat-new-thread-project-picker-trigger"))
        .toBeVisible();
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='chat-new-thread-landing'] h3")
              ?.textContent ?? null,
        )
        .toBe("Let's build");
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='chat-new-thread-project-picker-trigger']",
            )?.textContent ?? "",
        )
        .toContain("Project");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders server-owned new-thread suggestions on the landing surface", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.wsRpcResults = {
          ...nextFixture.wsRpcResults,
          [WS_METHODS.serverSuggestNewThreadTasks]: {
            suggestions: [
              { id: "review-1", prompt: "Fix the failing auth cleanup path" },
              { id: "review-2", prompt: "Add a safe stale-session recovery path" },
            ],
          },
        };
      },
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='chat-new-thread-suggestions']") ??
            null,
        )
        .not.toBeNull();
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='chat-new-thread-suggestion-review-1']",
            )?.textContent ?? "",
        )
        .toContain("Fix the failing auth cleanup path");
      await expect
        .poll(
          () =>
            wsRequests.find((request) => request._tag === WS_METHODS.serverSuggestNewThreadTasks) as
              | Record<string, unknown>
              | undefined,
        )
        .toMatchObject({
          _tag: WS_METHODS.serverSuggestNewThreadTasks,
          provider: "codex",
          cwd: "/repo/project",
          projectName: "Project",
        });
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("shows a loading state for dirty codex projects before review-backed suggestions resolve", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const pendingSuggestions: {
      resolve?: (value: { suggestions: Array<{ id: string; prompt: string }> }) => void;
    } = {};
    const suggestionsPromise = new Promise<{ suggestions: Array<{ id: string; prompt: string }> }>(
      (resolve) => {
        pendingSuggestions.resolve = resolve;
      },
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.wsRpcResults = {
          ...nextFixture.wsRpcResults,
          [WS_METHODS.gitStatus]: {
            branch: "main",
            hasWorkingTreeChanges: true,
            workingTree: {
              files: [{ path: "src/auth.ts", insertions: 2, deletions: 1 }],
              insertions: 2,
              deletions: 1,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          },
          [WS_METHODS.serverSuggestNewThreadTasks]: suggestionsPromise,
        };
      },
    });

    try {
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='chat-new-thread-suggestions-loading']",
            )?.textContent ?? "",
        )
        .toContain("Reviewing current changes");

      pendingSuggestions.resolve?.({
        suggestions: [{ id: "review-1", prompt: "Fix the failing auth cleanup path" }],
      });

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>(
              "[data-testid='chat-new-thread-suggestion-review-1']",
            )?.textContent ?? "",
        )
        .toContain("Fix the failing auth cleanup path");
    } finally {
      await mounted.cleanup();
    }
  });

  it("reuses existing project drafts from the new-thread picker and creates one when missing", async () => {
    const projectBeta = "project-2" as ProjectId;
    const projectGamma = "project-3" as ProjectId;
    const betaDraftThreadId = "thread-project-2-draft" as ThreadId;
    const baseSnapshot = createDraftOnlySnapshot();
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      projects: [
        ...baseSnapshot.projects,
        {
          id: projectBeta,
          title: "Beta",
          workspaceRoot: "/repo/beta",
          defaultModel: "gpt-5",
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
        {
          id: projectGamma,
          title: "Gamma",
          workspaceRoot: "/repo/gamma",
          defaultModel: "gpt-5",
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
    };

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
        [betaDraftThreadId]: {
          projectId: projectBeta,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
        [projectBeta]: betaDraftThreadId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await expect
        .poll(
          () =>
            document
              .querySelector<HTMLElement>("[data-testid='chat-new-thread-landing']")
              ?.getAttribute("data-thread-id") ?? null,
        )
        .toBe(THREAD_ID);

      await page.getByTestId("chat-new-thread-project-picker-trigger").click();
      await page.getByTestId(`chat-new-thread-project-option-${projectBeta}`).click();

      await expect
        .poll(
          () =>
            document
              .querySelector<HTMLElement>("[data-testid='chat-new-thread-landing']")
              ?.getAttribute("data-thread-id") ?? null,
        )
        .toBe(betaDraftThreadId);

      await page.getByTestId("chat-new-thread-project-picker-trigger").click();
      await page.getByTestId(`chat-new-thread-project-option-${projectGamma}`).click();

      await expect
        .poll(
          () =>
            useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectGamma] ?? null,
        )
        .not.toBeNull();

      const gammaDraftThreadId =
        useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectGamma] ?? null;
      expect(gammaDraftThreadId).toBeTruthy();

      await expect
        .poll(
          () =>
            document
              .querySelector<HTMLElement>("[data-testid='chat-new-thread-landing']")
              ?.getAttribute("data-thread-id") ?? null,
        )
        .toBe(gammaDraftThreadId);
      expect(gammaDraftThreadId).not.toBe(THREAD_ID);
      expect(gammaDraftThreadId).not.toBe(betaDraftThreadId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers add project in the new-thread picker and switches to that project's draft thread", async () => {
    const projectBeta = "project-2" as ProjectId;
    const betaDraftThreadId = "thread-project-2-draft" as ThreadId;
    const betaCwd = "/repo/beta";
    const baseSnapshot = createDraftOnlySnapshot();
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      projects: [
        ...baseSnapshot.projects,
        {
          id: projectBeta,
          title: "Beta",
          workspaceRoot: betaCwd,
          defaultModel: "gpt-5",
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
    };

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
        [betaDraftThreadId]: {
          projectId: projectBeta,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
        [projectBeta]: betaDraftThreadId,
      },
    });

    const pickFolderSpy = vi.fn(async () => betaCwd);
    window.desktopBridge = {
      ...(window.desktopBridge as DesktopBridge),
      pickFolder: pickFolderSpy,
    } as DesktopBridge;

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await page.getByTestId("chat-new-thread-project-picker-trigger").click();
      await expect.element(page.getByTestId("chat-new-thread-project-option-add")).toBeVisible();
      await page.getByTestId("chat-new-thread-project-option-add").click();

      await expect.poll(() => pickFolderSpy.mock.calls.length).toBe(1);
      await expect
        .poll(
          () =>
            document
              .querySelector<HTMLElement>("[data-testid='chat-new-thread-landing']")
              ?.getAttribute("data-thread-id") ?? null,
        )
        .toBe(betaDraftThreadId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not render the active plan panel for a default-mode latest turn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createActivePlanRegressionSnapshot({
        latestTurnInteractionMode: "default",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("h1")).find((heading) =>
            heading.textContent?.includes("Historical plan card"),
          ) as HTMLElement | null,
        "Unable to find historical proposed plan card.",
      );

      await vi.waitFor(
        () => {
          const bodyClone = document.body.cloneNode(true) as HTMLElement;
          bodyClone.querySelector("aside[aria-label='Branch details']")?.remove();
          const nonRailText = bodyClone.textContent ?? "";
          expect(nonRailText).toContain("Historical plan card");
          expect(nonRailText).not.toContain("Active plan explanation");
          expect(nonRailText).not.toContain("Active implementation step");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active plan panel for a plan-mode latest turn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createActivePlanRegressionSnapshot({
        latestTurnInteractionMode: "plan",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Active plan explanation");
          expect(document.body.textContent).toContain("Active implementation step");
          expect(document.body.textContent).toContain("Historical plan card");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows Codex proposed plan steps in the thread context rail", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createCodexThreadContextProgressSnapshot(),
    });

    try {
      await vi.waitFor(
        async () => {
          const panelText = await waitForThreadContextPanelText();
          expect(panelText).toContain("Progress");
          expect(panelText).toContain("Confirm the progress header appears.");
          expect(panelText).toContain("Verify the Codex step labels are shown.");
          expect(panelText).toContain("Confirm later scenario bullets are ignored.");
          expect(panelText).toContain("Finish with a clean rail state.");
          expect(panelText).not.toContain("This scenario bullet should stay out of the rail.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows OpenCode task-like tool lifecycle progress without generic tool noise", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createOpenCodeThreadContextProgressSnapshot(),
    });

    try {
      await vi.waitFor(
        async () => {
          const panelText = await waitForThreadContextPanelText();
          expect(panelText).toContain("Progress");
          expect(panelText).toContain("TodoWrite");
          expect(panelText).not.toContain("Read started");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not carry old progress across a newer user message", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createStaleThreadContextProgressSnapshot(),
    });

    try {
      await vi.waitFor(
        async () => {
          const panelText = await waitForThreadContextPanelText();
          expect(panelText).toContain("Branch details");
          expect(panelText).not.toContain("Progress");
          expect(panelText).not.toContain("Old progress should not remain.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Chat");
      expect(initialModeButton.title).toContain("enter plan mode");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Chat")).title).toContain("enter plan mode");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "return to normal chat mode",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Chat")).title).toContain("enter plan mode");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("keeps header actions and branch controls visible in constrained plan mode", async () => {
    const mounted = await mountChatView({
      viewport: {
        ...DEFAULT_VIEWPORT,
        name: "desktop-constrained-plan",
        height: 700,
      },
      snapshot: createPlanFollowUpRegressionSnapshot(),
    });

    try {
      const terminalButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>("button[aria-label='Toggle terminal drawer']"),
        "Unable to find the thread header terminal button.",
      );
      const diffToggle = await waitForElement(
        () => document.querySelector<HTMLElement>("button[aria-label='Toggle diff panel']"),
        "Unable to find the thread header diff toggle.",
      );
      const composerEditor = await waitForComposerEditor();
      const implementButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Implement",
          ) as HTMLButtonElement | null,
        "Unable to find the composer implement button.",
      );
      const envModeControl = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>("button, span")).find((element) => {
            const text = element.textContent?.trim();
            return text === "Local" || text === "Worktree" || text === "New worktree";
          }) ?? null,
        "Unable to find the branch environment control.",
      );
      const branchSelector = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("main"),
          ) as HTMLButtonElement | null,
        "Unable to find the branch selector.",
      );
      const scrollContainer = await waitForMessagesScrollContainer();

      expect(isElementFullyVisible(terminalButton)).toBe(true);
      expect(isElementFullyVisible(diffToggle)).toBe(true);
      expect(isElementFullyVisible(composerEditor)).toBe(true);
      expect(isElementFullyVisible(implementButton)).toBe(true);
      expect(isElementFullyVisible(envModeControl)).toBe(true);
      expect(isElementFullyVisible(branchSelector)).toBe(true);
      await expect
        .poll(() => scrollContainer.scrollHeight > scrollContainer.clientHeight)
        .toBe(true);

      scrollContainer.scrollTop = 280;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await expect.poll(() => scrollContainer.scrollTop).toBeGreaterThan(0);
      expect(isElementFullyVisible(terminalButton)).toBe(true);
      expect(isElementFullyVisible(implementButton)).toBe(true);
      expect(isElementFullyVisible(branchSelector)).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("opens a resolved subagent child thread from the timeline work card", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSubagentTimelineSnapshot(),
    });

    try {
      const openThreadButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open thread",
          ) as HTMLButtonElement | null,
        "Unable to find the subagent open thread button.",
      );

      openThreadButton.click();
      await waitForLayout();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-testid='chat-header-title']")?.textContent ??
            "",
        )
        .toContain("Locke [explorer]");
    } finally {
      await mounted.cleanup();
    }
  });
});
