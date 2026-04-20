import type { Thread } from "../types";

const SUBAGENT_ACCENT_PALETTE = [
  "#b84e44",
  "#2f7a5d",
  "#345fa8",
  "#a86834",
  "#7352a8",
  "#2f7480",
  "#a84d71",
  "#6a8531",
] as const;

const GENERIC_SUBAGENT_TITLES = new Set([
  "",
  "agent",
  "chat",
  "child thread",
  "conversation",
  "new chat",
  "new conversation",
  "new thread",
  "subagent",
  "thread",
]);

type SubagentThreadLike = Pick<
  Thread,
  "id" | "title" | "model" | "parentThreadId" | "subagentAgentId" | "subagentNickname" | "subagentRole"
> & {
  session?: Thread["session"];
  latestTurn?: Thread["latestTurn"];
  activities?: Thread["activities"];
  messages?: Thread["messages"];
};

export interface SubagentPresentation {
  primaryLabel: string;
  nickname: string | null;
  role: string | null;
  title: string | null;
  fullLabel: string;
  accentColor: string;
}

function summarizeSubagentLabelText(text: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return null;
  }
  const firstSentence = normalized.split(/(?<=[.!?])\s+/, 1)[0] ?? normalized;
  if (firstSentence.length <= 72) {
    return firstSentence;
  }
  const truncated = firstSentence.slice(0, 69).trimEnd();
  const wordBoundary = truncated.lastIndexOf(" ");
  const collapsed =
    wordBoundary >= 40 ? truncated.slice(0, wordBoundary).trimEnd() : truncated;
  return `${collapsed}...`;
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeRole(role: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(role);
  return normalized ? normalized.toLowerCase() : null;
}

function basename(value: string): string {
  const slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slashIndex >= 0 ? value.slice(slashIndex + 1) : value;
}

function fallbackSubagentLabel(value: string | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("subagent:")) {
    const segments = normalized.split(":").filter((segment) => segment.length > 0);
    return segments.at(-1) ?? normalized;
  }
  return basename(normalized);
}

function isGenericSubagentTitle(title: string | null): boolean {
  if (!title) {
    return true;
  }
  const normalized = title.trim().toLowerCase();
  return GENERIC_SUBAGENT_TITLES.has(normalized) || normalized.startsWith("subagent ");
}

function parseBracketedSubagentLabel(label: string | null): {
  nickname: string | null;
  role: string | null;
} {
  if (!label) {
    return { nickname: null, role: null };
  }
  const match = /^(.*?)\s*\[([^\]]+)\]$/.exec(label.trim());
  if (!match) {
    return { nickname: null, role: null };
  }
  return {
    nickname: normalizeWhitespace(match[1] ?? null),
    role: normalizeRole(match[2] ?? null),
  };
}

function subagentAccentColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return SUBAGENT_ACCENT_PALETTE[Math.abs(hash) % SUBAGENT_ACCENT_PALETTE.length] ?? "#345fa8";
}

export function localSubagentThreadId(parentThreadId: string, providerThreadId: string): string {
  return `subagent:${parentThreadId}:${providerThreadId}`;
}

export function resolveSubagentPresentation(input: {
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  fallbackId?: string | null | undefined;
}): SubagentPresentation {
  const normalizedNickname = normalizeWhitespace(input.nickname);
  const normalizedRole = normalizeRole(input.role);
  const normalizedTitle = normalizeWhitespace(input.title);
  const parsedLabel = parseBracketedSubagentLabel(normalizedTitle);

  const nickname = normalizedNickname ?? parsedLabel.nickname;
  const role = normalizedRole ?? parsedLabel.role;
  const resolvedTitle = !isGenericSubagentTitle(normalizedTitle) ? normalizedTitle : null;
  const primaryLabel =
    nickname ??
    (resolvedTitle && (!parsedLabel.nickname || resolvedTitle !== parsedLabel.nickname)
      ? resolvedTitle
      : fallbackSubagentLabel(input.fallbackId ?? null) ?? "Subagent");
  const fullLabel =
    nickname && role ? `${nickname} [${role}]` : nickname ?? resolvedTitle ?? primaryLabel;

  return {
    primaryLabel,
    nickname,
    role,
    title: resolvedTitle,
    fullLabel,
    accentColor: subagentAccentColor(nickname ?? primaryLabel),
  };
}

export function resolveSubagentPresentationForThread(input: {
  thread: Pick<
    SubagentThreadLike,
    | "id"
    | "title"
    | "model"
    | "parentThreadId"
    | "subagentAgentId"
    | "subagentNickname"
    | "subagentRole"
    | "activities"
    | "messages"
  >;
}): SubagentPresentation {
  const latestUpdateFallback = isGenericSubagentTitle(input.thread.title)
    ? summarizeSubagentLabelText(deriveSubagentLatestUpdate(input.thread))
    : null;
  return resolveSubagentPresentation({
    nickname: input.thread.subagentNickname,
    role: input.thread.subagentRole,
    title: latestUpdateFallback ?? input.thread.title,
    fallbackId: input.thread.id,
  });
}

export function humanizeSubagentStatus(
  rawStatus: string | null | undefined,
  isActive = false,
): string | null {
  if (isActive) {
    return "Running";
  }
  const normalized = rawStatus?.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (!normalized) {
    return null;
  }
  if (normalized === "completed" || normalized === "done" || normalized === "success") {
    return "Completed";
  }
  if (normalized === "failed" || normalized === "error") {
    return "Failed";
  }
  if (normalized === "stopped" || normalized === "cancelled" || normalized === "canceled") {
    return "Stopped";
  }
  if (
    normalized === "running" ||
    normalized === "working" ||
    normalized === "in progress" ||
    normalized === "active"
  ) {
    return "Running";
  }
  if (normalized === "queued" || normalized === "pending" || normalized === "waiting") {
    return "Queued";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function deriveSubagentThreadStatus(thread: SubagentThreadLike | null | undefined): {
  rawStatus: string | null;
  statusLabel: string | null;
  isActive: boolean;
} {
  if (!thread) {
    return { rawStatus: null, statusLabel: null, isActive: false };
  }
  if (thread.session?.status === "running" || thread.session?.status === "connecting") {
    return { rawStatus: "running", statusLabel: "Running", isActive: true };
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { rawStatus: "failed", statusLabel: "Failed", isActive: false };
  }
  if (thread.latestTurn?.state === "completed") {
    return { rawStatus: "completed", statusLabel: "Completed", isActive: false };
  }
  return { rawStatus: null, statusLabel: null, isActive: false };
}

export function deriveSubagentLatestUpdate(thread: SubagentThreadLike | null | undefined): string | null {
  if (!thread) {
    return null;
  }
  for (let index = (thread.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = thread.messages?.[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const trimmed = message.text.trim();
    if (trimmed) {
      return trimmed.split(/\r?\n/, 1)[0]?.trim() ?? null;
    }
  }
  for (let index = (thread.activities?.length ?? 0) - 1; index >= 0; index -= 1) {
    const activity = thread.activities?.[index];
    if (!activity) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail =
      typeof payload?.detail === "string" && payload.detail.trim().length > 0
        ? payload.detail.trim()
        : null;
    if (detail) {
      return detail.split(/\r?\n/, 1)[0]?.trim() ?? null;
    }
    if (activity.summary.trim().length > 0) {
      return activity.summary;
    }
  }
  return null;
}
