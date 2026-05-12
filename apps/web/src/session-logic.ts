import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "claudeAgent", label: "Claude Code", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  webSearchQueries?: ReadonlyArray<string>;
  webSearchUrls?: ReadonlyArray<string>;
  generatedImages?: ReadonlyArray<GeneratedImageArtifact>;
  invocationDiffFiles?: ReadonlyArray<InvocationDiffFile>;
  invocationDiffStat?: {
    additions: number;
    deletions: number;
  };
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  payload?: unknown;
  subagentAction?: {
    summaryText?: string;
    model?: string;
    prompt?: string;
  };
  subagents?: ReadonlyArray<{
    threadId: string;
    resolvedThreadId?: string;
    agentId?: string;
    nickname?: string;
    role?: string;
    title?: string;
    model?: string;
    rawStatus?: string;
    statusLabel?: string;
    latestUpdate?: string;
    isActive?: boolean;
  }>;
}

export interface GeneratedImageArtifact {
  path: string;
  cwd?: string;
  label: string;
  previewUrl?: string;
  providerThreadId?: string;
}

export interface InvocationDiffFile {
  path: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
  patch?: string;
  before?: string;
  after?: string;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function isLatestTurnSettled(
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt"> | null,
  session: Pick<ThreadSession, "orchestrationStatus" | "activeTurnId"> | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      detail?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  latestTurnInteractionMode: OrchestrationLatestTurn["interactionMode"] | undefined,
): ActivePlanState | null {
  if (!latestTurnId) {
    return null;
  }
  if (latestTurnInteractionMode !== "plan") {
    return null;
  }
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter(
    (activity) => activity.kind === "turn.plan.updated" && activity.turnId === latestTurnId,
  );
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => activity.kind !== "tool.started")
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.kind !== "approval.resolved")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isEmptyToolProgressActivity(activity))
    .filter((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      return extractWorkLogItemType(payload) !== "collab_agent_tool_call";
    })
    .map((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const command = extractToolCommand(payload);
      const toolOutput = extractToolOutput(payload);
      const webSearchQueries = extractWebSearchQueries(payload);
      const webSearchUrls = extractWebSearchUrls(payload);
      const generatedImages = extractGeneratedImageArtifacts(payload);
      const invocationDiffFiles = extractInvocationDiffFiles(payload);
      const title = extractToolTitle(payload);
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      const changedFiles =
        itemType === "file_change" || requestKind === "file-change"
          ? extractChangedFiles(payload)
          : [];
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        label: activity.summary,
        tone: activity.tone === "approval" ? "info" : activity.tone,
      };
      if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
        const detail = stripTrailingExitCode(payload.detail).output;
        if (detail) {
          entry.detail = detail;
        }
      }
      if (toolOutput) {
        entry.detail = toolOutput;
      }
      if (command) {
        entry.command = command;
      }
      if (changedFiles.length > 0) {
        entry.changedFiles = changedFiles;
      }
      if (itemType === "web_search" && webSearchQueries.length > 0) {
        entry.webSearchQueries = webSearchQueries;
      }
      if (itemType === "web_search" && webSearchUrls.length > 0) {
        entry.webSearchUrls = webSearchUrls;
      }
      if (generatedImages.length > 0) {
        entry.generatedImages = generatedImages;
      }
      if (invocationDiffFiles.length > 0) {
        entry.invocationDiffFiles = invocationDiffFiles;
        entry.invocationDiffStat = invocationDiffFiles.reduce(
          (acc, file) => ({
            additions: acc.additions + file.additions,
            deletions: acc.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        );
      }
      if (title) {
        entry.toolTitle = title;
      }
      if (itemType) {
        entry.itemType = itemType;
      }
      if (requestKind) {
        entry.requestKind = requestKind;
      }
      entry.payload = activity.payload;
      return entry;
    });
  return mergeWorkLogEntriesByProviderItem(entries);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function normalizeToolOutputValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => {
      const directEntry = asTrimmedString(entry);
      if (directEntry) return directEntry;
      const record = asRecord(entry);
      return (
        asTrimmedString(record?.text) ??
        asTrimmedString(record?.content) ??
        asTrimmedString(record?.output)
      );
    })
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const args = asRecord(payload?.args);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(dataInput?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(args?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const candidates = [
    normalizeToolOutputValue(itemResult?.output),
    normalizeToolOutputValue(itemResult?.stdout),
    normalizeToolOutputValue(itemResult?.stderr),
    normalizeToolOutputValue(item?.output),
    normalizeToolOutputValue(item?.stdout),
    normalizeToolOutputValue(item?.stderr),
    normalizeToolOutputValue(data?.output),
    normalizeToolOutputValue(data?.stdout),
    normalizeToolOutputValue(data?.stderr),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function pushUniqueString(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(normalized);
}

function collectValuesForKeys(
  value: unknown,
  target: string[],
  seen: Set<string>,
  keys: ReadonlySet<string>,
  depth: number,
): void {
  if (depth > 5 || target.length >= 24) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectValuesForKeys(entry, target, seen, keys, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const [key, candidate] of Object.entries(record)) {
    if (keys.has(key)) {
      if (Array.isArray(candidate)) {
        for (const entry of candidate) {
          pushUniqueString(target, seen, entry);
          collectValuesForKeys(entry, target, seen, keys, depth + 1);
        }
      } else {
        pushUniqueString(target, seen, candidate);
      }
    }
    if (
      key === "data" ||
      key === "item" ||
      key === "input" ||
      key === "result" ||
      key === "results" ||
      key === "content" ||
      key === "structuredContent"
    ) {
      collectValuesForKeys(candidate, target, seen, keys, depth + 1);
    }
  }
}

function extractWebSearchQueries(payload: Record<string, unknown> | null): string[] {
  const queries: string[] = [];
  collectValuesForKeys(
    payload,
    queries,
    new Set(),
    new Set(["q", "query", "queries", "searchQuery", "search_query"]),
    0,
  );
  return queries;
}

function extractWebSearchUrls(payload: Record<string, unknown> | null): string[] {
  const urls: string[] = [];
  collectValuesForKeys(payload, urls, new Set(), new Set(["url", "urls", "href", "link"]), 0);
  return urls.filter((url) => /^https?:\/\//i.test(url));
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  return (
    asTrimmedString(payload?.title) ??
    asTrimmedString(input?.description) ??
    asTrimmedString(data?.description)
  );
}

function providerItemIdFromWorkEntry(workEntry: WorkLogEntry): string | null {
  const payload = asRecord(workEntry.payload);
  const providerItemId = asTrimmedString(payload?.providerItemId);
  if (providerItemId) {
    return providerItemId;
  }
  const syntheticId = syntheticProviderItemIdFromPayload(payload);
  return syntheticId ? `${workEntry.turnId ?? "thread"}:${syntheticId}` : null;
}

function mergeStringArrays(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

function mergeInvocationDiffFiles(
  left: ReadonlyArray<InvocationDiffFile> | undefined,
  right: ReadonlyArray<InvocationDiffFile> | undefined,
): InvocationDiffFile[] {
  const merged = new Map<string, InvocationDiffFile>();
  for (const file of [...(left ?? []), ...(right ?? [])]) {
    merged.set(file.path, file);
  }
  return [...merged.values()];
}

function mergeWorkLogEntry(target: WorkLogEntry, source: WorkLogEntry): void {
  target.createdAt = source.createdAt;
  if (source.turnId !== undefined) {
    target.turnId = source.turnId;
  }
  target.label = source.label;
  target.tone = source.tone;
  if (!target.command && source.command) {
    target.command = source.command;
  }
  if (!target.toolTitle && source.toolTitle) {
    target.toolTitle = source.toolTitle;
  }
  if (!target.itemType && source.itemType) {
    target.itemType = source.itemType;
  }
  if (!target.requestKind && source.requestKind) {
    target.requestKind = source.requestKind;
  }
  target.payload = source.payload ?? target.payload;
  if (source.detail && source.detail !== source.command) {
    target.detail = source.detail;
  }
  const changedFiles = mergeStringArrays(target.changedFiles, source.changedFiles);
  if (changedFiles.length > 0) {
    target.changedFiles = changedFiles;
  }
  const webSearchQueries = mergeStringArrays(target.webSearchQueries, source.webSearchQueries);
  if (webSearchQueries.length > 0) {
    target.webSearchQueries = webSearchQueries;
  }
  const webSearchUrls = mergeStringArrays(target.webSearchUrls, source.webSearchUrls);
  if (webSearchUrls.length > 0) {
    target.webSearchUrls = webSearchUrls;
  }
  const invocationDiffFiles = mergeInvocationDiffFiles(
    target.invocationDiffFiles,
    source.invocationDiffFiles,
  );
  if (invocationDiffFiles.length > 0) {
    target.invocationDiffFiles = invocationDiffFiles;
    target.invocationDiffStat = invocationDiffFiles.reduce(
      (acc, file) => ({
        additions: acc.additions + file.additions,
        deletions: acc.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  }
  if ((source.generatedImages?.length ?? 0) > 0) {
    target.generatedImages = [...(target.generatedImages ?? []), ...(source.generatedImages ?? [])];
  }
  if ((source.subagents?.length ?? 0) > 0) {
    target.subagents = [...(target.subagents ?? []), ...(source.subagents ?? [])];
  }
}

function mergeWorkLogEntriesByProviderItem(entries: WorkLogEntry[]): WorkLogEntry[] {
  const merged: WorkLogEntry[] = [];
  const byProviderItemId = new Map<string, WorkLogEntry>();
  for (const entry of entries) {
    const providerItemId = providerItemIdFromWorkEntry(entry);
    if (!providerItemId) {
      merged.push(entry);
      continue;
    }
    const existing = byProviderItemId.get(providerItemId);
    if (existing) {
      mergeWorkLogEntry(existing, entry);
      continue;
    }
    byProviderItemId.set(providerItemId, entry);
    merged.push(entry);
  }
  return merged;
}

function normalizedToolNameFromPayload(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const toolName =
    asTrimmedString(data?.toolName) ??
    asTrimmedString(data?.name) ??
    asTrimmedString(payload?.toolName);
  return toolName ? toolName.toLowerCase().replace(/[^a-z0-9_-]/g, "") : null;
}

function toolInputFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  return asRecord(data?.input) ?? asRecord(payload?.args);
}

function isEmptyObject(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function isEmptyToolProgressActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  if (payload?.status !== "inProgress" && payload?.status !== "running") {
    return false;
  }
  const input = toolInputFromPayload(payload);
  if (!isEmptyObject(input)) {
    return false;
  }
  return !extractToolOutput(payload) && !asTrimmedString(payload?.detail);
}

function isCommandToolName(toolName: string | null): boolean {
  return (
    toolName === "bash" ||
    toolName === "shell" ||
    toolName === "powershell" ||
    toolName === "run_command" ||
    toolName === "runcommand" ||
    toolName === "execute_command" ||
    toolName === "executecommand" ||
    toolName === "exec"
  );
}

function isFileReadToolName(toolName: string | null): boolean {
  return (
    toolName === "read" ||
    toolName === "view" ||
    toolName === "open" ||
    toolName === "file_read" ||
    toolName === "fileread"
  );
}

function isFileChangeToolName(toolName: string | null): boolean {
  return (
    toolName === "edit" ||
    toolName === "write" ||
    toolName === "multiedit" ||
    toolName === "multi_edit" ||
    toolName === "apply_patch" ||
    toolName === "applypatch" ||
    toolName === "patch"
  );
}

function isWebSearchToolName(toolName: string | null): boolean {
  return (
    toolName === "web_search" ||
    toolName === "websearch" ||
    toolName === "search_web" ||
    toolName === "searchweb"
  );
}

function inferWorkLogItemTypeFromToolName(
  toolName: string | null,
): WorkLogEntry["itemType"] | undefined {
  if (isCommandToolName(toolName)) {
    return "command_execution";
  }
  if (isFileChangeToolName(toolName)) {
    return "file_change";
  }
  if (isWebSearchToolName(toolName)) {
    return "web_search";
  }
  return undefined;
}

function stableSignature(value: unknown, depth = 0): string {
  if (depth > 4) {
    return "[depth]";
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value.slice(0, 1_000));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSignature(entry, depth + 1)).join(",")}]`;
  }
  const record = asRecord(value);
  if (!record) {
    return typeof value;
  }
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableSignature(record[key], depth + 1)}`)
    .join(",")}}`;
}

function syntheticProviderItemIdFromPayload(payload: Record<string, unknown> | null): string | null {
  const toolName = normalizedToolNameFromPayload(payload);
  if (!toolName) {
    return null;
  }
  const input = toolInputFromPayload(payload);
  if (!input || isEmptyObject(input)) {
    return null;
  }
  return `tool:${toolName}:${stableSignature(input)}`;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  const explicitItemType =
    typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)
      ? payload.itemType
      : undefined;
  if (explicitItemType && explicitItemType !== "dynamic_tool_call") {
    return explicitItemType;
  }
  const inferredItemType = inferWorkLogItemTypeFromToolName(normalizedToolNameFromPayload(payload));
  if (inferredItemType) {
    return inferredItemType;
  }
  return explicitItemType;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  const toolName = normalizedToolNameFromPayload(payload);
  if (isCommandToolName(toolName)) {
    return "command";
  }
  if (isFileReadToolName(toolName)) {
    return "file-read";
  }
  if (isFileChangeToolName(toolName)) {
    return "file-change";
  }
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(payload?.data, changedFiles, seen, 0);
  collectChangedFiles(payload?.args, changedFiles, seen, 0);
  collectChangedFiles(payload?.resolution, changedFiles, seen, 0);
  return changedFiles;
}

const GENERATED_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);
const IMAGE_PATH_PATTERN =
  /(?:^|[\s`"'(])((?:[A-Za-z]:[\\/])?(?:[\w .@()[\]-]+[\\/])*[\w .@()[\]-]+\.(?:avif|bmp|gif|heic|jpe?g|png|webp))(?=$|[\s`"',).])/gi;

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).at(-1) ?? pathValue;
}

