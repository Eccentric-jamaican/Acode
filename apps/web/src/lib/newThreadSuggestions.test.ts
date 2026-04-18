import { describe, expect, it } from "vitest";

import {
  applyRefinedNewThreadSuggestions,
  buildNewThreadSuggestions,
  collectNewThreadSuggestionCandidates,
} from "./newThreadSuggestions";
import type { ErrorInboxEntry, Project, Task, TaskRuntime, Thread } from "../types";

const NOW = "2026-04-17T12:00:00.000Z";

function makeProject(): Project {
  return {
    id: "project-1" as Project["id"],
    name: "Acme",
    cwd: "/repo/acme",
    model: "gpt-5.4",
    expanded: true,
    scripts: [
      {
        id: "lint",
        name: "lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ],
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1" as Task["id"],
    projectId: "project-1" as Task["projectId"],
    title: "Fix flaky auth flow",
    brief: "Stabilize login behavior",
    acceptanceCriteria: "Login succeeds reliably",
    attachments: [],
    state: "ready",
    priority: 1,
    threadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<TaskRuntime> = {}): TaskRuntime {
  return {
    taskId: "task-1" as TaskRuntime["taskId"],
    status: "error",
    activeTurnId: null,
    lastError: "Command failed",
    lastActivityAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as Thread["id"],
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    origin: "user",
    taskId: null,
    title: "Investigate auth cleanup",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    isPinned: false,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeErrorInboxEntry(overrides: Partial<ErrorInboxEntry> = {}): ErrorInboxEntry {
  return {
    id: "error-1",
    fingerprint: "fingerprint-1",
    source: "browser-runtime",
    category: "browser",
    severity: "error",
    projectId: "project-1" as ErrorInboxEntry["projectId"],
    threadId: null,
    turnId: null,
    provider: null,
    summary: "Build is failing in CI",
    detail: "Vitest timed out",
    latestContextJson: {},
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    occurrenceCount: 1,
    linkedTaskId: null,
    resolution: null,
    ...overrides,
  };
}

describe("collectNewThreadSuggestionCandidates", () => {
  it("prioritizes blocked and failed task work", () => {
    const suggestions = collectNewThreadSuggestionCandidates({
      project: makeProject(),
      tasks: [
        makeTask({ id: "task-error" as Task["id"], title: "Fix auth", state: "running" }),
        makeTask({ id: "task-blocked" as Task["id"], title: "Ship billing", state: "blocked" }),
      ],
      taskRuntimes: [
        makeRuntime({ taskId: "task-error" as TaskRuntime["taskId"], status: "error" }),
        makeRuntime({ taskId: "task-blocked" as TaskRuntime["taskId"], status: "idle" }),
      ],
      threads: [],
      errorInbox: [],
    });

    expect(suggestions.slice(0, 2).map((suggestion) => suggestion.source)).toEqual([
      "task-error",
      "task-blocked",
    ]);
  });
});

describe("buildNewThreadSuggestions", () => {
  it("falls back to deterministic heuristics when no model refinement exists", () => {
    const suggestions = buildNewThreadSuggestions({
      project: makeProject(),
      tasks: [makeTask()],
      taskRuntimes: [makeRuntime({ status: "error" })],
      threads: [makeThread()],
      errorInbox: [makeErrorInboxEntry()],
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]?.prompt).toContain("Fix");
  });
});

describe("applyRefinedNewThreadSuggestions", () => {
  it("preserves deterministic fallback ordering when refinement is invalid", () => {
    const baseSuggestions = buildNewThreadSuggestions({
      project: makeProject(),
      tasks: [makeTask()],
      taskRuntimes: [makeRuntime({ status: "error" })],
      threads: [makeThread()],
      errorInbox: [makeErrorInboxEntry()],
    });

    const merged = applyRefinedNewThreadSuggestions({
      baseSuggestions,
      refinedSuggestions: [{ id: "unknown", prompt: "Do something else" }],
    });

    expect(merged).toEqual(baseSuggestions);
  });
});
