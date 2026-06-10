import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import {
  getModelOptions,
  isValidOpencodeModelSlug,
  normalizeModelSlug,
  resolveModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { create } from "zustand";
import {
  type ChatMessage,
  type ErrorInboxEntry,
  type Project,
  type ProjectRules,
  type Task,
  type TaskRuntime,
  type ChatAttachment,
  type Thread,
} from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  projectRules: ProjectRules[];
  tasks: Task[];
  taskRuntimes: TaskRuntime[];
  errorInbox: ErrorInboxEntry[];
  threads: Thread[];
  threadsHydrated: boolean;
  hydrationStatus: "idle" | "loading" | "refreshing" | "ready" | "stale" | "error";
  hydrationError: string | null;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v8";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  projectRules: [],
  tasks: [],
  taskRuntimes: [],
  errorInbox: [],
  threads: [],
  threadsHydrated: false,
  hydrationStatus: "idle",
  hydrationError: null,
};
const persistedExpandedProjectCwds = new Set<string>();
let hasPersistedExpandedProjectCwds = false;

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      hasPersistedExpandedProjectCwds = false;
      persistedExpandedProjectCwds.clear();
      return initialState;
    }
    const parsed = JSON.parse(raw) as { expandedProjectCwds?: string[] };
    persistedExpandedProjectCwds.clear();
    const expandedProjectCwds = Array.isArray(parsed.expandedProjectCwds)
      ? parsed.expandedProjectCwds
      : null;
    hasPersistedExpandedProjectCwds = expandedProjectCwds !== null;
    for (const cwd of expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    return { ...initialState };
  } catch {
    hasPersistedExpandedProjectCwds = false;
    persistedExpandedProjectCwds.clear();
    return initialState;
  }
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
      }),
    );
    for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

function toPreviewableChatAttachment(input: {
  type: ChatAttachment["type"];
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}): ChatAttachment {
  const previewUrl = toAttachmentPreviewUrl(attachmentPreviewRoutePath(input.id));
  if (input.type === "pdf") {
    return {
      type: "pdf",
      id: input.id,
      name: input.name,
      mimeType: "application/pdf",
      sizeBytes: input.sizeBytes,
      previewUrl,
    };
  }
  return {
    type: "image",
    id: input.id,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    previewUrl,
  };
}

function reuseArrayByIndex<T>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  isEqual: (left: T, right: T) => boolean,
): T[] {
  if (previous.length !== next.length) {
    return next.map((entry, index) => {
      const previousEntry = previous[index];
      return previousEntry !== undefined && isEqual(previousEntry, entry) ? previousEntry : entry;
    });
  }

  let changed = false;
  const reused = next.map((entry, index) => {
    const previousEntry = previous[index];
    if (previousEntry !== undefined && isEqual(previousEntry, entry)) {
      return previousEntry;
    }
    changed = true;
    return entry;
  });
  return changed ? reused : (previous as T[]);
}

function arrayEqualByIndex<T>(
  left: ReadonlyArray<T>,
  right: ReadonlyArray<T>,
  isEqual: (left: T, right: T) => boolean,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry === undefined || rightEntry === undefined || !isEqual(leftEntry, rightEntry)) {
      return false;
    }
  }
  return true;
}

function equalNullableObject<T extends object>(
  left: T | null | undefined,
  right: T | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

function equalProject(left: Project, right: Project): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.expanded === right.expanded &&
    arrayEqualByIndex(left.scripts, right.scripts, equalNullableObject)
  );
}

function equalAttachment(left: ChatAttachment, right: ChatAttachment): boolean {
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.sizeBytes === right.sizeBytes &&
    left.previewUrl === right.previewUrl
  );
}

function equalMessage(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.text === right.text &&
    left.turnId === right.turnId &&
    left.createdAt === right.createdAt &&
    left.completedAt === right.completedAt &&
    left.streaming === right.streaming &&
    arrayEqualByIndex(left.attachments ?? [], right.attachments ?? [], equalAttachment)
  );
}

function equalProposedPlan(
  left: Thread["proposedPlans"][number],
  right: Thread["proposedPlans"][number],
): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.planMarkdown === right.planMarkdown &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function equalTurnDiffFile(
  left: Thread["turnDiffSummaries"][number]["files"][number],
  right: Thread["turnDiffSummaries"][number]["files"][number],
): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  );
}

