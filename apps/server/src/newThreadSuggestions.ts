import {
  query,
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type {
  ErrorInboxEntry,
  GitStatusResult,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationTask,
  OrchestrationTaskRuntime,
  OrchestrationThread,
  ProviderKind,
  ServerNewThreadSuggestionCandidate,
  ServerSuggestNewThreadTasksInput,
  ServerSuggestNewThreadTasksResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { normalizeModelSlug, parseOpencodeModelSlug } from "@t3tools/shared/model";

import type {
  CodexStoredSkillSummary,
  CodexStoredThreadSummary,
} from "./provider/Services/CodexAdapter.ts";

const STALE_TASK_AGE_MS = 1000 * 60 * 60 * 24 * 2;
const REVIEW_POLL_INTERVAL_MS = 750;
const REVIEW_TIMEOUT_MS = 45_000;

type SuggestionContext = {
  readonly dirtyWorkingTree?: boolean;
  readonly reviewText?: string;
  readonly recentCodexThreads?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
};

interface SuggestionCandidate {
  readonly id: string;
  readonly prompt: string;
  readonly priority: number;
}

interface CodexSuggestionRuntime {
  readonly listSessions: () => Promise<
    ReadonlyArray<{ readonly cwd?: string | undefined; readonly resumeCursor?: unknown }>
  >;
  readonly listStoredThreads: (input: {
    readonly cwd: string;
    readonly limit?: number;
  }) => Promise<ReadonlyArray<CodexStoredThreadSummary>>;
  readonly listStoredSkills: (input: {
    readonly cwd: string;
    readonly forceReload?: boolean;
  }) => Promise<ReadonlyArray<CodexStoredSkillSummary>>;
  readonly readStoredThread: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
    readonly includeTurns?: boolean;
  }) => Promise<{
    readonly threadId: string;
    readonly turns: ReadonlyArray<{ readonly id: string; readonly items: ReadonlyArray<unknown> }>;
  }>;
  readonly archiveStoredThread: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
  }) => Promise<void>;
  readonly startReview: (input: {
    readonly providerThreadId: string;
    readonly cwd: string;
    readonly target: {
      readonly type: "uncommittedChanges";
    };
    readonly delivery?: "inline" | "detached";
  }) => Promise<{
    readonly reviewThreadId: string;
    readonly turnId: string | null;
  }>;
  readonly startSession: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly cwd: string;
    readonly runtimeMode: "full-access";
    readonly model?: string;
  }) => Promise<{ readonly resumeCursor?: unknown }>;
  readonly stopSession: (threadId: ThreadId) => Promise<void>;
}

let runtimePromise: Promise<{
  client: OpencodeClient;
  server: {
    close(): void;
  };
}> | null = null;

function getOpencodeRuntime() {
  if (!runtimePromise) {
    runtimePromise = createOpencode().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }

  return runtimePromise;
}

function extractAssistantText(parts: ReadonlyArray<unknown> | undefined): string {
  if (!parts) {
    return "";
  }

  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type !== "text" || typeof candidate.text !== "string") {
        return [];
      }
      return [candidate.text];
    })
    .join("")
    .trim();
}

function extractJsonPayload(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBraceIndex = text.indexOf("{");
  const lastBraceIndex = text.lastIndexOf("}");
  if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
    return text.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  return text.trim();
}

function trimSuggestionPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function pushCandidate(
  candidates: SuggestionCandidate[],
  seenPrompts: Set<string>,
  nextCandidate: SuggestionCandidate,
) {
  const prompt = trimSuggestionPrompt(nextCandidate.prompt);
  const promptKey = prompt.toLowerCase();
  if (!prompt || seenPrompts.has(promptKey)) {
    return;
  }

  seenPrompts.add(promptKey);
  candidates.push({
    ...nextCandidate,
    prompt,
  });
}

function quoteTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? `"${trimmed}"` : "this task";
}

function isStale(iso: string | null | undefined): boolean {
  if (!iso) {
    return false;
  }

  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_TASK_AGE_MS;
}

