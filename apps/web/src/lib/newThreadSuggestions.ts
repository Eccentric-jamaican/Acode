import type { ErrorInboxEntry, Project, ProjectScript, Task, TaskRuntime, Thread } from "../types";

const STALE_TASK_AGE_MS = 1000 * 60 * 60 * 24 * 2;

export type NewThreadSuggestionSource =
  | "task-error"
  | "task-blocked"
  | "task-review"
  | "task-start"
  | "task-finish"
  | "error-inbox"
  | "script"
  | "thread";

export interface NewThreadSuggestion {
  id: string;
  prompt: string;
  source: NewThreadSuggestionSource;
  priority: number;
}

function isStale(iso: string | null | undefined): boolean {
  if (!iso) {
    return false;
  }
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_TASK_AGE_MS;
}

function normalizeQuotedTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? `"${trimmed}"` : "this task";
}

function trimSuggestionPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function pushSuggestion(
  suggestions: NewThreadSuggestion[],
  nextSuggestion: NewThreadSuggestion,
  seenPrompts: Set<string>,
) {
  const normalizedPrompt = trimSuggestionPrompt(nextSuggestion.prompt);
  const promptKey = normalizedPrompt.toLowerCase();
  if (normalizedPrompt.length === 0 || seenPrompts.has(promptKey)) {
    return;
  }

  seenPrompts.add(promptKey);
  suggestions.push({
    ...nextSuggestion,
    prompt: normalizedPrompt,
  });
}

function buildTaskSuggestion(task: Task, runtime: TaskRuntime | null): NewThreadSuggestion {
  const quotedTitle = normalizeQuotedTitle(task.title);
  if (runtime?.status === "error") {
    return {
      id: `task-error:${task.id}`,
      source: "task-error",
      priority: 100,
      prompt: `Fix ${quotedTitle} and get it back to a reviewable state.`,
    };
  }
  if (task.state === "blocked") {
    return {
      id: `task-blocked:${task.id}`,
      source: "task-blocked",
      priority: 96,
      prompt: `Unblock ${quotedTitle} and take the safest next implementation step.`,
    };
  }
  if (runtime?.status === "awaiting_approval" || runtime?.status === "awaiting_input") {
    return {
      id: `task-review:${task.id}`,
      source: "task-review",
      priority: 92,
      prompt: `Review ${quotedTitle} and prepare the next safe step so work can continue.`,
    };
  }
  if (task.state === "ready" || task.state === "backlog") {
    return {
      id: `task-start:${task.id}`,
      source: "task-start",
      priority: task.state === "ready" ? 86 : 72,
      prompt: `Start ${quotedTitle} and deliver the first reviewable slice.`,
    };
  }
  if (task.state === "running" && isStale(runtime?.lastActivityAt ?? task.updatedAt)) {
    return {
      id: `task-finish:${task.id}`,
      source: "task-finish",
      priority: 78,
      prompt: `Finish ${quotedTitle} and move it into a reviewable state.`,
    };
  }

  return {
    id: `task-finish:${task.id}`,
    source: "task-finish",
    priority: 64,
    prompt: `Move ${quotedTitle} forward and leave the work easy to review.`,
  };
}

function buildErrorInboxSuggestion(entry: ErrorInboxEntry): NewThreadSuggestion {
  return {
    id: `error:${entry.id}`,
    source: "error-inbox",
    priority: 88,
    prompt: `Investigate ${normalizeQuotedTitle(entry.summary)} and fix the underlying issue.`,
  };
}

function buildProjectScriptSuggestion(script: ProjectScript, project: Project): NewThreadSuggestion {
  return {
    id: `script:${project.id}:${script.id}`,
    source: "script",
    priority: 48,
    prompt: `Run ${normalizeQuotedTitle(script.name)} for ${project.name} and fix any failures.`,
  };
}

