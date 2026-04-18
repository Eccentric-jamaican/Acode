import type { ThreadId } from "@t3tools/contracts";
import type { DraftThreadState } from "../composerDraftStore";

interface ComposerDraftForDisposalCheck {
  prompt?: string;
  images?: ReadonlyArray<unknown>;
  persistedAttachments?: ReadonlyArray<unknown>;
  pinnedSelections?: ReadonlyArray<unknown>;
}

export function isComposerDraftEmptyForDisposal(
  draft: ComposerDraftForDisposalCheck | null | undefined,
): boolean {
  if (!draft) {
    return true;
  }
  return (
    (draft.prompt?.trim().length ?? 0) === 0 &&
    (draft.images?.length ?? 0) === 0 &&
    (draft.persistedAttachments?.length ?? 0) === 0 &&
    (draft.pinnedSelections?.length ?? 0) === 0
  );
}

export function resolveDisposableThreadIdToDispose(input: {
  previousThreadId: ThreadId | null;
  nextThreadId: ThreadId | null;
  previousThreadWasTemporary?: boolean;
  draftThreadsByThreadId: Record<string, DraftThreadState | undefined>;
  previousThreadHasServerThread?: boolean;
  composerDraftsByThreadId?: Record<string, ComposerDraftForDisposalCheck | undefined>;
}): ThreadId | null {
  const previousThreadId = input.previousThreadId;
  if (!previousThreadId || !input.nextThreadId || previousThreadId === input.nextThreadId) {
    return null;
  }

  const previousDraftThread = input.draftThreadsByThreadId[previousThreadId];
  const previousThreadIsTemporary =
    input.previousThreadWasTemporary === true || previousDraftThread?.isTemporary === true;
  if (previousThreadIsTemporary) {
    return previousThreadId;
  }

  // Regular new-thread drafts should be transient only while still local + empty.
  if (input.previousThreadHasServerThread === true || !previousDraftThread) {
    return null;
  }
  const composerDraft = input.composerDraftsByThreadId?.[previousThreadId];
  return isComposerDraftEmptyForDisposal(composerDraft) ? previousThreadId : null;
}
