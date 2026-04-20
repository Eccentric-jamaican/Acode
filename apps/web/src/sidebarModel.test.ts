import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSidebarThreadHierarchy,
  buildChronologicalThreadList,
  getVisibleThreadsForProject,
  groupThreadsByProject,
  includeAncestorThreads,
  isRelevantThread,
  orderProjectsForSidebar,
  pruneMissingProjectIds,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  splitPinnedThreads,
} from "./sidebarModel";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "./types";

function makeProject(id: string, name: string): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name,
    cwd: `/tmp/${name}`,
    model: "gpt-5.4",
    expanded: true,
    scripts: [],
  };
}

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    origin: "user",
    taskId: null,
    title: id,
    model: "gpt-5.4",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: "2026-03-01T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    isPinned: false,
    pinnedAt: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("isRelevantThread", () => {
  it("treats pinned threads as relevant", () => {
    expect(
      isRelevantThread(makeThread("thread-1", { isPinned: true }), {
        hasPendingApproval: false,
        isActive: false,
        now: Date.parse("2026-03-10T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("treats old inactive threads as not relevant", () => {
    expect(
      isRelevantThread(
        makeThread("thread-1", {
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastVisitedAt: "2026-01-02T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            interactionMode: "default",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
        {
          hasPendingApproval: false,
          isActive: false,
          now: Date.parse("2026-03-10T00:00:00.000Z"),
        },
      ),
    ).toBe(false);
  });
});

describe("sortThreadsForSidebar", () => {
  it("sorts by timestamp without pin promotion", () => {
    const threads = sortThreadsForSidebar(
      [
        makeThread("unpinned-new", { createdAt: "2026-03-03T00:00:00.000Z" }),
        makeThread("pinned-old", {
          isPinned: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      "created",
    );

    expect(threads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("unpinned-new"),
      ThreadId.makeUnsafe("pinned-old"),
    ]);
  });

  it("sorts updated threads by latest user message timestamp", () => {
    const threads = sortThreadsForSidebar(
      [
        makeThread("thread-1", {
          updatedAt: "2026-03-03T00:00:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-01T00:00:00.000Z",
              streaming: false,
              completedAt: "2026-03-01T00:00:00.000Z",
            },
          ],
        }),
        makeThread("thread-2", {
          updatedAt: "2026-03-02T00:00:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-04T00:00:00.000Z",
              streaming: false,
              completedAt: "2026-03-04T00:00:00.000Z",
            },
          ],
        }),
      ],
      "updated",
    );

    expect(threads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });
});

describe("project ordering helpers", () => {
  it("prunes missing ids and applies saved order", () => {
    const projects = [
      makeProject("project-1", "Alpha"),
      makeProject("project-2", "Beta"),
      makeProject("project-3", "Gamma"),
    ];

    expect(pruneMissingProjectIds(["project-3", "missing"], projects)).toEqual(["project-3"]);
    expect(orderProjectsForSidebar(projects, ["project-3", "project-1"]).map((project) => project.id))
      .toEqual([
        ProjectId.makeUnsafe("project-3"),
        ProjectId.makeUnsafe("project-1"),
        ProjectId.makeUnsafe("project-2"),
      ]);
  });
});

describe("thread grouping helpers", () => {
  it("groups threads under their projects and sorts them", () => {
    const projects = [makeProject("project-1", "Alpha"), makeProject("project-2", "Beta")];
    const threads = [
      makeThread("thread-1", {
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
      makeThread("thread-2", {
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-03T00:00:00.000Z",
      }),
    ];

    const groups = groupThreadsByProject(projects, threads, { threadSort: "updated" });

    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
    expect(buildChronologicalThreadList(threads, { threadSort: "updated" }).map((thread) => thread.id))
      .toEqual([ThreadId.makeUnsafe("thread-2"), ThreadId.makeUnsafe("thread-1")]);
  });

  it("keeps parent threads when a subagent child is selected as relevant", () => {
    const parent = makeThread("thread-parent");
    const child = makeThread("thread-child", {
      parentThreadId: ThreadId.makeUnsafe("thread-parent"),
    });

    const result = includeAncestorThreads([parent, child], [child]);

    expect(result.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
    ]);
  });

  it("builds a sidebar hierarchy with child threads nested under visible parents", () => {
    const parent = makeThread("thread-parent");
    const child = makeThread("thread-child", {
      parentThreadId: ThreadId.makeUnsafe("thread-parent"),
    });
    const orphan = makeThread("thread-orphan", {
      parentThreadId: ThreadId.makeUnsafe("missing-parent"),
    });

    const result = buildSidebarThreadHierarchy([parent, child, orphan]);

    expect(result.topLevelThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-orphan"),
    ]);
    expect(result.childThreadsByParentId.get(ThreadId.makeUnsafe("thread-parent"))?.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-child"),
    ]);
  });
});

describe("pinned thread helpers", () => {
  it("sorts pinned threads by most recently pinned", () => {
    const threads = sortPinnedThreadsForSidebar([
      makeThread("thread-1", {
        isPinned: true,
        pinnedAt: "2026-03-01T00:00:00.000Z",
      }),
      makeThread("thread-2", {
        isPinned: true,
        pinnedAt: "2026-03-03T00:00:00.000Z",
      }),
    ]);

    expect(threads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("splits pinned threads out of the project thread lists", () => {
    const result = splitPinnedThreads([
      makeThread("thread-1", { isPinned: true, pinnedAt: "2026-03-03T00:00:00.000Z" }),
      makeThread("thread-2"),
    ]);

    expect(result.pinnedThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
    ]);
    expect(result.unpinnedThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("getVisibleThreadsForProject", () => {
  it("returns preview threads when collapsed", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread(`thread-${index + 1}`, {
        updatedAt: `2026-03-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: undefined,
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads).toHaveLength(6);
  });

  it("keeps the active thread visible when collapsed", () => {
    const threads = Array.from({ length: 8 }, (_, index) => makeThread(`thread-${index + 1}`));
    const activeThreadId = ThreadId.makeUnsafe("thread-8");

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId,
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.some((thread) => thread.id === activeThreadId)).toBe(true);
  });
});
