// FILE: threadHandoff.ts
// Purpose: Thread handoff logic for transferring conversations between providers.
// Layer: UI state helpers
// Exports: handoff eligibility checks and message import helpers

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  OPENCODE_DEFAULT_MODEL_SLUG,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
} from "@t3tools/contracts";
import { type Thread } from "../types";
import { randomUUID } from "./utils";

const HANDOFF_PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "claudeAgent", "opencode"];

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

export function inferProviderFromModel(model: string): ProviderKind {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("claude")) {
    return "claudeAgent";
  }
  if (normalized === OPENCODE_DEFAULT_MODEL_SLUG || /^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return "opencode";
  }
  return "codex";
}

export function resolveHandoffTargetProviders(sourceProvider: ProviderKind): readonly ProviderKind[] {
  return HANDOFF_PROVIDER_ORDER.filter((provider) => provider !== sourceProvider);
}

export function resolveHandoffTargetProvider(sourceProvider: ProviderKind): ProviderKind {
  const [targetProvider] = resolveHandoffTargetProviders(sourceProvider);
  return targetProvider ?? "codex";
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

export function buildThreadHandoffImportedMessages(
  thread: Pick<Thread, "messages">,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return thread.messages.filter(isImportableThreadMessage).map((message: Thread["messages"][number] & { role: "user" | "assistant" }) => {
    const importedMessage: ThreadHandoffImportedMessage = {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    };
    const messageAttachments = message.attachments;
    const attachments =
      messageAttachments && messageAttachments.length > 0
        ? messageAttachments.map((attachment) => ({
            type: attachment.type,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          }))
        : null;
    return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
  });
}

// Used by: ChatView fork command gating.
export function hasTransferableThreadMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(isImportableThreadMessage);
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) => isImportableThreadMessage(message) && message.role === "assistant" && message.turnId !== null,
  );
}

export function canCreateThreadHandoff(input: {
  readonly thread: Pick<Thread, "handoff" | "messages" | "session">;
  readonly isBusy?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.isBusy || input.hasPendingApprovals || input.hasPendingUserInput) {
    return false;
  }
  const sessionStatus = input.thread.session?.orchestrationStatus;
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return false;
  }
  const importedMessages = buildThreadHandoffImportedMessages(input.thread);
  if (importedMessages.length === 0) {
    return false;
  }
  if (input.thread.handoff != null) {
    return hasNativeThreadHandoffMessages(input.thread);
  }
  return true;
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "model">;
  readonly targetProvider?: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const sourceProvider = inferProviderFromModel(input.sourceThread.model);
  const targetProvider = input.targetProvider ?? resolveHandoffTargetProvider(sourceProvider);
  const stickySelection = input.stickyModelSelectionByProvider[targetProvider];
  if (stickySelection) {
    return stickySelection;
  }
  if (input.projectDefaultModelSelection?.provider === targetProvider) {
    return input.projectDefaultModelSelection;
  }
  return {
    provider: targetProvider,
    model: DEFAULT_MODEL_BY_PROVIDER[targetProvider],
  };
}