function buildTaskCandidate(
  task: OrchestrationTask,
  runtime: OrchestrationTaskRuntime | null,
): SuggestionCandidate {
  const quotedTitle = quoteTitle(task.title);
  if (runtime?.status === "error") {
    return {
      id: `task-error:${task.id}`,
      priority: 100,
      prompt: `Fix ${quotedTitle} and get it back to a reviewable state.`,
    };
  }

  if (task.state === "blocked") {
    return {
      id: `task-blocked:${task.id}`,
      priority: 96,
      prompt: `Unblock ${quotedTitle} and take the safest next implementation step.`,
    };
  }

  if (runtime?.status === "awaiting_approval" || runtime?.status === "awaiting_input") {
    return {
      id: `task-review:${task.id}`,
      priority: 92,
      prompt: `Review ${quotedTitle} and prepare the next safe step so work can continue.`,
    };
  }

  if (task.state === "ready" || task.state === "backlog") {
    return {
      id: `task-start:${task.id}`,
      priority: task.state === "ready" ? 86 : 72,
      prompt: `Start ${quotedTitle} and deliver the first reviewable slice.`,
    };
  }

  if (task.state === "running" && isStale(runtime?.lastActivityAt ?? task.updatedAt)) {
    return {
      id: `task-finish:${task.id}`,
      priority: 78,
      prompt: `Finish ${quotedTitle} and move it into a reviewable state.`,
    };
  }

  return {
    id: `task-finish:${task.id}`,
    priority: 64,
    prompt: `Move ${quotedTitle} forward and leave the work easy to review.`,
  };
}

function buildErrorCandidate(entry: ErrorInboxEntry): SuggestionCandidate {
  return {
    id: `error:${entry.id}`,
    priority: 88,
    prompt: `Investigate ${quoteTitle(entry.summary)} and fix the underlying issue.`,
  };
}

function buildScriptCandidate(
  project: OrchestrationProject,
  script: OrchestrationProject["scripts"][number],
): SuggestionCandidate {
  return {
    id: `script:${project.id}:${script.id}`,
    priority: 48,
    prompt: `Run ${quoteTitle(script.name)} for ${project.title} and fix any failures.`,
  };
}

function buildThreadCandidate(thread: OrchestrationThread): SuggestionCandidate {
  return {
    id: `thread:${thread.id}`,
    priority: 40,
    prompt: `Pick up ${quoteTitle(thread.title)} from a fresh thread and move it forward.`,
  };
}

function buildStoredThreadCandidate(thread: CodexStoredThreadSummary): SuggestionCandidate | null {
  const preview = trimSuggestionPrompt(thread.preview ?? "");
  if (!preview) {
    return null;
  }

  return {
    id: `codex-thread:${thread.id}`,
    priority: 36,
    prompt: `Pick up ${quoteTitle(preview)} from a fresh thread and move it forward.`,
  };
}

function toServerSuggestions(
  candidates: readonly SuggestionCandidate[],
): ServerNewThreadSuggestionCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    prompt: candidate.prompt,
  }));
}

function resolveProjectForCwd(
  snapshot: OrchestrationReadModel,
  cwd: string,
): OrchestrationProject | null {
  const directMatch =
    snapshot.projects.find((project) => project.deletedAt === null && project.workspaceRoot === cwd) ?? null;
  if (directMatch) {
    return directMatch;
  }

  const matchingThread = snapshot.threads.find(
    (thread) => thread.deletedAt === null && thread.worktreePath === cwd,
  );
  if (!matchingThread) {
    return null;
  }

  return (
    snapshot.projects.find(
      (project) => project.deletedAt === null && project.id === matchingThread.projectId,
    ) ?? null
  );
}

