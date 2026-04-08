import type { Project, Thread } from "./types";
import type {
  SidebarPreferences,
  SidebarThreadSort,
} from "./sidebarPreferences";

export interface SidebarThreadVisibilityInput {
  hasPendingApproval: boolean;
  isActive: boolean;
  now?: number;
}

export interface SidebarProjectGroup {
  project: Project;
  threads: Thread[];
}

export interface SidebarVisibleProjectThreads {
  hasHiddenThreads: boolean;
  visibleThreads: Thread[];
}

function hasUnseenCompletion(thread: Thread): boolean {
  if (!thread.latestTurn?.completedAt) {
    return false;
  }
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) {
    return false;
  }
  if (!thread.lastVisitedAt) {
    return true;
  }

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) {
    return true;
  }
  return completedAt > lastVisitedAt;
}

export function isRelevantThread(
  thread: Thread,
  input: SidebarThreadVisibilityInput,
): boolean {
  const now = input.now ?? Date.now();
  const updatedAt = Date.parse(thread.updatedAt);
  const updatedRecently =
    Number.isFinite(updatedAt) && now - updatedAt <= 7 * 24 * 60 * 60 * 1_000;

  return (
    thread.isPinned ||
    input.isActive ||
    input.hasPendingApproval ||
    thread.session?.status === "running" ||
    thread.session?.status === "connecting" ||
    hasUnseenCompletion(thread) ||
    updatedRecently
  );
}

export function threadTimestamp(thread: Thread, threadSort: SidebarThreadSort): string {
  return threadSort === "updated" ? thread.updatedAt : thread.createdAt;
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: Thread): number {
  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function getThreadSortTimestamp(thread: Thread, threadSort: SidebarThreadSort): number {
  if (threadSort === "created") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

export function sortThreadsForSidebar(
  threads: readonly Thread[],
  threadSort: SidebarThreadSort,
): Thread[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    const rightTimestamp = getThreadSortTimestamp(right, threadSort);
    const leftTimestamp = getThreadSortTimestamp(left, threadSort);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) {
      return byTimestamp;
    }

    return right.id.localeCompare(left.id);
  });
}

export function pruneMissingProjectIds(
  projectOrder: readonly string[],
  projects: readonly Project[],
): string[] {
  const projectIds = new Set<string>(projects.map((project) => project.id));
  return projectOrder.filter((projectId) => projectIds.has(projectId));
}

export function orderProjectsForSidebar(
  projects: readonly Project[],
  projectOrder: readonly string[],
): Project[] {
  const knownOrder = new Map<Project["id"], number>(
    projectOrder.map((projectId, index) => [projectId as Project["id"], index]),
  );
  return [...projects].sort((left, right) => {
    const leftIndex = knownOrder.get(left.id);
    const rightIndex = knownOrder.get(right.id);

    if (leftIndex !== undefined || rightIndex !== undefined) {
      if (leftIndex === undefined) {
        return 1;
      }
      if (rightIndex === undefined) {
        return -1;
      }
      return leftIndex - rightIndex;
    }

    return left.name.localeCompare(right.name);
  });
}

export function groupThreadsByProject(
  projects: readonly Project[],
  threads: readonly Thread[],
  preferences: Pick<SidebarPreferences, "threadSort">,
): SidebarProjectGroup[] {
  const sortedThreads = sortThreadsForSidebar(threads, preferences.threadSort);
  const threadsByProjectId = new Map<Project["id"], Thread[]>();

  for (const thread of sortedThreads) {
    const existing = threadsByProjectId.get(thread.projectId);
    if (existing) {
      existing.push(thread);
      continue;
    }
    threadsByProjectId.set(thread.projectId, [thread]);
  }

  return projects.map((project) => ({
    project,
    threads: threadsByProjectId.get(project.id) ?? [],
  }));
}

export function buildChronologicalThreadList(
  threads: readonly Thread[],
  preferences: Pick<SidebarPreferences, "threadSort">,
): Thread[] {
  return sortThreadsForSidebar(threads, preferences.threadSort);
}

export function getVisibleThreadsForProject(input: {
  threads: readonly Thread[];
  activeThreadId: Thread["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): SidebarVisibleProjectThreads {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));
  return {
    hasHiddenThreads: true,
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}