function equalTurnDiffSummary(
  left: Thread["turnDiffSummaries"][number],
  right: Thread["turnDiffSummaries"][number],
): boolean {
  return (
    left.turnId === right.turnId &&
    left.completedAt === right.completedAt &&
    left.status === right.status &&
    left.assistantMessageId === right.assistantMessageId &&
    left.checkpointTurnCount === right.checkpointTurnCount &&
    left.checkpointRef === right.checkpointRef &&
    arrayEqualByIndex(left.files, right.files, equalTurnDiffFile)
  );
}

function equalActivity(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.kind === right.kind &&
    left.tone === right.tone &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.sequence === right.sequence
  );
}

function equalTask(left: Task, right: Task): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.brief === right.brief &&
    left.acceptanceCriteria === right.acceptanceCriteria &&
    left.state === right.state &&
    left.priority === right.priority &&
    left.threadId === right.threadId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    arrayEqualByIndex(left.attachments, right.attachments, equalAttachment)
  );
}

function equalThread(left: Thread, right: Thread): boolean {
  return (
    left.id === right.id &&
    left.codexThreadId === right.codexThreadId &&
    left.projectId === right.projectId &&
    left.origin === right.origin &&
    left.taskId === right.taskId &&
    left.parentThreadId === right.parentThreadId &&
    left.subagentAgentId === right.subagentAgentId &&
    left.subagentNickname === right.subagentNickname &&
    left.subagentRole === right.subagentRole &&
    left.title === right.title &&
    left.model === right.model &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    equalNullableObject(left.session, right.session) &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    equalNullableObject(left.latestTurn, right.latestTurn) &&
    left.lastVisitedAt === right.lastVisitedAt &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.isPinned === right.isPinned &&
    left.pinnedAt === right.pinnedAt &&
    left.archivedAt === right.archivedAt &&
    left.handoff === right.handoff &&
    arrayEqualByIndex(left.messages, right.messages, equalMessage) &&
    arrayEqualByIndex(left.proposedPlans, right.proposedPlans, equalProposedPlan) &&
    arrayEqualByIndex(left.turnDiffSummaries, right.turnDiffSummaries, equalTurnDiffSummary) &&
    arrayEqualByIndex(left.activities, right.activities, equalActivity)
  );
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  return incoming.map((project) => {
    const existing =
      previous.find((entry) => entry.id === project.id) ??
      previous.find((entry) => entry.cwd === project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model:
        existing?.model ??
        resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.codex),
      expanded:
        existing?.expanded ??
        (hasPersistedExpandedProjectCwds
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
    };
  });
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "opencode" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  opencode: new Set(getModelOptions("opencode").map((option) => option.slug)),
};

