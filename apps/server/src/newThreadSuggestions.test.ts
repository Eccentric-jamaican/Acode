import { describe, expect, it, vi } from "vitest";

import type {
  ErrorInboxEntry,
  GitStatusResult,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationTask,
  OrchestrationTaskRuntime,
  OrchestrationThread,
  ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import {
  collectServerNewThreadCandidatesForProject,
  resolveSuggestionRefinementModel,
  suggestNewThreadTasks,
} from "./newThreadSuggestions";

const NOW = "2026-04-17T12:00:00.000Z";

function makeProject(overrides: Partial<OrchestrationProject> = {}): OrchestrationProject {
  return {
    id: "project-1" as OrchestrationProject["id"],
    title: "Acme",
    workspaceRoot: "/repo/acme",
    defaultModel: "gpt-5.4",
    scripts: [
      {
        id: "lint",
        name: "lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id: "task-1" as OrchestrationTask["id"],
    projectId: "project-1" as OrchestrationTask["projectId"],
    title: "Fix flaky auth flow",
    brief: "Stabilize login behavior",
    acceptanceCriteria: "Login succeeds reliably",
    attachments: [],
    state: "ready",
    priority: 1,
    threadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<OrchestrationTaskRuntime> = {}): OrchestrationTaskRuntime {
  return {
    taskId: "task-1" as OrchestrationTaskRuntime["taskId"],
    status: "error",
    activeTurnId: null,
    lastError: "Command failed",
    lastActivityAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-1" as OrchestrationThread["id"],
    projectId: "project-1" as OrchestrationThread["projectId"],
    origin: "user",
    taskId: null,
    title: "Investigate auth cleanup",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    isPinned: false,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
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

function makeSnapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [makeProject()],
    tasks: [makeTask()],
    taskRuntimes: [makeRuntime()],
    projectRules: [],
    threads: [makeThread()],
    updatedAt: NOW,
    ...overrides,
  };
}

function makeGitStatus(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
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
    ...overrides,
  };
}

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: "codex",
    status: "ready",
    runtimeMode: "full-access",
    cwd: "/repo/acme",
    model: "gpt-5.4",
    threadId: "thread-active" as ThreadId,
    resumeCursor: { threadId: "thr_active" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCodexRuntime() {
  return {
    listSessions: vi.fn<
      () => Promise<ReadonlyArray<{ readonly cwd?: string | undefined; readonly resumeCursor?: unknown }>>
    >(
      async () => [],
    ),
    listStoredThreads: vi.fn<
      (input: { readonly cwd: string; readonly limit?: number }) => Promise<
        ReadonlyArray<{
          readonly id: string;
          readonly preview: string | null;
          readonly createdAt: number | null;
          readonly updatedAt: number | null;
          readonly status: string | null;
        }>
      >
    >(async () => []),
    listStoredSkills: vi.fn<
      (input: { readonly cwd: string; readonly forceReload?: boolean }) => Promise<
        ReadonlyArray<{
          readonly name: string;
          readonly description: string | null;
          readonly displayName: string | null;
          readonly shortDescription: string | null;
        }>
      >
    >(async () => []),
    readStoredThread: vi.fn(async () => ({
      threadId: "thr_review",
      turns: [
        {
          id: "turn-review",
          items: [
            {
              type: "exitedReviewMode",
              id: "turn-review",
              review:
                "Looks solid overall.\n\n- Fix the failing auth cleanup path\n- Add a safe stale-session recovery path",
            },
          ],
        },
      ],
    })),
    archiveStoredThread: vi.fn(async () => undefined),
    startReview: vi.fn(async () => ({
      reviewThreadId: "thr_review",
      turnId: "turn-review",
    })),
    startSession: vi.fn(async () => ({
      resumeCursor: { threadId: "thr_helper" },
    })),
    stopSession: vi.fn(async () => undefined),
  };
}

describe("resolveSuggestionRefinementModel", () => {
  it("keeps claude selections on the claude provider", () => {
    expect(resolveSuggestionRefinementModel("claude-sonnet-4-6")).toEqual({
      provider: "claudeAgent",
      selectedModel: "claude-sonnet-4-6",
    });
  });

  it("maps codex gpt selections to the matching openai opencode model", () => {
    expect(resolveSuggestionRefinementModel("gpt-5.4")).toEqual({
      provider: "opencode",
      selectedModel: "openai/gpt-5.4",
    });
  });
});

describe("collectServerNewThreadCandidatesForProject", () => {
  it("returns deterministic project-scoped candidates", () => {
    const candidates = collectServerNewThreadCandidatesForProject({
      snapshot: makeSnapshot(),
      project: makeProject(),
      errorInboxEntries: [makeErrorInboxEntry()],
    });

    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates[0]?.prompt).toContain("Fix");
  });
});

describe("suggestNewThreadTasks", () => {
  it("returns baseline heuristic suggestions for non-codex providers", async () => {
    const codexRuntime = makeCodexRuntime();

    const result = await suggestNewThreadTasks({
      request: {
        provider: "opencode",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot(),
      errorInboxEntries: [makeErrorInboxEntry()],
      gitStatus: makeGitStatus(),
      codexAdapter: codexRuntime,
    });

    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.prompt).toContain("Fix");
    expect(codexRuntime.startReview).not.toHaveBeenCalled();
  });

  it("keeps a diff-focused suggestion when non-codex projects are dirty", async () => {
    const codexRuntime = makeCodexRuntime();

    const result = await suggestNewThreadTasks({
      request: {
        provider: "opencode",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot(),
      errorInboxEntries: [makeErrorInboxEntry()],
      gitStatus: makeGitStatus({
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/auth.ts", insertions: 3, deletions: 1 }],
          insertions: 3,
          deletions: 1,
        },
      }),
      codexAdapter: codexRuntime,
    });

    expect(
      result.suggestions.some(
        (suggestion) =>
          suggestion.id.startsWith("git:") || suggestion.id.startsWith("review:"),
      ),
    ).toBe(true);
  });

  it("uses detached review for dirty codex projects with an existing active session", async () => {
    const codexRuntime = makeCodexRuntime();
    codexRuntime.listSessions.mockResolvedValue([makeSession()]);
    codexRuntime.listStoredThreads.mockResolvedValue([
      {
        id: "thr_existing",
        preview: "Fix auth",
        createdAt: 1,
        updatedAt: 2,
        status: "notLoaded",
      },
    ]);

    const result = await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot(),
      errorInboxEntries: [makeErrorInboxEntry()],
      gitStatus: makeGitStatus({ hasWorkingTreeChanges: true }),
      codexAdapter: codexRuntime,
    });

    expect(codexRuntime.startReview).toHaveBeenCalledWith({
      providerThreadId: "thr_active",
      cwd: "/repo/acme",
      target: { type: "uncommittedChanges" },
      delivery: "detached",
    });
    expect(codexRuntime.archiveStoredThread).toHaveBeenCalledWith({
      providerThreadId: "thr_review",
      cwd: "/repo/acme",
    });
    expect(codexRuntime.startSession).not.toHaveBeenCalled();
    expect(result.suggestions[0]?.prompt).toContain("Fix the failing auth cleanup path");
  });

  it("prioritizes git fallback tasks when dirty codex review fails", async () => {
    const codexRuntime = makeCodexRuntime();
    codexRuntime.startReview.mockRejectedValue(new Error("review failed"));

    const result = await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot({
        tasks: [],
        taskRuntimes: [],
        threads: [makeThread({ title: "Greeting" })],
      }),
      errorInboxEntries: [],
      gitStatus: makeGitStatus({
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/auth.ts", insertions: 3, deletions: 1 }],
          insertions: 3,
          deletions: 1,
        },
      }),
      codexAdapter: codexRuntime,
    });

    expect(result.suggestions[0]?.prompt).toContain("uncommitted changes");
    expect(
      result.suggestions.some(
        (suggestion) =>
          suggestion.id.startsWith("git:") || suggestion.id.startsWith("review:"),
      ),
    ).toBe(true);
  });

  it("creates a hidden helper session when no reusable codex thread exists", async () => {
    const codexRuntime = makeCodexRuntime();

    await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot(),
      errorInboxEntries: [makeErrorInboxEntry()],
      gitStatus: makeGitStatus({ hasWorkingTreeChanges: true }),
      codexAdapter: codexRuntime,
    });

    expect(codexRuntime.startSession).toHaveBeenCalledTimes(1);
    expect(codexRuntime.startReview).toHaveBeenCalledWith({
      providerThreadId: "thr_helper",
      cwd: "/repo/acme",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    expect(codexRuntime.archiveStoredThread).toHaveBeenCalledWith({
      providerThreadId: "thr_helper",
      cwd: "/repo/acme",
    });
    expect(codexRuntime.stopSession).toHaveBeenCalledTimes(1);
  });

  it("uses stored threads and skills for clean codex projects without starting review", async () => {
    const codexRuntime = makeCodexRuntime();
    codexRuntime.listStoredThreads.mockResolvedValue([
      {
        id: "thr_existing",
        preview: "Ship auth cleanup",
        createdAt: 1,
        updatedAt: 2,
        status: "notLoaded",
      },
    ]);
    codexRuntime.listStoredSkills.mockResolvedValue([
      {
        name: "auth-skill",
        description: "Project auth guidance",
        displayName: "Auth Skill",
        shortDescription: "Project auth guidance",
      },
    ]);

    const result = await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot({
        tasks: [],
        taskRuntimes: [],
        threads: [],
      }),
      errorInboxEntries: [],
      gitStatus: makeGitStatus(),
      codexAdapter: codexRuntime,
    });

    expect(codexRuntime.startReview).not.toHaveBeenCalled();
    expect(codexRuntime.listStoredThreads).toHaveBeenCalledWith({
      cwd: "/repo/acme",
      limit: 10,
    });
    expect(codexRuntime.listStoredSkills).toHaveBeenCalledWith({
      cwd: "/repo/acme",
      forceReload: false,
    });
    expect(result.suggestions.some((suggestion) => suggestion.prompt.includes("Ship auth cleanup"))).toBe(
      true,
    );
  });

  it("falls back to deterministic heuristics when codex enrichment fails", async () => {
    const codexRuntime = makeCodexRuntime();
    codexRuntime.listStoredThreads.mockRejectedValue(new Error("thread/list failed"));
    codexRuntime.listStoredSkills.mockRejectedValue(new Error("skills/list failed"));

    const result = await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/acme",
        projectName: "Acme",
        selectedModel: null,
      },
      snapshot: makeSnapshot(),
      errorInboxEntries: [makeErrorInboxEntry()],
      gitStatus: makeGitStatus(),
      codexAdapter: codexRuntime,
    });

    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.prompt).toContain("Fix");
  });

  it("returns git-state suggestions for dirty codex projects with no other project context", async () => {
    const codexRuntime = makeCodexRuntime();
    codexRuntime.listStoredThreads.mockRejectedValue(new Error("thread/list failed"));
    codexRuntime.listStoredSkills.mockRejectedValue(new Error("skills/list failed"));

    const result = await suggestNewThreadTasks({
      request: {
        provider: "codex",
        cwd: "/repo/empty",
        projectName: "empty",
        selectedModel: null,
      },
      snapshot: makeSnapshot({
        projects: [makeProject({ workspaceRoot: "/repo/empty", scripts: [] })],
        tasks: [],
        taskRuntimes: [],
        threads: [],
      }),
      errorInboxEntries: [],
      gitStatus: makeGitStatus({
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/auth.ts", insertions: 3, deletions: 1 }],
          insertions: 3,
          deletions: 1,
        },
      }),
      codexAdapter: codexRuntime,
    });

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.prompt).toContain("uncommitted changes");
  });
});
