// FILE: taskCompletion.logic.ts
// Purpose: Detects desktop-notification-worthy thread transitions and builds copy/payloads.
// Layer: Notification logic
// Exports: notification candidate detection and payload/copy helpers

import type {
  DesktopApprovalRequiredNotificationInput,
  DesktopNotificationPayload,
  DesktopNotificationQuestion,
  DesktopTurnCompletedNotificationInput,
  DesktopUserInputRequiredNotificationInput,
} from "@t3tools/contracts";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "../session-logic";
import type { Thread, ThreadSession } from "../types";

export interface CompletedThreadCandidate {
  kind: "turn_completed";
  notificationId: string;
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  completedAt: string;
  assistantSummary: string | null;
}

export interface ApprovalRequiredCandidate {
  kind: "approval_required";
  notificationId: string;
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  requestId: PendingApproval["requestId"];
  requestKind: PendingApproval["requestKind"];
  detail?: string;
}

export interface UserInputRequiredCandidate {
  kind: "user_input_required";
  notificationId: string;
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  requestId: PendingUserInput["requestId"];
  questions: ReadonlyArray<DesktopNotificationQuestion>;
}

export type DesktopNotificationCandidate =
  | CompletedThreadCandidate
  | ApprovalRequiredCandidate
  | UserInputRequiredCandidate;

type ThreadSessionStatus = ThreadSession["status"];
const COMPLETION_BODY_MAX_LENGTH = 120;
const APPROVAL_BODY_MAX_LENGTH = 110;
const INPUT_BODY_MAX_LENGTH = 110;

function isRunningStatus(status: ThreadSessionStatus | null | undefined): boolean {
  return status === "running" || status === "connecting";
}

function normalizeNotificationBodyText(input: string, maxLength: number): string {
  const flattened = input
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= maxLength) {
    return flattened;
  }

  const truncated = flattened.slice(0, Math.max(0, maxLength - 3)).trimEnd();
  return `${truncated}...`;
}

function summarizeLatestAssistantMessage(thread: Thread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const trimmed = normalizeNotificationBodyText(message.text, COMPLETION_BODY_MAX_LENGTH);
    if (trimmed.length === 0) {
      continue;
    }
    return trimmed;
  }
  return null;
}

function toDesktopNotificationQuestions(
  questions: ReadonlyArray<PendingUserInput["questions"][number]>,
): ReadonlyArray<DesktopNotificationQuestion> {
  return questions.map((question, questionIndex) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option, optionIndex) => ({
      id: `q${questionIndex}-o${optionIndex}`,
      label: option.label,
      description: option.description,
    })),
  }));
}

export function collectCompletedThreadCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: CompletedThreadCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }
    if (!isRunningStatus(previousThread.session?.status)) {
      continue;
    }
    if (isRunningStatus(thread.session?.status)) {
      continue;
    }

    const completedAt = thread.latestTurn?.completedAt;
    if (!completedAt || completedAt === previousThread.latestTurn?.completedAt) {
      continue;
    }

    candidates.push({
      kind: "turn_completed",
      notificationId: `turn-completed:${thread.id}:${completedAt}`,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      completedAt,
      assistantSummary: summarizeLatestAssistantMessage(thread),
    });
  }

  return candidates;
}

export function collectApprovalRequestCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): ApprovalRequiredCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: ApprovalRequiredCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    const previousRequestIds = new Set(
      previousThread ? derivePendingApprovals(previousThread.activities).map((entry) => entry.requestId) : [],
    );

    for (const approval of derivePendingApprovals(thread.activities)) {
      if (previousRequestIds.has(approval.requestId)) {
        continue;
      }
      candidates.push({
        kind: "approval_required",
        notificationId: `approval-required:${thread.id}:${approval.requestId}`,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: approval.requestId,
        requestKind: approval.requestKind,
        ...(approval.detail ? { detail: approval.detail } : {}),
      });
    }
  }

  return candidates;
}

