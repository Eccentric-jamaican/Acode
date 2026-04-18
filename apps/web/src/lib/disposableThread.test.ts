import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveDisposableThreadIdToDispose } from "./disposableThread";

const PREVIOUS_THREAD_ID = "thread-prev" as ThreadId;
const NEXT_THREAD_ID = "thread-next" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;

describe("resolveDisposableThreadIdToDispose", () => {
  it("disposes explicit temporary threads on thread switch", () => {
    const disposable = resolveDisposableThreadIdToDispose({
      previousThreadId: PREVIOUS_THREAD_ID,
      nextThreadId: NEXT_THREAD_ID,
      previousThreadWasTemporary: true,
      draftThreadsByThreadId: {},
    });

    expect(disposable).toBe(PREVIOUS_THREAD_ID);
  });

  it("does not dispose when navigating away from thread routes", () => {
    const disposable = resolveDisposableThreadIdToDispose({
      previousThreadId: PREVIOUS_THREAD_ID,
      nextThreadId: null,
      previousThreadWasTemporary: true,
      draftThreadsByThreadId: {},
    });

    expect(disposable).toBeNull();
  });

  it("disposes empty unsent local drafts on thread switch", () => {
    const disposable = resolveDisposableThreadIdToDispose({
      previousThreadId: PREVIOUS_THREAD_ID,
      nextThreadId: NEXT_THREAD_ID,
      draftThreadsByThreadId: {
        [PREVIOUS_THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      previousThreadHasServerThread: false,
      composerDraftsByThreadId: {},
    });

    expect(disposable).toBe(PREVIOUS_THREAD_ID);
  });

  it("keeps unsent drafts when there is typed prompt content", () => {
    const disposable = resolveDisposableThreadIdToDispose({
      previousThreadId: PREVIOUS_THREAD_ID,
      nextThreadId: NEXT_THREAD_ID,
      draftThreadsByThreadId: {
        [PREVIOUS_THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      previousThreadHasServerThread: false,
      composerDraftsByThreadId: {
        [PREVIOUS_THREAD_ID]: {
          prompt: "keep this draft",
          images: [],
          persistedAttachments: [],
          pinnedSelections: [],
        },
      },
    });

    expect(disposable).toBeNull();
  });

  it("keeps threads that already exist on the server", () => {
    const disposable = resolveDisposableThreadIdToDispose({
      previousThreadId: PREVIOUS_THREAD_ID,
      nextThreadId: NEXT_THREAD_ID,
      draftThreadsByThreadId: {
        [PREVIOUS_THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-03-04T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      previousThreadHasServerThread: true,
      composerDraftsByThreadId: {},
    });

    expect(disposable).toBeNull();
  });
});