function collectBaselineCandidates(input: {
  readonly snapshot: OrchestrationReadModel;
  readonly project: OrchestrationProject | null;
  readonly errorInboxEntries: ReadonlyArray<ErrorInboxEntry>;
}): SuggestionCandidate[] {
  if (!input.project) {
    return [];
  }

  const candidates: SuggestionCandidate[] = [];
  const seenPrompts = new Set<string>();
  const runtimeByTaskId = new Map(
    input.snapshot.taskRuntimes.map((runtime) => [runtime.taskId, runtime] as const),
  );
  const projectTasks = input.snapshot.tasks
    .filter((task) => task.deletedAt === null && task.projectId === input.project?.id && task.state !== "done")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const projectTaskIds = new Set(projectTasks.map((task) => task.id));
  const projectThreads = input.snapshot.threads
    .filter((thread) => thread.deletedAt === null && thread.projectId === input.project?.id)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const projectThreadIds = new Set(projectThreads.map((thread) => thread.id));
  const unresolvedErrors = input.errorInboxEntries
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

  for (const task of projectTasks) {
    pushCandidate(candidates, seenPrompts, buildTaskCandidate(task, runtimeByTaskId.get(task.id) ?? null));
  }

  for (const entry of unresolvedErrors) {
    if (entry.linkedTaskId && projectTaskIds.has(entry.linkedTaskId)) {
      continue;
    }
    pushCandidate(candidates, seenPrompts, buildErrorCandidate(entry));
  }

  for (const script of input.project.scripts) {
    pushCandidate(candidates, seenPrompts, buildScriptCandidate(input.project, script));
  }

  for (const thread of projectThreads) {
    if (thread.origin === "task") {
      continue;
    }
    pushCandidate(candidates, seenPrompts, buildThreadCandidate(thread));
  }

  return candidates;
}