function buildRecentThreadSuggestion(thread: Thread): NewThreadSuggestion {
  return {
    id: `thread:${thread.id}`,
    source: "thread",
    priority: 40,
    prompt: `Pick up ${normalizeQuotedTitle(thread.title)} from a fresh thread and move it forward.`,
  };
}

export function collectNewThreadSuggestionCandidates(input: {
  project: Project | null;
  tasks: readonly Task[];
  taskRuntimes: readonly TaskRuntime[];
  threads: readonly Thread[];
  errorInbox: readonly ErrorInboxEntry[];
}): NewThreadSuggestion[] {
  if (!input.project) {
    return [];
  }

  const suggestions: NewThreadSuggestion[] = [];
  const seenPrompts = new Set<string>();
  const runtimeByTaskId = new Map(input.taskRuntimes.map((runtime) => [runtime.taskId, runtime]));
  const projectTasks = input.tasks.filter(
    (task) => task.projectId === input.project?.id && task.state !== "done",
  );
  const projectTaskIds = new Set(projectTasks.map((task) => task.id));
  const projectThreads = input.threads
    .filter((thread) => thread.projectId === input.project?.id)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const projectThreadIds = new Set(projectThreads.map((thread) => thread.id));
  const unresolvedErrorEntries = input.errorInbox
    .filter((entry) => {
      if (entry.resolution !== null || entry.linkedTaskId !== null) {
        return false;
      }
      if (entry.projectId === input.project?.id) {
        return true;
      }
      return entry.threadId !== null && projectThreadIds.has(entry.threadId);
    })
    .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));

  for (const task of projectTasks.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    pushSuggestion(suggestions, buildTaskSuggestion(task, runtimeByTaskId.get(task.id) ?? null), seenPrompts);
  }

  for (const entry of unresolvedErrorEntries) {
    if (entry.linkedTaskId && projectTaskIds.has(entry.linkedTaskId)) {
      continue;
    }
    pushSuggestion(suggestions, buildErrorInboxSuggestion(entry), seenPrompts);
  }

  for (const script of input.project.scripts) {
    pushSuggestion(suggestions, buildProjectScriptSuggestion(script, input.project), seenPrompts);
  }

  for (const thread of projectThreads) {
    if (thread.origin === "task") {
      continue;
    }
    pushSuggestion(suggestions, buildRecentThreadSuggestion(thread), seenPrompts);
  }

  return suggestions;
}

export function buildNewThreadSuggestions(input: {
  project: Project | null;
  tasks: readonly Task[];
  taskRuntimes: readonly TaskRuntime[];
  threads: readonly Thread[];
  errorInbox: readonly ErrorInboxEntry[];
}): NewThreadSuggestion[] {
  return collectNewThreadSuggestionCandidates(input)
    .toSorted((left, right) => right.priority - left.priority)
    .slice(0, 3);
}

export function applyRefinedNewThreadSuggestions(input: {
  baseSuggestions: readonly NewThreadSuggestion[];
  refinedSuggestions: ReadonlyArray<{ id: string; prompt: string }> | null | undefined;
}): NewThreadSuggestion[] {
  if (!input.refinedSuggestions || input.refinedSuggestions.length === 0) {
    return [...input.baseSuggestions];
  }

  const suggestionsById = new Map(input.baseSuggestions.map((suggestion) => [suggestion.id, suggestion]));
  const refined: NewThreadSuggestion[] = [];
  const seenIds = new Set<string>();

  for (const entry of input.refinedSuggestions) {
    const baseSuggestion = suggestionsById.get(entry.id);
    const prompt = trimSuggestionPrompt(entry.prompt);
    if (!baseSuggestion || prompt.length === 0 || seenIds.has(entry.id)) {
      continue;
    }
    seenIds.add(entry.id);
    refined.push({
      ...baseSuggestion,
      prompt,
    });
  }

  return refined.length > 0 ? refined : [...input.baseSuggestions];
}
