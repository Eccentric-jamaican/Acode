import type { Project, ProjectRules, Task, TaskRuntime, TaskRuntimeStatus, TaskState, Thread } from "~/types";
import type { OrchestrateFilters } from "./orchestrateFilters";

export type OrchestrateView = "board" | "list" | "inbox";

export interface TaskWithRuntime {
  readonly task: Task;
  readonly runtime: TaskRuntime | null;
  readonly thread: Thread | null;
  readonly project: Project | null;
  readonly rules: ProjectRules | null;
}

export function buildTaskRuntimeMap(taskRuntimes: readonly TaskRuntime[]): Map<string, TaskRuntime> {
  return new Map<string, TaskRuntime>(taskRuntimes.map((runtime) => [runtime.taskId, runtime]));
}

export function buildThreadMap(threads: readonly Thread[]): Map<string, Thread> {
  return new Map<string, Thread>(threads.map((thread) => [thread.id, thread]));
}

export function buildProjectMap(projects: readonly Project[]): Map<string, Project> {
  return new Map<string, Project>(projects.map((project) => [project.id, project]));
}

export function buildProjectRulesMap(projectRules: readonly ProjectRules[]): Map<string, ProjectRules> {
  return new Map<string, ProjectRules>(projectRules.map((rules) => [rules.projectId, rules]));
}

export function taskNeedsAttention(task: Task, runtime: TaskRuntime | null): boolean {
  if (task.state === "blocked") {
    return true;
  }
  if (!runtime) {
    return false;
  }
  return (
    runtime.status === "error" ||
    runtime.status === "awaiting_approval" ||
    runtime.status === "awaiting_input" ||
    runtime.status === "retrying"
  );
}

export function formatTaskKey(taskId: string): string {
  const compact = taskId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const tail = compact.slice(-4);
  return tail.length > 0 ? `TK-${tail}` : "TASK";
}

export function formatTaskStateLabel(state: TaskState): string {
  switch (state) {
    case "backlog":
      return "Backlog";
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "review":
      return "Review";
    case "blocked":
      return "Blocked";
    case "done":
      return "Done";
  }
}

export function formatRuntimeLabel(status: TaskRuntimeStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaiting_approval":
      return "Approval";
    case "awaiting_input":
      return "Input";
    case "retrying":
      return "Retrying";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
  }
}

export function relativeTimeLabel(iso: string | null): string {
  if (!iso) {
    return "No activity";
  }
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return "No activity";
  }
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "Updated now";
  }
  if (minutes < 60) {
    return `Updated ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Updated ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `Updated ${days}d`;
}

export function taskMetaLine(taskWithRuntime: TaskWithRuntime): string {
  const { runtime, thread, task } = taskWithRuntime;
  if (runtime?.status === "awaiting_approval") {
    return "Needs approval";
  }
  if (runtime?.status === "awaiting_input") {
    return "Needs input";
  }
  if (runtime?.status === "error") {
    return runtime.lastError ?? "Run failed";
  }
  if (runtime?.status === "running" || runtime?.status === "starting" || runtime?.status === "queued") {
    return formatRuntimeLabel(runtime.status);
  }
  return relativeTimeLabel(runtime?.lastActivityAt ?? thread?.updatedAt ?? task.updatedAt);
}

function matchesSearch(task: Task, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return (
    task.title.toLowerCase().includes(normalized) ||
    task.brief.toLowerCase().includes(normalized) ||
    task.acceptanceCriteria.toLowerCase().includes(normalized)
  );
}

export function buildTaskWithRuntimeCollection(input: {
  readonly tasks: readonly Task[];
  readonly taskRuntimes: readonly TaskRuntime[];
  readonly threads: readonly Thread[];
  readonly projects: readonly Project[];
  readonly projectRules: readonly ProjectRules[];
}): TaskWithRuntime[] {
  const runtimeByTaskId = buildTaskRuntimeMap(input.taskRuntimes);
  const threadById = buildThreadMap(input.threads);
  const projectById = buildProjectMap(input.projects);
  const rulesByProjectId = buildProjectRulesMap(input.projectRules);

  return input.tasks.map((task) => ({
    task,
    runtime: runtimeByTaskId.get(task.id) ?? null,
    thread: task.threadId ? (threadById.get(task.threadId) ?? null) : null,
    project: projectById.get(task.projectId) ?? null,
    rules: rulesByProjectId.get(task.projectId) ?? null,
  }));
}

export function filterTaskCollection(
  tasks: readonly TaskWithRuntime[],
  filters: OrchestrateFilters,
  selectedProjectId: string | "all",
): TaskWithRuntime[] {
  return tasks.filter((entry) => {
    if (selectedProjectId !== "all" && entry.task.projectId !== selectedProjectId) {
      return false;
    }
    if (filters.state !== "all" && entry.task.state !== filters.state) {
      return false;
    }
    if (filters.runtime !== "all" && entry.runtime?.status !== filters.runtime) {
      return false;
    }
    if (filters.needsAttention && !taskNeedsAttention(entry.task, entry.runtime)) {
      return false;
    }
    if (filters.hasLinkedThread && entry.task.threadId === null) {
      return false;
    }
    return matchesSearch(entry.task, filters.search);
  });
}

export function sortTaskCollection(tasks: readonly TaskWithRuntime[]): TaskWithRuntime[] {
  return tasks.toSorted((left, right) => {
    const leftPriority = left.task.priority ?? Number.POSITIVE_INFINITY;
    const rightPriority = right.task.priority ?? Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return right.task.updatedAt.localeCompare(left.task.updatedAt);
  });
}

export function groupTasksByState(tasks: readonly TaskWithRuntime[]): Map<TaskState, TaskWithRuntime[]> {
  const groups = new Map<TaskState, TaskWithRuntime[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.task.state) ?? [];
    bucket.push(task);
    groups.set(task.task.state, bucket);
  }
  return groups;
}

export function groupTasksByProject(tasks: readonly TaskWithRuntime[]): Map<string, TaskWithRuntime[]> {
  const groups = new Map<string, TaskWithRuntime[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.task.projectId) ?? [];
    bucket.push(task);
    groups.set(task.task.projectId, bucket);
  }
  return groups;
}
