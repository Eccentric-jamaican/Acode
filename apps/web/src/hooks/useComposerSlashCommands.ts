import type { ProviderKind } from "@t3tools/contracts";
import { useCallback } from "react";
import {
  getAvailableComposerSlashCommands,
  parseComposerSlashInvocationForCommands,
  parseFastSlashCommandAction,
} from "../composerSlashCommands";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import { toastManager } from "../components/ui/toast";

type ComposerSnapshot = {
  value: string;
  cursor: number;
};

type SlashCommandItem = Extract<ComposerCommandItem, { type: "slash-command" }>;

export function useComposerSlashCommands(input: {
  selectedProvider: ProviderKind;
  providerNativeCommandNames: readonly string[];
  supportsFastSlashCommand: boolean;
  fastModeEnabled: boolean;
  handleInteractionModeChange: (mode: "default" | "plan") => Promise<void> | void;
  handleClearConversation: () => Promise<void> | void;
  handleForkCommand: () => Promise<void> | void;
  handleStatusCommand: () => void;
  handleShortcutCommand: (
    command: "browser" | "review" | "subagents",
    args: string,
  ) => void;
  setFastModeFromSlash: (enabled: boolean) => void;
  editorActions: {
    resolveActiveComposerTrigger: () => {
      snapshot: ComposerSnapshot;
      trigger: { rangeStart: number; rangeEnd: number } | null;
    };
    applyPromptReplacement: (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ) => boolean;
    clearComposerSlashDraft: () => void;
    setComposerPromptValue: (nextPrompt: string) => void;
    scheduleComposerFocus: () => void;
    setComposerHighlightedItemId: (itemId: string | null) => void;
  };
}) {
  const {
    selectedProvider,
    providerNativeCommandNames,
    supportsFastSlashCommand,
    fastModeEnabled,
    handleInteractionModeChange,
    handleClearConversation,
    handleForkCommand,
    handleStatusCommand,
    handleShortcutCommand,
    setFastModeFromSlash,
    editorActions,
  } = input;

  const runFastSlashCommand = useCallback(
    (text: string): boolean => {
      const action = parseFastSlashCommandAction(text);
      if (action === null) {
        return false;
      }
      if (!supportsFastSlashCommand) {
        toastManager.add({
          type: "warning",
          title: "Fast mode is unavailable",
          description: "The selected model does not support Fast mode.",
        });
        return true;
      }
      if (action === "invalid") {
        toastManager.add({
          type: "warning",
          title: "Invalid /fast command",
          description: "Use /fast, /fast on, /fast off, or /fast status.",
        });
        return true;
      }
      if (action === "status") {
        toastManager.add({
          type: "info",
          title: `Fast mode is ${fastModeEnabled ? "on" : "off"}`,
        });
        return true;
      }
      const nextEnabled =
        action === "on" ? true : action === "off" ? false : !fastModeEnabled;
      setFastModeFromSlash(nextEnabled);
      toastManager.add({
        type: "success",
        title: `Fast mode ${nextEnabled ? "enabled" : "disabled"}`,
      });
      return true;
    },
    [fastModeEnabled, setFastModeFromSlash, supportsFastSlashCommand],
  );

  const handleStandaloneSlashCommand = useCallback(
    async (trimmed: string): Promise<boolean> => {
      const availableBuiltInSlashCommands = getAvailableComposerSlashCommands({
        provider: selectedProvider,
        supportsFastSlashCommand,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames,
      });
      const invocation = parseComposerSlashInvocationForCommands(
        trimmed,
        availableBuiltInSlashCommands,
      );
      if (!invocation || invocation.command === "model") {
        return false;
      }

      if (invocation.command === "clear") {
        editorActions.clearComposerSlashDraft();
        await handleClearConversation();
        return true;
      }
      if (invocation.command === "plan" || invocation.command === "default") {
        await handleInteractionModeChange(
          invocation.command === "plan" ? "plan" : "default",
        );
        editorActions.clearComposerSlashDraft();
        return true;
      }
      if (invocation.command === "status") {
        editorActions.clearComposerSlashDraft();
        handleStatusCommand();
        return true;
      }
      if (invocation.command === "subagents") {
        handleShortcutCommand("subagents", invocation.args);
        return true;
      }
      if (invocation.command === "browser") {
        handleShortcutCommand("browser", invocation.args);
        return true;
      }
      if (invocation.command === "review") {
        handleShortcutCommand("review", invocation.args);
        return true;
      }
      if (invocation.command === "fast") {
        editorActions.clearComposerSlashDraft();
        runFastSlashCommand(trimmed);
        return true;
      }
      if (invocation.command === "fork") {
        editorActions.clearComposerSlashDraft();
        await handleForkCommand();
        return true;
      }
      return false;
    },
    [
      editorActions,
      handleClearConversation,
      handleForkCommand,
      handleInteractionModeChange,
      handleStatusCommand,
      handleShortcutCommand,
      providerNativeCommandNames,
      runFastSlashCommand,
      selectedProvider,
      supportsFastSlashCommand,
    ],
  );

  const handleSlashCommandSelection = useCallback(
    (item: SlashCommandItem) => {
      const { snapshot, trigger } = editorActions.resolveActiveComposerTrigger();
      if (!trigger) {
        return;
      }

      const clearSlashCommandFromComposer = () =>
        editorActions.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });

      if (item.command === "model") {
        const applied = editorActions.applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          "/model ",
          {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          },
        );
        if (applied) {
          editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "clear") {
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          editorActions.setComposerHighlightedItemId(null);
        }
        void handleClearConversation();
        return;
      }

      if (item.command === "plan" || item.command === "default") {
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "subagents") {
        handleShortcutCommand("subagents", "");
        editorActions.setComposerHighlightedItemId(null);
        return;
      }

      if (item.command === "browser") {
        handleShortcutCommand("browser", "");
        editorActions.setComposerHighlightedItemId(null);
        return;
      }

      if (item.command === "status") {
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          editorActions.setComposerHighlightedItemId(null);
        }
        handleStatusCommand();
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "review") {
        handleShortcutCommand("review", "");
        editorActions.setComposerHighlightedItemId(null);
        return;
      }

      if (item.command === "fast") {
        const applied = clearSlashCommandFromComposer();
        if (!applied) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        void runFastSlashCommand("/fast");
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "fork") {
        const applied = clearSlashCommandFromComposer();
        if (!applied) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        void handleForkCommand();
        editorActions.scheduleComposerFocus();
      }
    },
    [
      editorActions,
      handleClearConversation,
      handleForkCommand,
      handleInteractionModeChange,
      handleStatusCommand,
      handleShortcutCommand,
      runFastSlashCommand,
    ],
  );

  return {
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  };
}
