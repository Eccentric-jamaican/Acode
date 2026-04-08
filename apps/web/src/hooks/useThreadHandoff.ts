import { useNavigate } from "@tanstack/react-router";
import { type ProviderKind } from "@t3tools/contracts";
import { useCallback } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildThreadHandoffImportedMessages,
  canCreateThreadHandoff,
  inferProviderFromModel,
  resolveThreadHandoffModelSelection,
} from "../lib/threadHandoff";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { type Thread } from "../types";

export function useThreadHandoff() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);

  const createThreadHandoff = useCallback(
    async (
      thread: Thread,
      options?: {
        readonly targetProvider?: ProviderKind;
      },
    ): Promise<Thread["id"]> => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API not found");
      }

      const project = projects.find((entry) => entry.id === thread.projectId);
      if (!project) {
        throw new Error("Project not found for handoff thread.");
      }

      if (!canCreateThreadHandoff({ thread })) {
        throw new Error("This thread cannot be handed off yet.");
      }

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const importedMessages = buildThreadHandoffImportedMessages(thread);
      const { stickyModelSelectionByProvider } = useComposerDraftStore.getState();

      const modelSelection = resolveThreadHandoffModelSelection({
        sourceThread: thread,
        ...(options?.targetProvider ? { targetProvider: options.targetProvider } : {}),
        projectDefaultModelSelection: {
          provider: inferProviderFromModel(project.model),
          model: project.model,
        },
        stickyModelSelectionByProvider,
      });

      await api.orchestration.dispatchCommand({
        type: "thread.handoff.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        model: modelSelection.model,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        importedMessages: [...importedMessages],
        createdAt,
      });

      const snapshot = await api.orchestration.getSnapshot();
      syncServerReadModel(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });

      return nextThreadId;
    },
    [navigate, projects, syncServerReadModel],
  );

  return {
    createThreadHandoff,
  };
}