function normalizeReviewLine(line: string): string {
  return trimSuggestionPrompt(
    line
      .replace(/^[*-]\s+/, "")
      .replace(/\s+[—-]\s+[A-Za-z0-9_./\\-]+:\d+(?::\d+)?$/, "")
      .replace(/`/g, ""),
  );
}

function toReviewPrompt(line: string): string {
  const normalized = normalizeReviewLine(line);
  if (!normalized) {
    return "";
  }

  const capitalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  const prompt = capitalized.endsWith(".")
    ? capitalized.slice(0, -1)
    : capitalized;
  return prompt.length <= 96 ? prompt : `${prompt.slice(0, 93).trimEnd()}...`;
}

function extractReviewCandidates(reviewText: string): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  const seenPrompts = new Set<string>();
  const bulletLines = reviewText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[*-]\s+/.test(line));

  for (const [index, line] of bulletLines.entries()) {
    const prompt = toReviewPrompt(line);
    if (!prompt) {
      continue;
    }
    pushCandidate(candidates, seenPrompts, {
      id: `review:${index + 1}`,
      priority: 120 - index,
      prompt,
    });
    if (candidates.length >= 3) {
      break;
    }
  }

  return candidates;
}

function buildSkillContext(skills: ReadonlyArray<CodexStoredSkillSummary>): string[] {
  return skills
    .map((skill) => {
      const label = skill.displayName ?? skill.name;
      const description = skill.shortDescription ?? skill.description;
      return description ? `${label}: ${description}` : label;
    })
    .filter((entry) => entry.trim().length > 0);
}

function buildThreadContext(threads: ReadonlyArray<CodexStoredThreadSummary>): string[] {
  return threads
    .map((thread) => trimSuggestionPrompt(thread.preview ?? ""))
    .filter((preview) => preview.length > 0)
    .slice(0, 5);
}

function buildGitStatusFallbackCandidates(gitStatus: GitStatusResult): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  const seenPrompts = new Set<string>();
  const topFiles = gitStatus.workingTree.files.slice(0, 3);

  if (gitStatus.hasWorkingTreeChanges) {
    pushCandidate(candidates, seenPrompts, {
      id: "git:dirty-review",
      priority: 84,
      prompt: "Review the current uncommitted changes and fix the highest-risk issue.",
    });

    const primaryFile = topFiles[0]?.path;
    if (primaryFile) {
      pushCandidate(candidates, seenPrompts, {
        id: "git:primary-file",
        priority: 80,
        prompt: `Finish the current changes in "${primaryFile}" and leave them reviewable.`,
      });
    }

    pushCandidate(candidates, seenPrompts, {
      id: "git:validation",
      priority: 76,
      prompt: "Validate the current diff locally and fix any failures before the next turn.",
    });
  } else if (gitStatus.aheadCount > 0) {
    pushCandidate(candidates, seenPrompts, {
      id: "git:ahead",
      priority: 52,
      prompt: "Review what is ahead of upstream and prepare the next safe shipping step.",
    });
  }

  return candidates;
}

function isDiffAwareCandidateId(id: string): boolean {
  return id.startsWith("review:") || id.startsWith("git:");
}

function ensureDirtyWorkingTreeCoverage(input: {
  readonly suggestions: ReadonlyArray<ServerNewThreadSuggestionCandidate>;
  readonly candidatePool: ReadonlyArray<SuggestionCandidate>;
  readonly gitStatus: GitStatusResult;
}): ServerSuggestNewThreadTasksResult {
  if (!input.gitStatus.hasWorkingTreeChanges || input.suggestions.length === 0) {
    return { suggestions: [...input.suggestions] };
  }

  if (input.suggestions.some((suggestion) => isDiffAwareCandidateId(suggestion.id))) {
    return { suggestions: [...input.suggestions] };
  }

  const diffCandidate = input.candidatePool
    .toSorted((left, right) => right.priority - left.priority)
    .find((candidate) => isDiffAwareCandidateId(candidate.id));
  if (!diffCandidate) {
    return { suggestions: [...input.suggestions] };
  }

  if (input.suggestions.some((suggestion) => suggestion.id === diffCandidate.id)) {
    return { suggestions: [...input.suggestions] };
  }

  const merged = [...input.suggestions];
  merged[merged.length - 1] = {
    id: diffCandidate.id,
    prompt: diffCandidate.prompt,
  };
  return { suggestions: merged };
}

function readProviderThreadIdFromResumeCursor(resumeCursor: unknown): string | null {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return null;
  }
  const threadId = (resumeCursor as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : null;
}

async function waitForReviewText(input: {
  readonly codexAdapter: Pick<CodexSuggestionRuntime, "readStoredThread">;
  readonly reviewThreadId: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<string | null> {
  const deadline = Date.now() + (input.timeoutMs ?? REVIEW_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const snapshot = await input.codexAdapter.readStoredThread({
      providerThreadId: input.reviewThreadId,
      cwd: input.cwd,
      includeTurns: true,
    });

    const reviewText = extractReviewTextFromThread(snapshot.turns);
    if (reviewText) {
      return reviewText;
    }

    await new Promise((resolve) => setTimeout(resolve, REVIEW_POLL_INTERVAL_MS));
  }

  return null;
}

function extractReviewTextFromThread(
  turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>,
): string | null {
  for (const turn of turns.toReversed()) {
    for (const itemValue of turn.items.toReversed()) {
      if (!itemValue || typeof itemValue !== "object") {
        continue;
      }
      const item = itemValue as Record<string, unknown>;
      if (item.type !== "exitedReviewMode") {
        continue;
      }
      const review = item.review;
      if (typeof review === "string" && review.trim().length > 0) {
        return review.trim();
      }
    }
  }

  return null;
}

async function collectCodexReviewCandidates(input: {
  readonly codexAdapter: Pick<
    CodexSuggestionRuntime,
    "archiveStoredThread" | "listSessions" | "listStoredThreads" | "readStoredThread" | "startReview" | "startSession" | "stopSession"
  >;
  readonly cwd: string;
  readonly selectedModel: string | null | undefined;
}): Promise<ReadonlyArray<SuggestionCandidate>> {
  const activeSession = (await input.codexAdapter.listSessions()).find((session) => session.cwd === input.cwd);
  const activeProviderThreadId = activeSession
    ? readProviderThreadIdFromResumeCursor(activeSession.resumeCursor)
    : null;
  const storedThreads = activeProviderThreadId
    ? await input.codexAdapter.listStoredThreads({ cwd: input.cwd, limit: 10 })
    : await input.codexAdapter.listStoredThreads({ cwd: input.cwd, limit: 10 });
  const reusableStoredThreadId = storedThreads[0]?.id ?? null;

  if (activeProviderThreadId || reusableStoredThreadId) {
    const sourceThreadId = activeProviderThreadId ?? reusableStoredThreadId;
    if (!sourceThreadId) {
      return [];
    }

    let reviewThreadId: string | null = null;
    try {
      const reviewStart = await input.codexAdapter.startReview({
        providerThreadId: sourceThreadId,
        cwd: input.cwd,
        target: { type: "uncommittedChanges" },
        delivery: "detached",
      });
      reviewThreadId = reviewStart.reviewThreadId;
      const reviewText = await waitForReviewText({
        codexAdapter: input.codexAdapter,
        reviewThreadId,
        cwd: input.cwd,
      });
      return reviewText ? extractReviewCandidates(reviewText) : [];
    } finally {
      if (reviewThreadId && reviewThreadId !== sourceThreadId) {
        await input.codexAdapter
          .archiveStoredThread({ providerThreadId: reviewThreadId, cwd: input.cwd })
          .catch(() => undefined);
      }
    }
  }

  const helperThreadId = ThreadId.makeUnsafe(`codex-suggestion-${crypto.randomUUID()}`);
  let helperProviderThreadId: string | null = null;
  try {
    const helperSession = await input.codexAdapter.startSession({
      threadId: helperThreadId,
      provider: "codex",
      cwd: input.cwd,
      runtimeMode: "full-access",
      ...(input.selectedModel ? { model: input.selectedModel } : {}),
    });
    helperProviderThreadId = readProviderThreadIdFromResumeCursor(helperSession.resumeCursor);
    if (!helperProviderThreadId) {
      return [];
    }

    const reviewStart = await input.codexAdapter.startReview({
      providerThreadId: helperProviderThreadId,
      cwd: input.cwd,
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    const reviewText = await waitForReviewText({
      codexAdapter: input.codexAdapter,
      reviewThreadId: reviewStart.reviewThreadId,
      cwd: input.cwd,
    });
    return reviewText ? extractReviewCandidates(reviewText) : [];
  } finally {
    if (helperProviderThreadId) {
      await input.codexAdapter
        .archiveStoredThread({ providerThreadId: helperProviderThreadId, cwd: input.cwd })
        .catch(() => undefined);
    }
    await input.codexAdapter.stopSession(helperThreadId).catch(() => undefined);
  }
}

function mergeCandidates(
  primary: readonly SuggestionCandidate[],
  fallback: readonly SuggestionCandidate[],
  limit = 6,
): SuggestionCandidate[] {
  const merged: SuggestionCandidate[] = [];
  const seenPrompts = new Set<string>();

  for (const candidate of [...primary, ...fallback]) {
    pushCandidate(merged, seenPrompts, candidate);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

async function buildCodexSuggestionBundle(input: {
  readonly baseCandidates: readonly SuggestionCandidate[];
  readonly codexAdapter: Pick<
    CodexSuggestionRuntime,
    "archiveStoredThread" | "listSessions" | "listStoredSkills" | "listStoredThreads" | "readStoredThread" | "startReview" | "startSession" | "stopSession"
  >;
  readonly cwd: string;
  readonly gitStatus: GitStatusResult;
  readonly selectedModel: string | null | undefined;
}): Promise<{
  readonly candidates: ReadonlyArray<SuggestionCandidate>;
  readonly context: SuggestionContext;
}> {
  const [skills, storedThreads] = await Promise.all([
    input.codexAdapter.listStoredSkills({ cwd: input.cwd, forceReload: false }).catch(() => []),
    input.codexAdapter.listStoredThreads({ cwd: input.cwd, limit: 10 }).catch(() => []),
  ]);

  if (input.gitStatus.hasWorkingTreeChanges) {
    const gitFallbackCandidates = buildGitStatusFallbackCandidates(input.gitStatus);
    const reviewCandidates = await collectCodexReviewCandidates({
      codexAdapter: input.codexAdapter,
      cwd: input.cwd,
      selectedModel: input.selectedModel,
    }).catch(() => []);
    const fallbackCandidates = mergeCandidates(gitFallbackCandidates, input.baseCandidates);
    return {
      candidates: mergeCandidates(reviewCandidates, fallbackCandidates),
      context: {
        dirtyWorkingTree: true,
        recentCodexThreads: buildThreadContext(storedThreads),
        skills: buildSkillContext(skills),
      },
    };
  }

  const storedThreadCandidates = storedThreads
    .flatMap((thread) => {
      const candidate = buildStoredThreadCandidate(thread);
      return candidate ? [candidate] : [];
    })
    .slice(0, 3);

  return {
    candidates: mergeCandidates(input.baseCandidates, storedThreadCandidates),
    context: {
      dirtyWorkingTree: false,
      recentCodexThreads: buildThreadContext(storedThreads),
      skills: buildSkillContext(skills),
    },
  };
}

function normalizeSuggestedTasks(input: {
  readonly rawText: string;
  readonly fallbackCandidates: ReadonlyArray<ServerNewThreadSuggestionCandidate>;
}): ServerSuggestNewThreadTasksResult {
  const fallbackById = new Map(input.fallbackCandidates.map((candidate) => [candidate.id, candidate]));
  const rawJson = extractJsonPayload(input.rawText);
  const parsed = JSON.parse(rawJson) as {
    suggestions?: Array<{ id?: unknown; prompt?: unknown }>;
  };

  const suggestions: ServerNewThreadSuggestionCandidate[] = [];
  const seenIds = new Set<string>();

  for (const candidate of parsed.suggestions ?? []) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
    if (id.length === 0 || prompt.length === 0 || seenIds.has(id) || !fallbackById.has(id)) {
      continue;
    }

    seenIds.add(id);
    suggestions.push({ id, prompt });
    if (suggestions.length >= 3) {
      break;
    }
  }

  if (suggestions.length === 0) {
    throw new Error("Suggestion model returned no valid suggestions.");
  }

  return { suggestions };
}

function buildSuggestionPrompt(input: ServerSuggestNewThreadTasksInput & {
  readonly candidates: ReadonlyArray<ServerNewThreadSuggestionCandidate>;
  readonly context?: SuggestionContext;
}): string {
  const sections = [
    `Project: ${input.projectName}`,
    "",
    "Pick the three most useful next coding tasks for a new thread in this repo.",
    "Return JSON only with this shape:",
    '{"suggestions":[{"id":"candidate-id","prompt":"short actionable task"}]}',
    "",
    "Rules:",
    "- Choose at most 3 candidates.",
    "- Keep each prompt direct, specific, and under 90 characters when possible.",
    "- Prefer impactful engineering work: fix failures, unblock tasks, or start the best next slice.",
    "- Do not invent new ids.",
  ];

  if (input.context?.dirtyWorkingTree !== undefined) {
    sections.push("", `Working tree dirty: ${input.context.dirtyWorkingTree ? "yes" : "no"}`);
  }

  if (input.context?.recentCodexThreads?.length) {
    sections.push("", "Recent same-project Codex threads:", ...input.context.recentCodexThreads.map((thread) => `- ${thread}`));
  }

  if (input.context?.skills?.length) {
    sections.push("", "Project skills and local guidance:", ...input.context.skills.map((skill) => `- ${skill}`));
  }

  if (input.context?.reviewText) {
    sections.push("", "Review context:", input.context.reviewText);
  }

  sections.push("", "Candidates:", ...input.candidates.map((candidate) => `- ${candidate.id}: ${candidate.prompt}`));
  return sections.join("\n");
}

function buildClaudeSuggestionUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  } as unknown as SDKUserMessage;
}

async function* buildClaudeSuggestionPromptStream(text: string): AsyncIterable<SDKUserMessage> {
  yield buildClaudeSuggestionUserMessage(text);
}

function extractClaudeAssistantText(messages: ReadonlyArray<SDKMessage>): string {
  return messages
    .flatMap((message) => {
      if (message.type !== "assistant") {
        return [];
      }
      const content = message.message?.content;
      if (!Array.isArray(content)) {
        return [];
      }
      return content.flatMap((block) => {
        if (!block || typeof block !== "object") {
          return [];
        }
        const candidate = block as { type?: unknown; text?: unknown };
        if (candidate.type !== "text" || typeof candidate.text !== "string") {
          return [];
        }
        return [candidate.text];
      });
    })
    .join("")
    .trim();
}

function extractClaudeResult(messages: ReadonlyArray<SDKMessage>): SDKResultMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "result") {
      return message;
    }
  }
  return null;
}

const denyClaudeSuggestionToolUse: CanUseTool = async () => ({
  behavior: "deny",
  message: "Tools are disabled for suggestion refinement.",
});

export function resolveSuggestionRefinementModel(selectedModel: string | null | undefined): {
  readonly provider: "claudeAgent" | "opencode";
  readonly selectedModel: string | null;
} {
  const normalizedSelectedModel = normalizeModelSlug(selectedModel);
  if (!normalizedSelectedModel) {
    return { provider: "opencode", selectedModel: null };
  }

  if (normalizedSelectedModel.startsWith("claude")) {
    return {
      provider: "claudeAgent",
      selectedModel: normalizedSelectedModel,
    };
  }

  if (normalizedSelectedModel.includes("/")) {
    return {
      provider: "opencode",
      selectedModel: normalizedSelectedModel,
    };
  }

  return {
    provider: "opencode",
    selectedModel: `openai/${normalizedSelectedModel}`,
  };
}

async function suggestWithClaude(
  input: ServerSuggestNewThreadTasksInput & {
    readonly candidates: ReadonlyArray<ServerNewThreadSuggestionCandidate>;
    readonly context?: SuggestionContext;
  },
): Promise<ServerSuggestNewThreadTasksResult> {
  const messages: SDKMessage[] = [];
  const options: ClaudeQueryOptions = {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.selectedModel ? { model: input.selectedModel } : {}),
    pathToClaudeCodeExecutable: "claude",
    permissionMode: "plan",
    includePartialMessages: true,
    canUseTool: denyClaudeSuggestionToolUse,
    env: process.env,
    ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
  };

  for await (const message of query({
    prompt: buildClaudeSuggestionPromptStream(buildSuggestionPrompt(input)),
    options,
  })) {
    messages.push(message);
  }

  const result = extractClaudeResult(messages);
  if (result && result.subtype !== "success") {
    throw new Error(result.errors[0] ?? "Claude suggestion refinement failed.");
  }

  return normalizeSuggestedTasks({
    rawText: extractClaudeAssistantText(messages),
    fallbackCandidates: input.candidates,
  });
}

async function suggestWithOpencode(
  input: ServerSuggestNewThreadTasksInput & {
    readonly candidates: ReadonlyArray<ServerNewThreadSuggestionCandidate>;
    readonly context?: SuggestionContext;
  },
): Promise<ServerSuggestNewThreadTasksResult> {
  const runtime = await getOpencodeRuntime();
  const session = await runtime.client.session.create({
    query: { directory: input.cwd },
    body: {
      title: "New-thread suggestions",
    },
    throwOnError: true,
  });

  try {
    const parsedModel = parseOpencodeModelSlug(input.selectedModel ?? null);
    const response = await runtime.client.session.prompt({
      path: { id: session.data.id },
      query: { directory: input.cwd },
      body: {
        ...(parsedModel
          ? {
              model: {
                providerID: parsedModel.providerID,
                modelID: parsedModel.modelID,
              },
            }
          : {}),
        system:
          "You rewrite and rank suggested coding tasks for a repo landing page. Respond with JSON only.",
        tools: {},
        parts: [
          {
            type: "text",
            text: buildSuggestionPrompt(input),
          },
        ],
      },
      throwOnError: true,
    });

    return normalizeSuggestedTasks({
      rawText: extractAssistantText(response.data.parts),
      fallbackCandidates: input.candidates,
    });
  } finally {
    await runtime.client.session.delete({
      path: { id: session.data.id },
      query: { directory: input.cwd },
      throwOnError: false,
    });
  }
}

export async function suggestNewThreadTasks(input: {
  readonly request: ServerSuggestNewThreadTasksInput;
  readonly snapshot: OrchestrationReadModel;
  readonly errorInboxEntries: ReadonlyArray<ErrorInboxEntry>;
  readonly gitStatus: GitStatusResult;
  readonly codexAdapter: Pick<
    CodexSuggestionRuntime,
    "archiveStoredThread" | "listSessions" | "listStoredSkills" | "listStoredThreads" | "readStoredThread" | "startReview" | "startSession" | "stopSession"
  >;
}): Promise<ServerSuggestNewThreadTasksResult> {
  const project = resolveProjectForCwd(input.snapshot, input.request.cwd);
  const baselineCandidates = collectBaselineCandidates({
    snapshot: input.snapshot,
    project,
    errorInboxEntries: input.errorInboxEntries,
  });
  const gitFallbackCandidates = buildGitStatusFallbackCandidates(input.gitStatus);
  const fallbackCandidates = input.gitStatus.hasWorkingTreeChanges
    ? mergeCandidates(gitFallbackCandidates, baselineCandidates)
    : mergeCandidates(baselineCandidates, gitFallbackCandidates);

  let candidateBundle: {
    readonly candidates: ReadonlyArray<SuggestionCandidate>;
    readonly context?: SuggestionContext;
  } = {
    candidates: fallbackCandidates,
  };

  if (input.request.provider === "codex") {
    candidateBundle = await buildCodexSuggestionBundle({
      baseCandidates: baselineCandidates,
      codexAdapter: input.codexAdapter,
      cwd: input.request.cwd,
      gitStatus: input.gitStatus,
      selectedModel: input.request.selectedModel,
    }).catch(() => ({
      candidates: fallbackCandidates,
      context: {
        dirtyWorkingTree: input.gitStatus.hasWorkingTreeChanges,
      },
    }));
  }

  const deterministicSuggestions = ensureDirtyWorkingTreeCoverage({
    suggestions: toServerSuggestions(
      candidateBundle.candidates
        .toSorted((left, right) => right.priority - left.priority)
        .slice(0, 3),
    ),
    candidatePool: candidateBundle.candidates,
    gitStatus: input.gitStatus,
  }).suggestions;

  if (deterministicSuggestions.length === 0) {
    return { suggestions: [] };
  }

  if (!input.request.selectedModel) {
    return { suggestions: deterministicSuggestions };
  }

  const modelSelection = resolveSuggestionRefinementModel(input.request.selectedModel);
  const refinementInput = {
    ...input.request,
    selectedModel: modelSelection.selectedModel,
    candidates: deterministicSuggestions,
    ...(candidateBundle.context ? { context: candidateBundle.context } : {}),
  };

  try {
    if (modelSelection.provider === "claudeAgent") {
      return ensureDirtyWorkingTreeCoverage({
        suggestions: (await suggestWithClaude(refinementInput)).suggestions,
        candidatePool: candidateBundle.candidates,
        gitStatus: input.gitStatus,
      });
    }
    return ensureDirtyWorkingTreeCoverage({
      suggestions: (await suggestWithOpencode(refinementInput)).suggestions,
      candidatePool: candidateBundle.candidates,
      gitStatus: input.gitStatus,
    });
  } catch {
    return { suggestions: deterministicSuggestions };
  }
}

export function collectServerNewThreadCandidatesForProject(input: {
  readonly snapshot: OrchestrationReadModel;
  readonly project: OrchestrationProject | null;
  readonly errorInboxEntries: ReadonlyArray<ErrorInboxEntry>;
}): ReadonlyArray<ServerNewThreadSuggestionCandidate> {
  return toServerSuggestions(collectBaselineCandidates(input));
}