function inferProviderForThreadModel(input: {
  readonly model: string;
  readonly sessionProviderName: string | null;
}): ProviderKind {
  if (
    input.sessionProviderName === "codex" ||
    input.sessionProviderName === "opencode" ||
    input.sessionProviderName === "claudeAgent"
  ) {
    return input.sessionProviderName;
  }
  const normalizedClaude = normalizeModelSlug(input.model, "claudeAgent");
  if (normalizedClaude && BUILT_IN_MODEL_SLUGS_BY_PROVIDER.claudeAgent.has(normalizedClaude)) {
    return "claudeAgent";
  }
  const normalizedCodex = normalizeModelSlug(input.model, "codex");
  if (normalizedCodex && BUILT_IN_MODEL_SLUGS_BY_PROVIDER.codex.has(normalizedCodex)) {
    return "codex";
  }
  if (isValidOpencodeModelSlug(input.model)) {
    return "opencode";
  }
  return "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const desktopBridge = window.desktopBridge;
  const hasDesktopBridge = typeof desktopBridge?.getWsUrl === "function";
  const bridgeWsUrl = hasDesktopBridge ? desktopBridge.getWsUrl() : null;
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate = hasDesktopBridge
    ? typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : null
    : typeof envWsUrl === "string" && envWsUrl.length > 0
      ? envWsUrl
      : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function sanitizeSubagentThreadTitle(title: string, parentThreadId: ThreadId | null): string {
  if (parentThreadId === null) {
    return title;
  }
  let next = title.trim();
  next = next.replace(/^[>\-+*]\s+/, "");
  next = next.replace(/^#{1,6}\s+/, "");
  next = next.replace(/^\[(.+?)\]\([^)]+\)$/, "$1");
  for (;;) {
    const updated = next
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .replace(/^__(.+)__$/, "$1")
      .replace(/^\*(.+)\*$/, "$1")
      .replace(/^_(.+)_$/, "$1")
      .replace(/^`(.+)`$/, "$1")
      .trim();
    if (updated === next) {
      break;
    }
    next = updated;
  }
  return next.length > 0 ? next : title;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = reuseArrayByIndex(
    state.projects,
    mapProjectsFromReadModel(
      readModel.projects.filter((project) => project.deletedAt === null),
      state.projects,
    ),
    equalProject,
  );
  const existingThreadById = new Map(state.threads.map((thread) => [thread.id, thread] as const));
  const projectRules = reuseArrayByIndex(
    state.projectRules,
    readModel.projectRules.map((entry) => ({ ...entry })),
    equalNullableObject,
  );
  const tasks = reuseArrayByIndex(
    state.tasks,
    readModel.tasks
      .filter((task) => task.deletedAt === null)
      .map((task) => ({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        brief: task.brief,
        acceptanceCriteria: task.acceptanceCriteria,
        attachments: (task.attachments ?? []).map((attachment) =>
          toPreviewableChatAttachment(attachment),
        ),
        state: task.state,
        priority: task.priority,
        threadId: task.threadId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
    equalTask,
  );
  const taskRuntimes = reuseArrayByIndex(
    state.taskRuntimes,
    readModel.taskRuntimes.map((runtime) => ({ ...runtime })),
    equalNullableObject,
  );
  const threads = reuseArrayByIndex(
    state.threads,
    readModel.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => {
        const existing = existingThreadById.get(thread.id);
        const parentThreadId = thread.parentThreadId ?? null;
        const messages = reuseArrayByIndex(
          existing?.messages ?? [],
          thread.messages.map((message) => {
            const attachments = message.attachments?.map((attachment) =>
              toPreviewableChatAttachment(attachment),
            );
            const normalizedMessage: ChatMessage = {
              id: message.id,
              role: message.role,
              text: message.text,
              ...(message.turnId ? { turnId: message.turnId } : {}),
              createdAt: message.createdAt,
              streaming: message.streaming,
              ...(message.streaming ? {} : { completedAt: message.updatedAt }),
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            };
            return normalizedMessage;
          }),
          equalMessage,
        );
        const proposedPlans = reuseArrayByIndex(
          existing?.proposedPlans ?? [],
          thread.proposedPlans.map((proposedPlan) => ({
            id: proposedPlan.id,
            turnId: proposedPlan.turnId,
            planMarkdown: proposedPlan.planMarkdown,
            createdAt: proposedPlan.createdAt,
            updatedAt: proposedPlan.updatedAt,
          })),
          equalProposedPlan,
        );
        const existingTurnDiffSummariesByTurnId = new Map(
          existing?.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
        );
        const turnDiffSummaries = reuseArrayByIndex(
          existing?.turnDiffSummaries ?? [],
          thread.checkpoints.map((checkpoint) => ({
            turnId: checkpoint.turnId,
            completedAt: checkpoint.completedAt,
            status: checkpoint.status,
            assistantMessageId: checkpoint.assistantMessageId ?? undefined,
            checkpointTurnCount: checkpoint.checkpointTurnCount,
            checkpointRef: checkpoint.checkpointRef,
            files: reuseArrayByIndex(
              existingTurnDiffSummariesByTurnId.get(checkpoint.turnId)?.files ?? [],
              checkpoint.files.map((file) => ({ ...file })),
              equalTurnDiffFile,
            ),
          })),
          equalTurnDiffSummary,
        );
        const activities = reuseArrayByIndex(
          existing?.activities ?? [],
          thread.activities.map((activity) => ({ ...activity })),
          equalActivity,
        );
        const normalizedThread: Thread = {
          id: thread.id,
          codexThreadId: null,
          projectId: thread.projectId,
          origin: thread.origin ?? "user",
          taskId: thread.taskId ?? null,
          parentThreadId,
          subagentAgentId: thread.subagentAgentId ?? null,
          subagentNickname: thread.subagentNickname ?? null,
          subagentRole: thread.subagentRole ?? null,
          title: sanitizeSubagentThreadTitle(thread.title, parentThreadId),
          model: resolveModelSlugForProvider(
            inferProviderForThreadModel({
              model: thread.model,
              sessionProviderName: thread.session?.providerName ?? null,
            }),
            thread.model,
          ),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          session: thread.session
            ? {
                provider: toLegacyProvider(thread.session.providerName),
                status: toLegacySessionStatus(thread.session.status),
                orchestrationStatus: thread.session.status,
                activeTurnId: thread.session.activeTurnId ?? undefined,
                createdAt: thread.session.updatedAt,
                updatedAt: thread.session.updatedAt,
                ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
              }
            : null,
          messages,
          proposedPlans,
          error: thread.session?.lastError ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          latestTurn: thread.latestTurn,
          lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          isPinned: thread.isPinned ?? false,
          pinnedAt: thread.pinnedAt ?? null,
          archivedAt: thread.archivedAt ?? null,
          turnDiffSummaries,
          activities,
          handoff: thread.handoff ?? null,
        };
        return existing && equalThread(existing, normalizedThread) ? existing : normalizedThread;
      }),
    equalThread,
  );
  if (
    state.projects === projects &&
    state.projectRules === projectRules &&
    state.tasks === tasks &&
    state.taskRuntimes === taskRuntimes &&
    state.threads === threads &&
    state.threadsHydrated &&
    state.hydrationStatus === "ready" &&
    state.hydrationError === null
  ) {
    return state;
  }
  return {
    ...state,
    projects,
    projectRules,
    tasks,
    taskRuntimes,
    threads,
    threadsHydrated: true,
    hydrationStatus: "ready",
    hydrationError: null,
  };
}

export function setHydrationStatus(
  state: AppState,
  hydrationStatus: AppState["hydrationStatus"],
): AppState {
  if (state.hydrationStatus === hydrationStatus) {
    return state;
  }
  return {
    ...state,
    hydrationStatus,
  };
}

export function setHydrationError(state: AppState, error: string | null): AppState {
  if (state.hydrationError === error) {
    return state;
  }
  return {
    ...state,
    hydrationError: error,
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const threads = updateThread(state.threads, threadId, (thread) => {
    const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
    if (
      Number.isFinite(previousVisitedAtMs) &&
      Number.isFinite(visitedAtMs) &&
      previousVisitedAtMs >= visitedAtMs
    ) {
      return thread;
    }
    return { ...thread, lastVisitedAt: at };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  const threads = updateThread(state.threads, threadId, (thread) => {
    if (!thread.latestTurn?.completedAt) return thread;
    const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
    if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
    const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
    if (thread.lastVisitedAt === unreadVisitedAt) return thread;
    return { ...thread, lastVisitedAt: unreadVisitedAt };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, expanded: !p.expanded } : p)),
  };
}

export function syncErrorInbox(state: AppState, entries: ReadonlyArray<ErrorInboxEntry>): AppState {
  return {
    ...state,
    errorInbox: entries.map((entry) => ({ ...entry })),
  };
}

export function upsertErrorInboxEntry(state: AppState, entry: ErrorInboxEntry): AppState {
  const existingIndex = state.errorInbox.findIndex((current) => current.id === entry.id);
  const nextEntries =
    existingIndex === -1
      ? [{ ...entry }, ...state.errorInbox]
      : state.errorInbox.map((current, index) =>
          index === existingIndex ? { ...entry } : current,
        );
  nextEntries.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return {
    ...state,
    errorInbox: nextEntries,
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId || p.expanded === expanded) return p;
    changed = true;
    return { ...p, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function setAllProjectsExpanded(state: AppState, expanded: boolean): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    if (project.expanded === expanded) return project;
    changed = true;
    return { ...project, expanded };
  });
  return changed ? { ...state, projects } : state;
}

export function collapseProjectsExcept(
  state: AppState,
  activeProjectId: Project["id"] | null,
): AppState {
  let changed = false;
  const projects = state.projects.map((project) => {
    const nextExpanded = activeProjectId !== null && project.id === activeProjectId;
    if (project.expanded === nextExpanded) return project;
    changed = true;
    return { ...project, expanded: nextExpanded };
  });
  return changed ? { ...state, projects } : state;
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
  return threads === state.threads ? state : { ...state, threads };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  const threads = updateThread(state.threads, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
  return threads === state.threads ? state : { ...state, threads };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  setHydrationStatus: (status: AppState["hydrationStatus"]) => void;
  setHydrationError: (error: string | null) => void;
  syncErrorInbox: (entries: ReadonlyArray<ErrorInboxEntry>) => void;
  upsertErrorInboxEntry: (entry: ErrorInboxEntry) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  setAllProjectsExpanded: (expanded: boolean) => void;
  collapseProjectsExcept: (activeProjectId: Project["id"] | null) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  setHydrationStatus: (status) => set((state) => setHydrationStatus(state, status)),
  setHydrationError: (error) => set((state) => setHydrationError(state, error)),
  syncErrorInbox: (entries) => set((state) => syncErrorInbox(state, entries)),
  upsertErrorInboxEntry: (entry) => set((state) => upsertErrorInboxEntry(state, entry)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) => set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setAllProjectsExpanded: (expanded) => set((state) => setAllProjectsExpanded(state, expanded)),
  collapseProjectsExcept: (activeProjectId) =>
    set((state) => collapseProjectsExcept(state, activeProjectId)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
}));

// Persist on every state change
useStore.subscribe((state) => persistState(state));

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