export function collectUserInputRequestCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): UserInputRequiredCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: UserInputRequiredCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    const previousRequestIds = new Set(
      previousThread
        ? derivePendingUserInputs(previousThread.activities).map((entry) => entry.requestId)
        : [],
    );

    for (const userInput of derivePendingUserInputs(thread.activities)) {
      if (previousRequestIds.has(userInput.requestId)) {
        continue;
      }
      candidates.push({
        kind: "user_input_required",
        notificationId: `user-input-required:${thread.id}:${userInput.requestId}`,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: userInput.requestId,
        questions: toDesktopNotificationQuestions(userInput.questions),
      });
    }
  }

  return candidates;
}

function normalizeThreadLabel(title: string): string {
  const normalizedTitle = title.trim();
  return normalizedTitle.length > 0 ? normalizedTitle : "Untitled thread";
}

export function buildTaskCompletionCopy(candidate: CompletedThreadCandidate): {
  title: string;
  body: string;
} {
  const threadLabel = normalizeThreadLabel(candidate.title);

  return {
    title: threadLabel,
    body: candidate.assistantSummary ? candidate.assistantSummary : "Finished working.",
  };
}

export function buildApprovalRequiredCopy(candidate: ApprovalRequiredCandidate): {
  title: string;
  body: string;
} {
  const threadLabel = normalizeThreadLabel(candidate.title);
  const requestLabel =
    candidate.requestKind === "command"
      ? "Command approval needed"
      : candidate.requestKind === "file-read"
        ? "File-read approval needed"
        : "File-change approval needed";
  return {
    title: threadLabel,
    body: candidate.detail
      ? normalizeNotificationBodyText(`Approval needed: ${candidate.detail}`, APPROVAL_BODY_MAX_LENGTH)
      : requestLabel,
  };
}

export function buildUserInputRequiredCopy(candidate: UserInputRequiredCandidate): {
  title: string;
  body: string;
} {
  const threadLabel = normalizeThreadLabel(candidate.title);
  const firstQuestion = candidate.questions[0];
  if (!firstQuestion) {
    return {
      title: threadLabel,
      body: "Input needed.",
    };
  }
  if (candidate.questions.length === 1) {
    return {
      title: threadLabel,
      body: normalizeNotificationBodyText(
        `${firstQuestion.header}: ${firstQuestion.question}`,
        INPUT_BODY_MAX_LENGTH,
      ),
    };
  }
  return {
    title: threadLabel,
    body: normalizeNotificationBodyText(
      `${firstQuestion.header}: ${firstQuestion.question} (+${candidate.questions.length - 1} more)`,
      INPUT_BODY_MAX_LENGTH,
    ),
  };
}

export function buildDesktopNotificationPayload(
  candidate: DesktopNotificationCandidate,
): DesktopNotificationPayload {
  if (candidate.kind === "turn_completed") {
    const copy = buildTaskCompletionCopy(candidate);
    return {
      kind: "turn_completed",
      notificationId: candidate.notificationId,
      threadId: candidate.threadId,
      projectId: candidate.projectId,
      title: copy.title,
      body: copy.body,
      silent: false,
    } satisfies DesktopTurnCompletedNotificationInput;
  }

  if (candidate.kind === "approval_required") {
    const copy = buildApprovalRequiredCopy(candidate);
    return {
      kind: "approval_required",
      notificationId: candidate.notificationId,
      threadId: candidate.threadId,
      projectId: candidate.projectId,
      title: copy.title,
      body: copy.body,
      silent: false,
      requestId: candidate.requestId,
      requestKind: candidate.requestKind,
      ...(candidate.detail ? { detail: candidate.detail } : {}),
    } satisfies DesktopApprovalRequiredNotificationInput;
  }

  const copy = buildUserInputRequiredCopy(candidate);
  return {
    kind: "user_input_required",
    notificationId: candidate.notificationId,
    threadId: candidate.threadId,
    projectId: candidate.projectId,
    title: copy.title,
    body: copy.body,
    silent: false,
    requestId: candidate.requestId,
    questions: candidate.questions,
  } satisfies DesktopUserInputRequiredNotificationInput;
}