function extensionFromPath(pathValue: string): string {
  const filename = basenameFromPath(pathValue);
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return "";
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

function generatedImageLabelForPath(pathValue: string): string {
  const filename = basenameFromPath(pathValue);
  return /^ig_[\da-z]+(?:[._-][\da-z]+)?\.[\da-z]+$/i.test(filename) ? "Generated image" : filename;
}

function toGeneratedImageArtifact(pathValue: string): GeneratedImageArtifact | null {
  const trimmed = pathValue.trim().replace(/^[`"']|[`"']$/g, "");
  if (!GENERATED_IMAGE_EXTENSIONS.has(extensionFromPath(trimmed))) {
    return null;
  }
  const normalized = trimmed.replaceAll("\\", "/");
  const windowsAbsoluteMatch = /^([A-Za-z]:\/.*)\/([^/]+)$/.exec(normalized);
  if (windowsAbsoluteMatch) {
    const cwd = windowsAbsoluteMatch[1];
    const path = windowsAbsoluteMatch[2];
    if (!cwd || !path) return null;
    return {
      cwd,
      path,
      label: generatedImageLabelForPath(path),
    };
  }
  return {
    path: normalized,
    label: generatedImageLabelForPath(normalized),
  };
}

function pushGeneratedImageArtifact(
  target: GeneratedImageArtifact[],
  seen: Set<string>,
  pathValue: string,
  options?: { previewUrl?: string | undefined },
) {
  const artifact = toGeneratedImageArtifact(pathValue);
  if (!artifact) return;
  const key = `${artifact.cwd ?? ""}\u0000${artifact.path}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    ...artifact,
    ...(options?.previewUrl ? { previewUrl: options.previewUrl } : {}),
  });
}

function looksLikePngBase64(value: string): boolean {
  return value.startsWith("iVBORw0KGgo");
}

function codexGeneratedImageArtifactFromRecord(
  record: Record<string, unknown>,
): GeneratedImageArtifact | null {
  const item = asRecord(record.item) ?? record;
  const itemId = asTrimmedString(item.id);
  if (!itemId?.startsWith("ig_")) {
    return null;
  }

  const itemType = asTrimmedString(item.type)?.toLowerCase() ?? "";
  if (!itemType.includes("image")) {
    return null;
  }

  const providerThreadId = asTrimmedString(record.threadId);
  const result = asTrimmedString(item.result);
  const previewUrl =
    result && looksLikePngBase64(result) ? `data:image/png;base64,${result}` : null;
  if (!providerThreadId && !previewUrl) {
    return null;
  }

  const path = `${itemId}.png`;
  return {
    path,
    label: generatedImageLabelForPath(path),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

function collectGeneratedImageArtifacts(
  value: unknown,
  target: GeneratedImageArtifact[],
  seen: Set<string>,
  depth: number,
) {
  if (depth > 5 || target.length >= 8) {
    return;
  }

  if (typeof value === "string") {
    if (value.length > 8192) {
      pushGeneratedImageArtifact(target, seen, value);
      return;
    }
    for (const match of value.matchAll(IMAGE_PATH_PATTERN)) {
      const pathValue = match[1];
      if (pathValue) {
        pushGeneratedImageArtifact(target, seen, pathValue);
      }
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectGeneratedImageArtifacts(JSON.parse(trimmed), target, seen, depth + 1);
      } catch {
        // Tool outputs are often plain text; malformed JSON is fine here.
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectGeneratedImageArtifacts(entry, target, seen, depth + 1);
      if (target.length >= 8) return;
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  const codexArtifact = codexGeneratedImageArtifactFromRecord(record);
  if (codexArtifact) {
    const key = `${codexArtifact.cwd ?? ""}\u0000${codexArtifact.path}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      target.push(codexArtifact);
    }
  }

  for (const key of [
    "generatedImagePath",
    "generatedImagePaths",
    "artifactPath",
    "artifactPaths",
    "outputPath",
    "outputPaths",
    "outputs",
    "path",
    "filePath",
    "relativePath",
    "url",
  ]) {
    if (key in record) {
      collectGeneratedImageArtifacts(record[key], target, seen, depth + 1);
    }
  }

  for (const key of ["data", "item", "result", "structuredContent", "output", "content"]) {
    if (key in record) {
      collectGeneratedImageArtifacts(record[key], target, seen, depth + 1);
    }
  }
}

export function extractGeneratedImageArtifacts(
  payload: Record<string, unknown> | null,
): GeneratedImageArtifact[] {
  const artifacts: GeneratedImageArtifact[] = [];
  const seen = new Set<string>();
  collectGeneratedImageArtifacts(payload, artifacts, seen, 0);
  return artifacts;
}

function normalizeInvocationDiffStatus(value: unknown): InvocationDiffFile["status"] | undefined {
  if (value === "added" || value === "deleted" || value === "modified") {
    return value;
  }
  return undefined;
}

function toInvocationDiffFile(value: unknown): InvocationDiffFile | null {
  const record = asRecord(value);
  if (!record) return null;
  const path =
    asTrimmedString(record.path) ??
    asTrimmedString(record.file) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.relativePath);
  if (!path) return null;
  const additions = typeof record.additions === "number" ? record.additions : null;
  const deletions = typeof record.deletions === "number" ? record.deletions : null;
  const status = normalizeInvocationDiffStatus(record.status);
  const patch = asTrimmedString(record.patch) ?? asTrimmedString(record.diff) ?? undefined;
  const before = typeof record.before === "string" ? record.before : undefined;
  const after = typeof record.after === "string" ? record.after : undefined;
  const hasStats = additions !== null || deletions !== null;
  const hasRenderableDiff = Boolean(patch || before !== undefined || after !== undefined);
  if (!hasStats && !hasRenderableDiff) return null;

  return {
    path,
    additions: additions ?? 0,
    deletions: deletions ?? 0,
    ...(status ? { status } : {}),
    ...(patch ? { patch } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

function extractInvocationDiffFiles(payload: Record<string, unknown> | null): InvocationDiffFile[] {
  const data = asRecord(payload?.data);
  const diff = asRecord(data?.diff);
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const normalized: InvocationDiffFile[] = [];
  const seen = new Set<string>();
  for (const fileCandidate of files) {
    const file = toInvocationDiffFile(fileCandidate);
    if (!file) continue;
    const key = `${file.path}:${file.additions}:${file.deletions}:${file.patch ?? ""}:${file.before ?? ""}:${file.after ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(file);
  }
  return normalized;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function deriveRevertTurnCountByUserMessageId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Readonly<Record<TurnId, number>>,
): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
      const nextEntry = timelineEntries[nextIndex];
      if (!nextEntry || nextEntry.kind !== "message") {
        continue;
      }
      if (nextEntry.message.role === "user") {
        break;
      }

      const summary =
        turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id) ??
        (nextEntry.message.turnId
          ? turnDiffSummaryByTurnId.get(nextEntry.message.turnId)
          : undefined);
      if (!summary) {
        continue;
      }

      const turnCount =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof turnCount !== "number") {
        break;
      }

      byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
      break;
    }
  }

  return byUserMessageId;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
