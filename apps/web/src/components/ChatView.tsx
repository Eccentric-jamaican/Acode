import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EDITORS,
  type EditorId,
  type KeybindingCommand,
  type CodexReasoningEffort,
  DEFAULT_COMPUTER_USE_APP_CATEGORIES,
  type ComputerUseAppSummary,
  type ComputerUseSettings,
  type MessageId,
  type ProjectId,
  type ProjectEntry,
  type ProjectScript,
  type ModelSlug,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ProviderApprovalDecision,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ProviderKind,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ThreadId,
  type TurnId,
  type UploadChatAttachment,
  OrchestrationThreadActivity,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { isComputerUseAppAllowed } from "@t3tools/shared/computerUsePermissions";
import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  memo,
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelsQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import { refineNewThreadSuggestionsQueryOptions } from "~/lib/newThreadSuggestionsReactQuery";
import { enrichSubagentWorkEntries } from "~/lib/subagentWorkEntries";

import { isElectron, isElectronRuntime } from "../env";
import {
  parseDiffRouteSearch,
  resolveRightPanelMode,
  withFilesRailOpen,
  withDiffSelection,
  withRightPanelMode,
} from "../diffRouteSearch";
import {
  type ComposerTrigger,
  type ComposerSlashCommand,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../composer-logic";
import {
  buildBrowserUseComposerPrompt,
  buildSlashReviewComposerPrompt,
  buildSubagentsPrompt,
} from "../composerSlashCommands";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveRevertTurnCountByUserMessageId,
  deriveTimelineEntries,
  deriveActivePlanState,
  findLatestProposedPlan,
  type PendingApproval,
  type PendingUserInput,
  type ProviderPickerKind,
  PROVIDER_OPTIONS,
  deriveWorkLogEntries,
  extractGeneratedImageArtifacts,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
  formatTimestamp,
} from "../session-logic";
import { isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ChatAttachment,
  type ChatMessage,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useIsDisposableThread } from "../hooks/useIsDisposableThread";
import { useComposerCommandMenuItems } from "../hooks/useComposerCommandMenuItems";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import {
  getFilePanelThreadState,
  type FilePanelComment,
  useFilePanelStore,
} from "../filePanelStore";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";
import GitActionsControl from "./GitActionsControl";
import {
  isOpenFavoriteEditorShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  BotIcon,
  EllipsisIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FilesIcon,
  FolderClosedIcon,
  GlobeIcon,
  KanbanSquareIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  BoxIcon,
  GitBranchIcon,
  ImageIcon,
  MousePointer2Icon,
  PlusIcon,
  Maximize2Icon,
  ArrowLeftRight,
  TerminalIcon,
  Undo2Icon,
  Trash2Icon,
  XIcon,
  ZapIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Group, GroupSeparator } from "./ui/group";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "./ui/combobox";
import { ScrollArea } from "./ui/scroll-area";
import {
  ClaudeAI,
  CursorIcon,
  Gemini,
  Icon,
  OpenAI,
  OpenCodeIcon,
  VisualStudioCode,
  Zed,
} from "./Icons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import {
  canCreateThreadHandoff,
  inferProviderFromModel,
  resolveHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import type { NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { Toggle } from "./ui/toggle";
import { SidebarInsetTrigger, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  getAppModelOptions,
  resolveAppModelSelection,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
  type AppServiceTier,
  useAppSettings,
} from "../appSettings";
import {
  type ComposerImageAttachment,
  type ComposerInspectCaptureDraft,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type PinnedSelectionDraft,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { buildInspectPrompt } from "../browserInspectCapture";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  ComposerPromptEditor,
  type ComposerMentionDescriptor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditor";
import { shouldUseCompactComposerFooter } from "./composerFooterLayout";
import { buildQuotedSelectionInsertion, normalizeSelectedText } from "../chatPinnedSelections";
import { MessagesTimeline, type UserMessageMentionDescriptor } from "./chat/MessagesTimeline";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import {
  ExpandedImagePreview as ExpandedImagePreviewDialog,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ComposerCommandMenu, type ComposerCommandItem } from "./chat/ComposerCommandMenu";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { buildChatThreadRelativePath, isChatsProject, joinClientPath } from "~/lib/chatProject";

const LAST_EDITOR_KEY = "t3code:last-editor";
const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const MODEL_PICKER_FAVORITES_KEY = "t3code:model-picker-favorites:v1";
const THREAD_CONTEXT_PANEL_PINNED_KEY = "t3code:thread-context-panel-pinned";
const THREAD_CONTEXT_PANEL_ARTIFACTS_COLLAPSED_KEY =
  "t3code:thread-context-panel-artifacts-collapsed";
const THREAD_CONTEXT_PANEL_SOURCES_COLLAPSED_KEY = "t3code:thread-context-panel-sources-collapsed";
const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const ATTACHMENT_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and any attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_PLUGINS: ProviderPluginDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
const EMPTY_COMPUTER_USE_APPS: ComputerUseAppSummary[] = [];
const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: true,
  approvalPolicy: "ask",
  enabledAppCategories: [...DEFAULT_COMPUTER_USE_APP_CATEGORIES],
  allowedAppIds: [],
  blockedAppIds: [],
  captureRetentionDays: 7,
};
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_HANDOFF_TARGET_PROVIDERS: readonly ProviderKind[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const WORKTREE_BRANCH_PREFIX = "t3code";
const HEADER_COMPACT_BREAKPOINT = 480;
const HANDOFF_WHEEL_SNAP_DELTA = 36;
const HANDOFF_WHEEL_RESET_GAP_MS = 220;
const HANDOFF_WHEEL_COOLDOWN_MS = 180;
const DESKTOP_APP_RESOLUTION_TIMEOUT_MS = 2_500;

function attachmentTypeForFile(file: File): ChatAttachment["type"] | null {
  if (file.type.startsWith("image/")) {
    return "image";
  }
  if (file.type === "application/pdf") {
    return "pdf";
  }
  return null;
}

function attachmentLabel(attachment: Pick<ChatAttachment, "type" | "name">): string {
  return attachment.type === "pdf" ? `PDF: ${attachment.name}` : `Image: ${attachment.name}`;
}

function toOptimisticChatAttachment(attachment: ComposerImageAttachment): ChatAttachment {
  if (attachment.type === "pdf") {
    return {
      type: "pdf",
      id: attachment.id,
      name: attachment.name,
      mimeType: "application/pdf",
      sizeBytes: attachment.sizeBytes,
      previewUrl: attachment.previewUrl,
    };
  }
  return {
    type: "image",
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: attachment.previewUrl,
  };
}

async function toUploadChatAttachment(
  attachment: ComposerImageAttachment,
): Promise<UploadChatAttachment> {
  const dataUrl = await readFileAsDataUrl(attachment.file);
  if (attachment.type === "pdf") {
    return {
      type: "pdf",
      name: attachment.name,
      mimeType: "application/pdf",
      sizeBytes: attachment.sizeBytes,
      dataUrl,
    };
  }
  return {
    type: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl,
  };
}
const DESKTOP_APP_ICON_PREWARM_COUNT = 10;
const THREAD_CONTEXT_ARTIFACT_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "docx",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "md",
  "mdown",
  "mdx",
  "mkd",
  "pdf",
  "png",
  "pptx",
  "webp",
  "xls",
  "xlsx",
]);
const CODEX_REASONING_LABEL_BY_OPTION: Record<CodexReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function skillMentionPrefix(): "$" {
  return "$";
}

type SelectedComposerExtension = {
  id: string;
  type: "plugin" | "skill" | "desktop-app";
  name: string;
  label: string;
  mentionName: string;
  iconUrl?: string | undefined;
  desktopApp?: ComputerUseAppSummary | undefined;
};

interface ThreadContextArtifact {
  path: string;
  label: string;
  kind: "generated" | "workspace";
  cwd?: string;
}

interface ThreadContextSource {
  id: string;
  label: string;
  icon: "browser" | "file" | "web";
}

interface ThreadContextProgressItem {
  id: string;
  label: string;
  status: "pending" | "inProgress" | "completed" | "failed";
  createdAt: string;
}

function extensionOf(pathValue: string): string {
  const filename = pathValue.split(/[\\/]/).at(-1) ?? pathValue;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return "";
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

function basenameOfPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).at(-1) ?? pathValue;
}

function normalizeThreadContextPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").trim();
}

function isThreadContextArtifactPath(pathValue: string): boolean {
  return THREAD_CONTEXT_ARTIFACT_EXTENSIONS.has(extensionOf(pathValue));
}

function compareThreadContextActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
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

function progressLabelFromPayload(
  payload: Record<string, unknown> | null,
  fallback: string,
): string {
  if (payload && typeof payload.detail === "string" && payload.detail.trim().length > 0) {
    return payload.detail.trim();
  }
  return fallback;
}

function latestUserMessageCreatedAt(thread: Thread): string | null {
  return (
    thread.messages
      .filter((message) => message.role === "user")
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)?.createdAt ?? null
  );
}

function isAfterProgressBoundary(
  activity: Thread["activities"][number],
  boundary: string | null,
): boolean {
  return boundary === null || activity.createdAt >= boundary;
}

function collectLatestPlanProgress(
  thread: Thread,
  boundary: string | null,
): ThreadContextProgressItem[] {
  const latestPlanActivity = [...thread.activities]
    .filter((activity) => activity.kind === "turn.plan.updated")
    .filter((activity) => isAfterProgressBoundary(activity, boundary))
    .filter((activity) =>
      thread.latestTurn?.turnId ? activity.turnId === thread.latestTurn.turnId : true,
    )
    .toSorted(compareThreadContextActivities)
    .at(-1);
  const payload =
    latestPlanActivity?.payload && typeof latestPlanActivity.payload === "object"
      ? (latestPlanActivity.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!latestPlanActivity || !Array.isArray(rawPlan)) {
    return [];
  }

  return rawPlan
    .map<ThreadContextProgressItem | null>((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string" || record.step.trim().length === 0) {
        return null;
      }
      const status =
        record.status === "completed"
          ? "completed"
          : record.status === "inProgress"
            ? "inProgress"
            : "pending";
      return {
        id: `${latestPlanActivity.id}:plan:${index}`,
        label: record.step.trim(),
        status,
        createdAt: latestPlanActivity.createdAt,
      };
    })
    .filter((item): item is ThreadContextProgressItem => item !== null)
    .slice(0, 6);
}

function collectTaskProgress(thread: Thread, boundary: string | null): ThreadContextProgressItem[] {
  const byTaskId = new Map<string, ThreadContextProgressItem>();
  for (const activity of [...thread.activities].toSorted(compareThreadContextActivities)) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    if (!isAfterProgressBoundary(activity, boundary)) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : activity.id;
    const previous = byTaskId.get(taskId);
    if (activity.kind === "task.completed") {
      const rawStatus = typeof payload?.status === "string" ? payload.status : "completed";
      byTaskId.set(taskId, {
        id: taskId,
        label: progressLabelFromPayload(payload, previous?.label ?? activity.summary),
        status: rawStatus === "failed" ? "failed" : "completed",
        createdAt: activity.createdAt,
      });
      continue;
    }
    byTaskId.set(taskId, {
      id: taskId,
      label: progressLabelFromPayload(payload, activity.summary),
      status: "inProgress",
      createdAt: activity.createdAt,
    });
  }

  return [...byTaskId.values()]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-6);
}

function toolProgressKey(payload: Record<string, unknown> | null, fallback: string): string {
  const data =
    payload?.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : null;
  const toolName = typeof data?.toolName === "string" ? data.toolName : null;
  return toolName ?? fallback;
}

function isTaskLikeToolProgress(payload: Record<string, unknown> | null, summary: string): boolean {
  const data =
    payload?.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : null;
  const toolName = typeof data?.toolName === "string" ? data.toolName : "";
  const itemType = typeof payload?.itemType === "string" ? payload.itemType : "";
  const haystack = `${summary} ${toolName} ${itemType}`.toLowerCase();
  return haystack.includes("task") || haystack.includes("todo") || haystack.includes("plan");
}

function collectTaskLikeToolProgress(
  thread: Thread,
  boundary: string | null,
): ThreadContextProgressItem[] {
  const byTool = new Map<string, ThreadContextProgressItem>();
  for (const activity of [...thread.activities].toSorted(compareThreadContextActivities)) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    if (!isAfterProgressBoundary(activity, boundary)) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    if (!isTaskLikeToolProgress(payload, activity.summary)) {
      continue;
    }
    const key = toolProgressKey(payload, activity.summary);
    const status =
      activity.kind === "tool.completed"
        ? "completed"
        : payload?.status === "completed"
          ? "completed"
          : "inProgress";
    byTool.set(key, {
      id: key,
      label: progressLabelFromPayload(payload, activity.summary.replace(/\s+started$/i, "")),
      status,
      createdAt: activity.createdAt,
    });
  }

  return [...byTool.values()]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-6);
}

function collectProposedPlanMarkdownProgress(
  thread: Thread,
  boundary: string | null,
): ThreadContextProgressItem[] {
  const latestPlan = [...thread.proposedPlans]
    .filter((plan) => (boundary === null ? true : plan.createdAt >= boundary))
    .filter((plan) => (thread.latestTurn?.turnId ? plan.turnId === thread.latestTurn.turnId : true))
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return [];
  }

  const markdownLines = latestPlan.planMarkdown.split("\n");
  const numberedSteps: string[] = [];
  let collectingNumberedBlock = false;
  for (const line of markdownLines) {
    if (/^\s*#{1,6}\s+/.test(line) && collectingNumberedBlock) {
      break;
    }
    const numberedStep = line.match(/^\s*\d+[.)]\s+(.+)$/)?.[1]?.trim();
    if (numberedStep) {
      collectingNumberedBlock = true;
      numberedSteps.push(numberedStep);
    }
  }

  const steps =
    numberedSteps.length > 0
      ? numberedSteps
      : markdownLines
          .map((line) => line.match(/^\s*(?:[-*])\s+(.+)$/)?.[1]?.trim() ?? null)
          .filter((line): line is string => Boolean(line))
          .filter((line) => !line.toLowerCase().startsWith("fresh session"));
  const visibleSteps = steps.slice(0, 6);

  return visibleSteps.map((step, index) => ({
    id: `${latestPlan.id}:markdown:${index}`,
    label: step,
    status: "pending",
    createdAt: latestPlan.updatedAt,
  }));
}

function collectThreadContextProgress(thread: Thread): ThreadContextProgressItem[] {
  const boundary = latestUserMessageCreatedAt(thread);
  const planProgress = collectLatestPlanProgress(thread, boundary);
  if (planProgress.length > 0) {
    return planProgress;
  }
  const taskProgress = collectTaskProgress(thread, boundary);
  if (taskProgress.length > 0) {
    return taskProgress;
  }
  const taskLikeToolProgress = collectTaskLikeToolProgress(thread, boundary);
  if (taskLikeToolProgress.length > 0) {
    return taskLikeToolProgress;
  }
  return collectProposedPlanMarkdownProgress(thread, boundary);
}

function collectThreadContextArtifacts(input: {
  thread: Thread;
  homeDirectory: string | undefined;
}): ThreadContextArtifact[] {
  const seen = new Set<string>();
  const artifacts: ThreadContextArtifact[] = [];
  const pushArtifact = (pathValue: string, kind: ThreadContextArtifact["kind"]) => {
    const normalizedPath = normalizeThreadContextPath(pathValue);
    const dedupeKey = normalizedPath.toLowerCase();
    if (!isThreadContextArtifactPath(normalizedPath) || seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    artifacts.push({
      path: normalizedPath,
      label: basenameOfPath(normalizedPath),
      kind,
    });
  };
  let generatedImageCount = 0;
  const pushGeneratedImageArtifact = (artifact: {
    path: string;
    label: string;
    cwd?: string | undefined;
  }) => {
    const normalizedPath = normalizeThreadContextPath(artifact.path);
    const normalizedCwd = artifact.cwd ? normalizeThreadContextPath(artifact.cwd) : undefined;
    const dedupeKey = `${normalizedCwd ?? ""}\u0000${normalizedPath}`.toLowerCase();
    if (!isThreadContextArtifactPath(normalizedPath) || seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    generatedImageCount += 1;
    const label =
      artifact.label === "Generated image"
        ? `Generated image ${generatedImageCount}`
        : artifact.label;
    artifacts.push({
      path: normalizedPath,
      label,
      kind: "generated",
      ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    });
  };

  for (const summary of input.thread.turnDiffSummaries) {
    for (const file of summary.files) {
      pushArtifact(file.path, "workspace");
    }
  }
  for (const message of input.thread.messages) {
    const pathPattern =
      /(?:^|[\s`"'(])((?:[A-Za-z]:[\\/])?(?:[\w .@()[\]-]+[\\/])*[\w .@()[\]-]+\.(?:avif|bmp|docx|gif|heic|jpe?g|md|mdown|mdx|mkd|pdf|png|pptx|webp|xls|xlsx))(?=$|[\s`"',).])/gi;
    for (const match of message.text.matchAll(pathPattern)) {
      const pathValue = match[1];
      if (pathValue) {
        pushArtifact(pathValue, "workspace");
      }
    }
  }
  for (const activity of input.thread.activities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    for (const artifact of extractGeneratedImageArtifacts(payload)) {
      pushGeneratedImageArtifact({
        ...artifact,
        ...(artifact.cwd
          ? { cwd: artifact.cwd }
          : artifact.providerThreadId && input.homeDirectory
            ? {
                cwd: `${input.homeDirectory.replaceAll("\\", "/")}/.codex/generated_images/${
                  artifact.providerThreadId
                }`,
              }
            : {}),
      });
    }
  }

  return artifacts;
}

function collectThreadContextSources(thread: Thread): ThreadContextSource[] {
  const sources = new Map<string, ThreadContextSource>();
  const addSource = (source: ThreadContextSource) => {
    sources.set(source.id, source);
  };

  for (const message of thread.messages) {
    if ((message.attachments?.length ?? 0) > 0) {
      addSource({ id: "attachments", label: "Attachments", icon: "file" });
    }
  }

  for (const activity of thread.activities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const itemType = typeof payload.itemType === "string" ? payload.itemType : "";
    const summary = `${activity.summary} ${JSON.stringify(payload)}`.toLowerCase();
    if (itemType === "web_search" || summary.includes("web search")) {
      addSource({ id: "web-search", label: "Web search", icon: "web" });
    }
    if (summary.includes("browser")) {
      addSource({ id: "browser", label: "Browser", icon: "browser" });
    }
    if (itemType === "file_change" || summary.includes("read") || summary.includes("file")) {
      addSource({ id: "files", label: "Files", icon: "file" });
    }
  }

  return [...sources.values()];
}

type SelectedComposerShortcut = {
  id: string;
  command: Extract<ComposerSlashCommand, "browser" | "review" | "subagents">;
  label: string;
  args: string;
};

function pluginLabel(plugin: ProviderPluginDescriptor): string {
  return plugin.interface?.displayName ?? plugin.name;
}

function skillLabel(skill: ProviderSkillDescriptor): string {
  return skill.interface?.displayName ?? skill.name;
}

function pluginComposerIcon(plugin: ProviderPluginDescriptor | undefined): string | undefined {
  return plugin?.interface?.composerIcon ?? plugin?.interface?.logo;
}

function pluginForSkill(
  skill: ProviderSkillDescriptor,
  plugins: readonly ProviderPluginDescriptor[],
): ProviderPluginDescriptor | undefined {
  return plugins.find((plugin) => skill.path.startsWith(plugin.source.path));
}

function selectedComposerExtensionsFromPrompt(input: {
  prompt: string;
  plugins: readonly ProviderPluginDescriptor[];
  skills: readonly ProviderSkillDescriptor[];
  desktopApps?: readonly ComputerUseAppSummary[];
}): SelectedComposerExtension[] {
  const pluginsByName = new Map(input.plugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const skillsByName = new Map(input.skills.map((skill) => [skill.name.toLowerCase(), skill]));
  const desktopAppsByName = new Map(
    (input.desktopApps ?? []).map((app) => [desktopAppMentionName(app).toLowerCase(), app]),
  );
  const selected = new Map<string, SelectedComposerExtension>();
  const mentionPattern = /(^|\s)([$/@])([^\s]+)(?=\s|$)/g;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(input.prompt)) !== null) {
    const rawName = match[3]?.trim();
    if (!rawName) continue;
    const normalizedName = rawName.replace(/^\[|\]$/g, "").toLowerCase();
    const marker = match[2];
    const desktopApp = marker === "@" ? desktopAppsByName.get(normalizedName) : undefined;
    if (desktopApp) {
      selected.set(
        `desktop-app:${desktopApp.appId}`,
        selectedComposerExtensionFromDesktopApp(desktopApp),
      );
      continue;
    }
    const plugin = pluginsByName.get(normalizedName);
    if (plugin) {
      selected.set(`plugin:${plugin.name}`, selectedComposerExtensionFromPlugin(plugin));
      continue;
    }
    const skill = skillsByName.get(normalizedName);
    if (skill) {
      selected.set(
        `skill:${skill.path}`,
        selectedComposerExtensionFromSkill({ skill, plugins: input.plugins }),
      );
    }
  }

  return [...selected.values()];
}

function selectedComposerExtensionFromPlugin(
  plugin: ProviderPluginDescriptor,
): SelectedComposerExtension {
  const iconUrl = pluginComposerIcon(plugin);
  return {
    id: `plugin:${plugin.name}`,
    type: "plugin",
    name: plugin.name,
    label: pluginLabel(plugin),
    mentionName: plugin.name,
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function selectedComposerExtensionFromSkill(input: {
  skill: ProviderSkillDescriptor;
  plugins: readonly ProviderPluginDescriptor[];
}): SelectedComposerExtension {
  const iconUrl = pluginComposerIcon(pluginForSkill(input.skill, input.plugins));
  return {
    id: `skill:${input.skill.path}`,
    type: "skill",
    name: input.skill.name,
    label: skillLabel(input.skill),
    mentionName: input.skill.name,
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function desktopAppMentionName(app: ComputerUseAppSummary): string {
  return (
    app.name
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\w.-]+/g, "")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function selectedComposerExtensionFromDesktopApp(
  app: ComputerUseAppSummary,
): SelectedComposerExtension {
  return {
    id: `desktop-app:${app.appId}`,
    type: "desktop-app",
    name: app.name,
    label: app.name,
    mentionName: desktopAppMentionName(app),
    ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
    desktopApp: app,
  };
}

function mergeSelectedComposerExtensions(
  existing: SelectedComposerExtension[],
  additions: SelectedComposerExtension[],
): SelectedComposerExtension[] {
  if (additions.length === 0) return existing;
  const merged = new Map(existing.map((extension) => [extension.id, extension]));
  for (const addition of additions) {
    merged.set(addition.id, addition);
  }
  return [...merged.values()];
}

function selectedComposerExtensionMarker(extension: SelectedComposerExtension): "$" | "@" {
  return extension.type === "desktop-app" ? "@" : skillMentionPrefix();
}

function promptContainsSelectedComposerExtensionToken(
  prompt: string,
  extension: SelectedComposerExtension,
): boolean {
  const selectedToken = extension.mentionName.toLowerCase();
  const selectedMarker = selectedComposerExtensionMarker(extension);
  const mentionPattern = /(^|\s)([$/@])([^\s]+)(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(prompt)) !== null) {
    const marker = match[2];
    const rawName = match[3];
    if (!marker || !rawName) continue;
    if (marker !== selectedMarker) continue;
    if (rawName.replace(/^\[|\]$/g, "").toLowerCase() === selectedToken) {
      return true;
    }
  }
  return false;
}

function desktopAppMentionNamesInPrompt(prompt: string): string[] {
  const mentionPattern = /(^|\s)(@)([^\s]+)(?=\s|$)/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(prompt)) !== null) {
    const rawName = match[3]?.trim();
    if (!rawName) continue;
    names.add(rawName.replace(/^\[|\]$/g, "").toLowerCase());
  }
  return [...names];
}

async function resolveDesktopAppsForPrompt(input: {
  prompt: string;
  desktopApps: readonly ComputerUseAppSummary[];
  computerUseSettings: ComputerUseSettings;
  api: NonNullable<ReturnType<typeof readNativeApi>>;
}): Promise<readonly ComputerUseAppSummary[]> {
  const mentionNames = desktopAppMentionNamesInPrompt(input.prompt);
  if (mentionNames.length === 0) {
    return input.desktopApps;
  }

  const resolvedNames = new Set(
    input.desktopApps.map((app) => desktopAppMentionName(app).toLowerCase()),
  );
  const hasAllMentionedApps = mentionNames.every((name) => resolvedNames.has(name));
  if (hasAllMentionedApps) {
    return input.desktopApps;
  }

  try {
    const result = await Promise.race([
      input.api.computerUse.listApps(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), DESKTOP_APP_RESOLUTION_TIMEOUT_MS);
      }),
    ]);
    if (!result) {
      return input.desktopApps;
    }
    return (result.apps ?? []).filter((app) =>
      isComputerUseAppAllowed(app, input.computerUseSettings),
    );
  } catch {
    return input.desktopApps;
  }
}

function promptWithSelectedComposerExtensions(input: {
  prompt: string;
  selectedExtensions: readonly SelectedComposerExtension[];
}): string {
  if (input.selectedExtensions.length === 0) return input.prompt;
  const providerExtensions = input.selectedExtensions.filter(
    (extension) => extension.type === "plugin" || extension.type === "skill",
  );
  const desktopApps = input.selectedExtensions.filter(
    (extension) => extension.type === "desktop-app" && extension.desktopApp,
  );
  const selectedPrompt = providerExtensions
    .filter((extension) => !promptContainsSelectedComposerExtensionToken(input.prompt, extension))
    .map((extension) => `${selectedComposerExtensionMarker(extension)}${extension.mentionName}`)
    .join(" ");
  const cleanPrompt = input.prompt.trim();
  const computerUseContext =
    desktopApps.length > 0
      ? [
          "The user explicitly selected desktop app target(s). You must use the t3_computer MCP for this request.",
          "Do not answer from reasoning alone and do not substitute unrelated tools while fulfilling an explicit desktop-app request.",
          "If the selected app is not running, launch or attach it first, then perform the requested action in that app.",
          ...desktopApps.map((extension) => {
            const app = extension.desktopApp!;
            const window = app.windows.find((candidate) => candidate.isFocused || candidate.isMain);
            const windowText = window?.title ? `, window: ${window.title}` : "";
            const pidText = app.isRunning !== false && app.pid > 0 ? `, pid: ${app.pid}` : "";
            const launchText = app.launchId ? `, launchId: ${app.launchId}` : "";
            const runningText = app.isRunning === false ? ", not running" : "";
            return `Use t3_computer MCP - ${app.name} (appId: ${app.appId}${pidText}${launchText}${windowText}${runningText})`;
          }),
        ].join("\n")
      : "";
  const visiblePrompt = cleanPrompt
    ? [selectedPrompt, cleanPrompt].filter(Boolean).join(" ")
    : selectedPrompt;
  return [computerUseContext, visiblePrompt].filter(Boolean).join("\n\n").trim();
}

function displayPromptWithSelectedComposerExtensions(input: {
  prompt: string;
  selectedExtensions: readonly SelectedComposerExtension[];
}): string {
  if (input.selectedExtensions.length === 0) return input.prompt;
  const selectedPrompt = input.selectedExtensions
    .filter((extension) => !promptContainsSelectedComposerExtensionToken(input.prompt, extension))
    .map((extension) => `${selectedComposerExtensionMarker(extension)}${extension.mentionName}`)
    .join(" ");
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${selectedPrompt} ${cleanPrompt}` : selectedPrompt;
}

function selectedComposerShortcutLabel(command: SelectedComposerShortcut["command"]): string {
  switch (command) {
    case "browser":
      return "T3 Browser Use";
    case "review":
      return "Code Review";
    case "subagents":
      return "Subagents";
  }
}

function selectedComposerShortcutPrompt(input: {
  shortcut: SelectedComposerShortcut;
  projectId?: string | null | undefined;
}): string {
  switch (input.shortcut.command) {
    case "browser":
      return buildBrowserUseComposerPrompt(input.shortcut.args, { projectId: input.projectId });
    case "review":
      return buildSlashReviewComposerPrompt(input.shortcut.args);
    case "subagents":
      return buildSubagentsPrompt(input.shortcut.args);
  }
}

function promptWithSelectedComposerShortcuts(input: {
  prompt: string;
  shortcuts: readonly SelectedComposerShortcut[];
  projectId?: string | null | undefined;
}): string {
  if (input.shortcuts.length === 0) return input.prompt;
  const shortcutPrompt = input.shortcuts
    .map((shortcut) => selectedComposerShortcutPrompt({ shortcut, projectId: input.projectId }))
    .join("\n\n");
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${shortcutPrompt}\n\n${cleanPrompt}` : shortcutPrompt;
}

function displayPromptWithSelectedComposerShortcuts(input: {
  prompt: string;
  shortcuts: readonly SelectedComposerShortcut[];
}): string {
  if (input.shortcuts.length === 0) return input.prompt;
  const shortcutPrompt = input.shortcuts
    .map((shortcut) => `/${shortcut.command}${shortcut.args ? ` ${shortcut.args}` : ""}`)
    .join(" ");
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${shortcutPrompt} ${cleanPrompt}` : shortcutPrompt;
}

function promptWithInspectCaptures(input: {
  prompt: string;
  captures: readonly ComposerInspectCaptureDraft[];
}): string {
  if (input.captures.length === 0) return input.prompt;
  const inspectPrompt = input.captures
    .map((entry) => buildInspectPrompt(entry.capture))
    .join("\n\n");
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${inspectPrompt}\n\n${cleanPrompt}` : inspectPrompt;
}

function displayPromptWithInspectCaptures(input: {
  prompt: string;
  captures: readonly ComposerInspectCaptureDraft[];
}): string {
  if (input.captures.length === 0) return input.prompt;
  const inspectTokens = input.captures.map(() => "/inspect").join(" ");
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${inspectTokens} ${cleanPrompt}` : inspectTokens;
}

function flattenFilePanelComments(
  commentsByFilePath: Record<string, FilePanelComment[]>,
): Array<{ filePath: string; comment: FilePanelComment }> {
  return Object.entries(commentsByFilePath).flatMap(([filePath, comments]) =>
    comments.map((comment) => ({ filePath, comment })),
  );
}

function buildFilePanelCommentsPrompt(
  commentsByFilePath: Record<string, FilePanelComment[]>,
): string {
  const comments = flattenFilePanelComments(commentsByFilePath);
  if (comments.length === 0) return "";
  const lines = comments.map(({ filePath, comment }, index) => {
    const side = comment.side === "deletions" ? "old line" : "line";
    return `${index + 1}. ${filePath}:${comment.line} (${side})\n${comment.text}`;
  });
  return `Local review comments:\n${lines.join("\n\n")}`;
}

function promptWithFilePanelComments(input: {
  prompt: string;
  commentsByFilePath: Record<string, FilePanelComment[]>;
}): string {
  const commentsPrompt = buildFilePanelCommentsPrompt(input.commentsByFilePath);
  if (commentsPrompt.length === 0) return input.prompt;
  const cleanPrompt = input.prompt.trim();
  return cleanPrompt ? `${commentsPrompt}\n\n${cleanPrompt}` : commentsPrompt;
}

function displayPromptWithFilePanelComments(input: {
  prompt: string;
  commentsByFilePath: Record<string, FilePanelComment[]>;
}): string {
  const count = flattenFilePanelComments(input.commentsByFilePath).length;
  if (count === 0) return input.prompt;
  const cleanPrompt = input.prompt.trim();
  const token = count === 1 ? "/comment" : `/comments(${count})`;
  return cleanPrompt ? `${token} ${cleanPrompt}` : token;
}

const SelectedComposerShortcutIcon = memo(function SelectedComposerShortcutIcon(props: {
  shortcut: SelectedComposerShortcut;
}) {
  const className = "size-4 shrink-0";
  switch (props.shortcut.command) {
    case "browser":
      return <GlobeIcon className={className} />;
    case "review":
      return <FilesIcon className={className} />;
    case "subagents":
      return <BotIcon className={className} />;
  }
});

const SelectedInspectCaptureIcon = memo(function SelectedInspectCaptureIcon() {
  return <MousePointer2Icon className="size-4 shrink-0" />;
});

const SelectedLocalCommentIcon = memo(function SelectedLocalCommentIcon() {
  return <MessageSquareIcon className="size-4 shrink-0" />;
});

function removeSelectedComposerShortcutById(
  shortcuts: SelectedComposerShortcut[],
  shortcutId: string,
): SelectedComposerShortcut[] {
  return shortcuts.filter((shortcut) => shortcut.id !== shortcutId);
}

function readLastInvokedScriptByProjectFromStorage(): Record<string, string> {
  const stored = localStorage.getItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModel: string,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    origin: "user",
    taskId: null,
    title: "New thread",
    model: fallbackModel,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    isPinned: false,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

type SendPhase = "idle" | "preparing-worktree" | "sending-turn";

type QueuedComposerChatTurn = {
  id: string;
  kind: "chat";
  createdAt: string;
  previewText: string;
  prompt: string;
  displayText?: string | undefined;
  shortcuts?: SelectedComposerShortcut[] | undefined;
  inspectCaptures?: ComposerInspectCaptureDraft[] | undefined;
  images: ComposerImageAttachment[];
  selectedProvider: ProviderKind;
  selectedModel: ModelSlug | null;
  selectedEffort: CodexReasoningEffort | null;
  selectedCodexFastModeEnabled: boolean;
  modelOptionsForDispatch?: ProviderModelOptions | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
};

type QueuedComposerPlanFollowUp = {
  id: string;
  kind: "plan-follow-up";
  createdAt: string;
  previewText: string;
  text: string;
  interactionMode: "default" | "plan";
  selectedProvider: ProviderKind;
  selectedModel: ModelSlug | null;
  selectedEffort: CodexReasoningEffort | null;
  selectedCodexFastModeEnabled: boolean;
  modelOptionsForDispatch?: ProviderModelOptions | undefined;
  runtimeMode: RuntimeMode;
};

type QueuedComposerTurn = QueuedComposerChatTurn | QueuedComposerPlanFollowUp;

function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  const firstAttachment = input.images[0];
  if (firstAttachment) {
    return attachmentLabel(firstAttachment);
  }
  return "Queued follow-up";
}

type FileWithLocalPath = File & { path?: string };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

function localFilesystemPathForFile(file: File): string | null {
  const maybePath = (file as FileWithLocalPath).path;
  if (typeof maybePath !== "string") {
    return null;
  }
  const trimmed = maybePath.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function promptWithLocalAttachmentPaths(input: {
  prompt: string;
  attachments: ReadonlyArray<ComposerImageAttachment>;
}): string {
  const localPaths = input.attachments
    .filter((attachment) => attachment.type !== "image")
    .map((attachment) => attachment.localPath?.trim() ?? "")
    .filter((path) => path.length > 0);
  if (localPaths.length === 0) {
    return input.prompt;
  }

  const uniquePaths = Array.from(new Set(localPaths));
  const pathBlock = [
    "",
    "Attached local file paths:",
    ...uniquePaths.map((path) => `- ${path}`),
    "",
    "If needed, inspect these files directly from disk using the provided paths.",
  ].join("\n");
  return `${input.prompt}${pathBlock}`;
}

function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

function normalizeWorktreeBranchName(value: string): string {
  const trimmed = value.trim().replace(/^(codex|t3code|dpcode)\//i, "");
  const normalized = sanitizeBranchFragment(trimmed.length > 0 ? trimmed : "update").toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${normalized}`;
}

function buildSuggestedWorktreeName(input: {
  existingWorktreeBranch?: string | null;
  title?: string | null;
}): string {
  const normalizedExisting = input.existingWorktreeBranch?.trim() ?? "";
  if (normalizedExisting.length > 0) {
    return normalizeWorktreeBranchName(normalizedExisting);
  }
  return normalizeWorktreeBranchName(input.title ?? "update");
}

function cloneComposerImageForRetry(image: ComposerImageAttachment): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

interface ChatViewProps {
  threadId: ThreadId;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  isFocusedPane?: boolean;
  panelState?: {
    panel: "browser" | "diff" | null;
    filesOpen: boolean;
    diffTurnId: TurnId | null;
    diffFilePath: string | null;
    hasOpenedPanel: boolean;
    lastOpenPanel: "browser" | "diff";
  };
  onToggleDiffPanel?: () => void;
  onToggleBrowserPanel?: () => void;
  onToggleFilesPanel?: () => void;
  onOpenFileViewerPanel?: (path: string) => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
  floatingComposer?: boolean;
  onMaximizeSurface?: () => void;
  onSplitSurface?: () => void;
}

export default function ChatView({
  threadId,
  paneScopeId,
  surfaceMode = "single",
  isFocusedPane = true,
  panelState,
  onToggleDiffPanel,
  onToggleBrowserPanel,
  onToggleFilesPanel,
  onOpenFileViewerPanel,
  onOpenTurnDiffPanel: _onOpenTurnDiffPanel,
  floatingComposer = false,
  onMaximizeSurface,
  onSplitSurface,
}: ChatViewProps) {
  const usesDesktopAppChrome = isElectronRuntime();
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const tasks = useStore((store) => store.tasks);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const { createThreadHandoff } = useThreadHandoff();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerInspectCaptures = composerDraft.inspectCaptures;
  const composerPinnedSelections = composerDraft.pinnedSelections;
  const filePanelCommentsByFilePath = useFilePanelStore(
    (store) => getFilePanelThreadState(store, threadId).commentsByFilePath,
  );
  const filePanelCommentCount = useMemo(
    () => flattenFilePanelComments(filePanelCommentsByFilePath).length,
    [filePanelCommentsByFilePath],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftProvider = useComposerDraftStore((store) => store.setProvider);
  const setComposerDraftModel = useComposerDraftStore((store) => store.setModel);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const setComposerDraftEffort = useComposerDraftStore((store) => store.setEffort);
  const setComposerDraftCodexFastMode = useComposerDraftStore((store) => store.setCodexFastMode);
  const setComposerDraftOpencodeVariant = useComposerDraftStore(
    (store) => store.setOpencodeVariant,
  );
  const setComposerDraftOpencodeAgent = useComposerDraftStore((store) => store.setOpencodeAgent);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const removeComposerDraftInspectCapture = useComposerDraftStore(
    (store) => store.removeInspectCapture,
  );
  const addComposerDraftInspectCapture = useComposerDraftStore((store) => store.addInspectCapture);
  const addComposerDraftPinnedSelection = useComposerDraftStore(
    (store) => store.addPinnedSelection,
  );
  const removeComposerDraftPinnedSelection = useComposerDraftStore(
    (store) => store.removePinnedSelection,
  );
  const clearComposerDraftPinnedSelections = useComposerDraftStore(
    (store) => store.clearPinnedSelections,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const clearFilePanelComments = useFilePanelStore((store) => store.clearComments);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [worktreeHandoffDialogOpen, setWorktreeHandoffDialogOpen] = useState(false);
  const [worktreeHandoffName, setWorktreeHandoffName] = useState("");
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [locallyDismissedApprovalRequestIds, setLocallyDismissedApprovalRequestIds] = useState<
    Record<string, true>
  >({});
  const [locallyDismissedUserInputRequestIds, setLocallyDismissedUserInputRequestIds] = useState<
    Record<string, true>
  >({});
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() => prompt.length);
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [selectedComposerExtensions, setSelectedComposerExtensions] = useState<
    SelectedComposerExtension[]
  >([]);
  const [selectedComposerShortcuts, setSelectedComposerShortcuts] = useState<
    SelectedComposerShortcut[]
  >([]);
  const [queuedComposerTurns, setQueuedComposerTurns] = useState<QueuedComposerTurn[]>([]);
  const [disabledOpencodeModelSlugs, setDisabledOpencodeModelSlugs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useState<
    Record<string, string>
  >(() => readLastInvokedScriptByProjectFromStorage());
  const [pendingPinnedSelectionJumpId, setPendingPinnedSelectionJumpId] = useState<string | null>(
    null,
  );
  const [showScrollToBottomPill, setShowScrollToBottomPill] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const queuedComposerTurnsRef = useRef<QueuedComposerTurn[]>([]);
  const autoDispatchingQueuedTurnRef = useRef(false);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const handledDisabledOpencodeModelKeysRef = useRef<Set<string>>(new Set());
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );

  const serverThread = threads.find((t) => t.id === threadId);
  const fallbackDraftProject = projects.find((project) => project.id === draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.model ?? DEFAULT_MODEL_BY_PROVIDER.codex,
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.model, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  useEffect(() => {
    setWorktreeHandoffDialogOpen(false);
    setWorktreeHandoffName("");
  }, [activeThread?.id]);
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const diffSearch = useMemo(
    () => parseDiffRouteSearch(rawSearch as Record<string, unknown>),
    [rawSearch],
  );
  const rightPanelMode = useMemo(() => resolveRightPanelMode(diffSearch), [diffSearch]);
  const diffOpen = rightPanelMode === "diff";
  const browserPaneOpen = rightPanelMode === "browser";
  const filesRailOpen = panelState ? panelState.filesOpen : diffSearch.files === "1";
  const resolvedDiffOpen = panelState ? panelState.panel === "diff" : diffOpen;
  const resolvedBrowserPaneOpen = panelState ? panelState.panel === "browser" : browserPaneOpen;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = projects.find((p) => p.id === activeThread?.projectId);
  const activeTask =
    activeThread?.origin === "task" && activeThread.taskId
      ? (tasks.find((task) => task.id === activeThread.taskId) ?? null)
      : null;

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.provider;
  const inferredProviderFromThreadModel = activeThread
    ? inferProviderFromModel(activeThread.model)
    : null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const shouldShowNewThreadLanding = isLocalDraftThread && !hasThreadStarted;
  const isPromptEmpty =
    prompt.trim().length === 0 &&
    selectedComposerExtensions.length === 0 &&
    selectedComposerShortcuts.length === 0 &&
    composerInspectCaptures.length === 0;
  const selectedServiceTierSetting = settings.codexServiceTier;
  const selectedServiceTier = resolveAppServiceTier(selectedServiceTierSetting);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const homeDirectory = serverConfigQuery.data?.homeDirectory ?? null;
  const chatWorkspaceRoot = serverConfigQuery.data?.chatWorkspaceRoot ?? null;
  const projectPickerProjects = useMemo(
    () =>
      projects.filter((project) => !isChatsProject(project, chatWorkspaceRoot ?? homeDirectory)),
    [chatWorkspaceRoot, homeDirectory, projects],
  );
  const isActiveHomeProject = activeProject
    ? isChatsProject(activeProject, chatWorkspaceRoot ?? homeDirectory)
    : false;
  const providerStatuses = serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? inferredProviderFromThreadModel ?? selectedProviderByThreadId ?? null)
    : null;
  const selectedProvider: ProviderKind =
    lockedProvider ?? selectedProviderByThreadId ?? inferredProviderFromThreadModel ?? "codex";

  useEffect(() => {
    if (!activeThread || !hasThreadStarted) {
      return;
    }
    const fallbackProvider = sessionProvider ?? inferredProviderFromThreadModel;
    if (
      !fallbackProvider ||
      fallbackProvider === "claudeAgent" ||
      selectedProviderByThreadId === fallbackProvider
    ) {
      return;
    }
    setComposerDraftProvider(activeThread.id, fallbackProvider);
  }, [
    activeThread,
    hasThreadStarted,
    inferredProviderFromThreadModel,
    selectedProviderByThreadId,
    sessionProvider,
    setComposerDraftProvider,
  ]);
  const assistantDeliveryMode = settings.enableAssistantStreaming ? "streaming" : "buffered";
  const baseThreadModel = resolveModelSlugForProvider(
    selectedProvider,
    activeThread?.model ?? activeProject?.model ?? getDefaultModel(selectedProvider),
  );
  const selectedEffort = composerDraft.effort ?? getDefaultReasoningEffort(selectedProvider);
  const selectedCodexFastModeEnabled =
    selectedProvider === "codex" ? composerDraft.codexFastMode : false;
  const selectedOpencodeVariant =
    selectedProvider === "opencode" ? composerDraft.opencodeVariant : null;
  const selectedOpencodeAgent =
    selectedProvider === "opencode" ? composerDraft.opencodeAgent : null;
  const opencodeRuntimeModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "opencode",
      enabled: true,
    }),
  );
  const filteredOpencodeRuntimeModels = useMemo(
    () =>
      (opencodeRuntimeModelsQuery.data?.models ?? []).filter(
        (model) => !disabledOpencodeModelSlugs.has(model.slug),
      ),
    [disabledOpencodeModelSlugs, opencodeRuntimeModelsQuery.data?.models],
  );
  const codexRuntimeModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "codex",
      enabled: true,
    }),
  );
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(
        settings,
        providerStatuses,
        codexRuntimeModelsQuery.data?.models ?? [],
        filteredOpencodeRuntimeModels,
      ),
    [
      codexRuntimeModelsQuery.data?.models,
      filteredOpencodeRuntimeModels,
      providerStatuses,
      settings,
    ],
  );
  const selectedModel = useMemo(() => {
    const draftModel = composerDraft.model;
    const providerOptions = modelOptionsByProvider[selectedProvider];
    const firstAvailableModel = providerOptions[0]?.slug as ModelSlug | undefined;
    const fallbackModel =
      resolveModelForProviderPicker(selectedProvider, baseThreadModel, providerOptions) ??
      firstAvailableModel ??
      (getDefaultModel(selectedProvider) as ModelSlug);
    if (!draftModel) {
      return fallbackModel;
    }
    return (
      resolveModelForProviderPicker(selectedProvider, draftModel, providerOptions) ?? fallbackModel
    );
  }, [baseThreadModel, composerDraft.model, modelOptionsByProvider, selectedProvider]);
  const selectedOpencodeModelCapabilities =
    selectedProvider === "opencode"
      ? (providerStatuses
          .find((provider) => provider.provider === "opencode")
          ?.models?.find((model) => model.slug === selectedModel)?.capabilities ?? null)
      : null;
  const newThreadSuggestionsCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const newThreadGitStatusQuery = useQuery(gitStatusQueryOptions(newThreadSuggestionsCwd));
  const shouldShowNewThreadSuggestions =
    shouldShowNewThreadLanding &&
    activeProject !== undefined &&
    settings.newThreadSuggestionsEnabled &&
    isPromptEmpty;
  const refinedNewThreadSuggestionsQuery = useQuery(
    refineNewThreadSuggestionsQueryOptions({
      provider: selectedProvider,
      cwd: newThreadSuggestionsCwd,
      projectName: activeProject?.name ?? null,
      selectedModel: settings.newThreadSuggestionModel,
      enabled: shouldShowNewThreadSuggestions,
    }),
  );
  const visibleNewThreadSuggestions = refinedNewThreadSuggestionsQuery.data?.suggestions ?? [];
  const newThreadSuggestionCount = visibleNewThreadSuggestions.length;
  const showNewThreadSuggestionsLoading =
    shouldShowNewThreadSuggestions &&
    selectedProvider === "codex" &&
    (newThreadGitStatusQuery.isLoading ||
      newThreadGitStatusQuery.data?.hasWorkingTreeChanges === true) &&
    refinedNewThreadSuggestionsQuery.isLoading &&
    newThreadSuggestionCount === 0;
  const reasoningOptions = getReasoningEffortOptions(selectedProvider);
  const supportsReasoningEffort = reasoningOptions.length > 0;
  const selectedModelOptionsForDispatch = useMemo(() => {
    if (selectedProvider === "codex") {
      const codexOptions = {
        ...(supportsReasoningEffort && selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        ...(selectedCodexFastModeEnabled ? { fastMode: true } : {}),
      };
      return Object.keys(codexOptions).length > 0 ? { codex: codexOptions } : undefined;
    }
    if (selectedProvider === "opencode") {
      const opencodeOptions = {
        ...(selectedOpencodeVariant ? { variant: selectedOpencodeVariant } : {}),
        ...(selectedOpencodeAgent ? { agent: selectedOpencodeAgent } : {}),
      };
      return Object.keys(opencodeOptions).length > 0 ? { opencode: opencodeOptions } : undefined;
    }
    return undefined;
  }, [
    selectedCodexFastModeEnabled,
    selectedEffort,
    selectedOpencodeAgent,
    selectedOpencodeVariant,
    selectedProvider,
    supportsReasoningEffort,
  ]);
  const selectedModelForPicker = selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  useEffect(() => {
    const disabledModelMatch = /OpenCode model '([^']+)' is disabled/i.exec(
      activeThread?.error ?? "",
    );
    const disabledModelSlug = disabledModelMatch?.[1];
    if (!activeThread?.id || !disabledModelSlug) {
      return;
    }

    const handledKey = `${activeThread.id}:${disabledModelSlug}`;
    if (handledDisabledOpencodeModelKeysRef.current.has(handledKey)) {
      return;
    }
    handledDisabledOpencodeModelKeysRef.current.add(handledKey);

    setDisabledOpencodeModelSlugs((current) => {
      if (current.has(disabledModelSlug)) {
        return current;
      }
      return new Set([...current, disabledModelSlug]);
    });

    void queryClient.invalidateQueries({
      queryKey: providerDiscoveryQueryKeys.models("opencode"),
    });

    const fallbackOptions = modelOptionsByProvider.opencode.filter(
      (option) => option.slug !== disabledModelSlug,
    );
    const fallbackModel =
      resolveModelForProviderPicker("opencode", baseThreadModel, fallbackOptions) ??
      resolveModelForProviderPicker("opencode", selectedModel, fallbackOptions) ??
      (fallbackOptions[0]?.slug as ModelSlug | undefined) ??
      (getDefaultModel("opencode") as ModelSlug);

    setComposerDraftModel(activeThread.id, fallbackModel);
    toastManager.add({
      type: "warning",
      title: "OpenCode model unavailable",
      description: `${disabledModelSlug} was disabled upstream. Switched this thread to ${fallbackModel}.`,
    });

    if (serverThread?.model === disabledModelSlug) {
      const api = readNativeApi();
      if (api) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          model: fallbackModel,
        });
      }
    }
  }, [
    activeThread?.error,
    activeThread?.id,
    baseThreadModel,
    modelOptionsByProvider,
    queryClient,
    selectedModel,
    serverThread?.model,
    setComposerDraftModel,
  ]);
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isSendBusy = sendPhase !== "idle";
  const isPreparingWorktree = sendPhase === "preparing-worktree";
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const nowIso = new Date(nowTick).toISOString();
  const allThreads = useStore((store) => store.threads);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const rawWorkLogEntries = useMemo(() => {
    const latestTurnEntries = deriveWorkLogEntries(
      threadActivities,
      activeLatestTurn?.turnId ?? undefined,
    );
    const latestTurnEntryIds = new Set(latestTurnEntries.map((entry) => entry.id));
    const historicalGeneratedImageEntries = deriveWorkLogEntries(threadActivities, undefined)
      .filter((entry) => (entry.generatedImages?.length ?? 0) > 0)
      .filter((entry) => !latestTurnEntryIds.has(entry.id));
    return [...historicalGeneratedImageEntries, ...latestTurnEntries];
  }, [activeLatestTurn?.turnId, threadActivities]);
  const workLogEntries = useMemo(
    () =>
      enrichSubagentWorkEntries({
        entries: rawWorkLogEntries,
        parentThreadId: activeThread?.id ?? null,
        threads: allThreads,
      }),
    [activeThread?.id, allThreads, rawWorkLogEntries],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const effectivePendingApprovals = useMemo(
    () =>
      pendingApprovals.filter(
        (approval) => !locallyDismissedApprovalRequestIds[`${approval.requestId}`],
      ),
    [locallyDismissedApprovalRequestIds, pendingApprovals],
  );
  const effectivePendingUserInputs = useMemo(
    () =>
      pendingUserInputs.filter(
        (userInput) => !locallyDismissedUserInputRequestIds[`${userInput.requestId}`],
      ),
    [locallyDismissedUserInputRequestIds, pendingUserInputs],
  );
  useEffect(() => {
    if (Object.keys(locallyDismissedApprovalRequestIds).length === 0) {
      return;
    }
    const activeRequestIds = new Set(pendingApprovals.map((approval) => `${approval.requestId}`));
    setLocallyDismissedApprovalRequestIds((existing) => {
      const next = Object.fromEntries(
        Object.entries(existing).filter(([requestId]) => activeRequestIds.has(requestId)),
      );
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
  }, [pendingApprovals, locallyDismissedApprovalRequestIds]);
  useEffect(() => {
    if (Object.keys(locallyDismissedUserInputRequestIds).length === 0) {
      return;
    }
    const activeRequestIds = new Set(pendingUserInputs.map((request) => `${request.requestId}`));
    setLocallyDismissedUserInputRequestIds((existing) => {
      const next = Object.fromEntries(
        Object.entries(existing).filter(([requestId]) => activeRequestIds.has(requestId)),
      );
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
  }, [pendingUserInputs, locallyDismissedUserInputRequestIds]);
  const handoffBadgeLabel = useMemo(
    () => (activeThread ? resolveThreadHandoffBadgeLabel(activeThread) : null),
    [activeThread],
  );
  const handoffBadgeSourceProvider = activeThread?.handoff?.sourceProvider ?? null;
  const handoffBadgeTargetProvider = activeThread
    ? inferProviderFromModel(activeThread.model)
    : null;
  const handoffTargetProviders = useMemo(
    () =>
      activeThread
        ? resolveHandoffTargetProviders(inferProviderFromModel(activeThread.model))
        : EMPTY_HANDOFF_TARGET_PROVIDERS,
    [activeThread],
  );
  const [handoffTargetProviderIndex, setHandoffTargetProviderIndex] = useState(0);
  const handoffTargetProvidersKey = handoffTargetProviders.join("|");
  useEffect(() => {
    setHandoffTargetProviderIndex(0);
  }, [activeThread?.id, handoffTargetProvidersKey]);
  const handoffTargetProvider: ProviderKind | null =
    handoffTargetProviders.length > 0
      ? (handoffTargetProviders[
          ((handoffTargetProviderIndex % handoffTargetProviders.length) +
            handoffTargetProviders.length) %
            handoffTargetProviders.length
        ] ?? null)
      : null;
  const onCycleHandoffTargetProvider = useCallback(
    (direction: 1 | -1) => {
      setHandoffTargetProviderIndex((currentIndex) => {
        if (handoffTargetProviders.length <= 1) {
          return 0;
        }
        const nextIndex = currentIndex + direction;
        const normalized =
          ((nextIndex % handoffTargetProviders.length) + handoffTargetProviders.length) %
          handoffTargetProviders.length;
        return normalized;
      });
    },
    [handoffTargetProviders.length],
  );
  const handoffActionLabel = useMemo(() => {
    if (!activeThread) {
      return "Create handoff thread";
    }
    const providerLabel = PROVIDER_DISPLAY_NAMES[handoffTargetProvider ?? "codex"];
    return handoffTargetProviders.length > 1
      ? `Handoff to ${providerLabel} (scroll to switch provider)`
      : `Handoff to ${providerLabel}`;
  }, [activeThread, handoffTargetProvider, handoffTargetProviders.length]);
  const handoffDisabled = !(
    activeThread &&
    activeProject &&
    isServerThread &&
    canCreateThreadHandoff({
      thread: activeThread,
      isBusy: isWorking,
      hasPendingApprovals: effectivePendingApprovals.length > 0,
      hasPendingUserInput: effectivePendingUserInputs.length > 0,
    })
  );
  const activePendingUserInput = effectivePendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () =>
      deriveActivePlanState(
        threadActivities,
        activeLatestTurn?.turnId ?? undefined,
        activeLatestTurn?.interactionMode,
      ),
    [activeLatestTurn?.interactionMode, activeLatestTurn?.turnId, threadActivities],
  );
  const showPlanFollowUpPrompt =
    effectivePendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    activeProposedPlan !== null;
  const activePendingApproval = effectivePendingApprovals[0] ?? null;
  const isComposerApprovalState = activePendingApproval !== null;
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  useEffect(() => {
    if (!activePendingProgress) {
      return;
    }
    promptRef.current = activePendingProgress.customAnswer;
    setComposerCursor(activePendingProgress.customAnswer.length);
    setComposerTrigger(
      detectComposerTrigger(
        activePendingProgress.customAnswer,
        expandCollapsedComposerCursor(
          activePendingProgress.customAnswer,
          activePendingProgress.customAnswer.length,
        ),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [activePendingProgress, activePendingUserInput?.requestId]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let attachmentIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (!attachment.previewUrl) {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[attachmentIndex];
              attachmentIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const syncScrollToBottomPillVisibility = useCallback(
    (scrollContainer: HTMLDivElement | null) => {
      const nextVisible =
        scrollContainer !== null &&
        timelineEntries.length > 0 &&
        !isScrollContainerNearBottom(scrollContainer);
      setShowScrollToBottomPill((current) => (current === nextVisible ? current : nextVisible));
    },
    [timelineEntries.length],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const turnDiffSummaryByTurnId = useMemo(() => {
    const byTurnId = new Map<TurnId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      byTurnId.set(summary.turnId, summary);
    }
    return byTurnId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    return deriveRevertTurnCountByUserMessageId(
      timelineEntries,
      turnDiffSummaryByAssistantMessageId,
      turnDiffSummaryByTurnId,
      inferredCheckpointTurnCountByTurnId,
    );
  }, [
    inferredCheckpointTurnCountByTurnId,
    timelineEntries,
    turnDiffSummaryByAssistantMessageId,
    turnDiffSummaryByTurnId,
  ]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeLatestTurn.startedAt);
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnStartedAt)) return null;
    if (Number.isNaN(turnCompletedAt)) return null;

    let inRangeMatch: string | null = null;
    let fallbackMatch: string | null = null;
    for (const timelineEntry of timelineEntries) {
      if (timelineEntry.kind !== "message") continue;
      if (timelineEntry.message.role !== "assistant") continue;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      if (Number.isNaN(messageAt) || messageAt < turnStartedAt) continue;
      fallbackMatch = timelineEntry.id;
      if (messageAt <= turnCompletedAt) {
        inRangeMatch = timelineEntry.id;
      }
    }
    return inRangeMatch ?? fallbackMatch;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    completionSummary,
    latestTurnSettled,
    timelineEntries,
  ]);
  const threadWorkspaceCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const gitCwd = isActiveHomeProject ? null : threadWorkspaceCwd;
  const composerWorkspaceSearchCwd =
    activeThread?.worktreePath ?? (!isActiveHomeProject ? (activeProject?.cwd ?? null) : null);
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const skillTriggerQuery =
    composerTrigger?.kind === "skill" ||
    composerTrigger?.kind === "slash-command" ||
    composerTrigger?.kind === "path"
      ? composerTrigger.query
      : "";
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const activeRootBranch = useMemo(() => {
    const branches = branchesQuery.data?.branches ?? [];
    if (branches.length === 0) return null;
    const localCurrentBranch =
      branches.find((branch) => branch.current && branch.worktreePath === null) ?? null;
    if (localCurrentBranch) return localCurrentBranch.name;
    const localDefaultBranch =
      branches.find((branch) => branch.isDefault && branch.isRemote !== true) ?? null;
    if (localDefaultBranch) return localDefaultBranch.name;
    const anyDefaultBranch = branches.find((branch) => branch.isDefault) ?? null;
    if (anyDefaultBranch) return anyDefaultBranch.name;
    const localBranch = branches.find((branch) => branch.isRemote !== true) ?? null;
    if (localBranch) return localBranch.name;
    return branches[0]?.name ?? null;
  }, [branchesQuery.data?.branches]);
  const composerDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: activeThread?.worktreePath ?? null,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerDiscoveryCwd,
      threadId,
      query:
        composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model"
          ? (composerTrigger?.query ?? "")
          : "",
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerDiscoveryCwd !== null,
    }),
  );
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerDiscoveryCwd,
      threadId,
      query: skillTriggerQuery,
      enabled:
        (isPathTrigger || isSkillTrigger || composerTriggerKind === "slash-command") &&
        supportsSkillDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerDiscoveryCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerDiscoveryCwd,
      threadId,
      enabled:
        (isPathTrigger || isSkillTrigger || composerTriggerKind === "slash-command") &&
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data),
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: composerWorkspaceSearchCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger && composerWorkspaceSearchCwd !== null,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const providerNativeCommands =
    providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const supportsFastSlashCommand = selectedProvider === "codex";
  const canOfferReviewCommand = selectedProvider === "codex" || selectedProvider === "opencode";
  const canOfferForkCommand = selectedProvider === "codex" || selectedProvider === "opencode";
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) => marketplace.plugins) ??
      EMPTY_PROVIDER_PLUGINS,
    [providerPluginsQuery.data?.marketplaces],
  );
  const providerUserMessageMentionDescriptors = useMemo<UserMessageMentionDescriptor[]>(() => {
    const pluginDescriptors = providerPlugins.map((plugin) => {
      const iconUrl = pluginComposerIcon(plugin);
      const descriptor: UserMessageMentionDescriptor = {
        mentionName: plugin.name,
        label: pluginLabel(plugin),
        type: "plugin",
      };
      if (iconUrl) descriptor.iconUrl = iconUrl;
      return descriptor;
    });
    const skillDescriptors = providerSkills.map((skill) => {
      const iconUrl = pluginComposerIcon(pluginForSkill(skill, providerPlugins));
      const descriptor: UserMessageMentionDescriptor = {
        mentionName: skill.name,
        label: skillLabel(skill),
        type: "skill",
      };
      if (iconUrl) descriptor.iconUrl = iconUrl;
      return descriptor;
    });
    return [...pluginDescriptors, ...skillDescriptors];
  }, [providerPlugins, providerSkills]);

  const computerUseAppsQuery = useQuery({
    queryKey: ["computer-use", "apps"],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) return { apps: [] };
      return api.computerUse.listApps();
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
  const computerUseSettings =
    serverConfigQuery.data?.settings?.computerUse ?? DEFAULT_COMPUTER_USE_SETTINGS;
  const desktopApps = useMemo(
    () =>
      (computerUseAppsQuery.data?.apps ?? EMPTY_COMPUTER_USE_APPS).filter((app) =>
        isComputerUseAppAllowed(app, computerUseSettings),
      ),
    [computerUseAppsQuery.data?.apps, computerUseSettings],
  );
  const prewarmedDesktopAppIconUrlsRef = useRef(new Set<string>());
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    for (const app of desktopApps.slice(0, DESKTOP_APP_ICON_PREWARM_COUNT)) {
      const iconUrl = app.iconUrl;
      if (!iconUrl || prewarmedDesktopAppIconUrlsRef.current.has(iconUrl)) {
        continue;
      }
      prewarmedDesktopAppIconUrlsRef.current.add(iconUrl);
      const image = new Image();
      image.decoding = "async";
      image.src = iconUrl;
    }
  }, [desktopApps]);
  const userMessageMentionDescriptors = useMemo<UserMessageMentionDescriptor[]>(() => {
    const desktopAppDescriptors = desktopApps.map((app) => {
      const descriptor: UserMessageMentionDescriptor = {
        mentionName: desktopAppMentionName(app),
        label: app.name,
        type: "desktop-app",
      };
      if (app.iconUrl) descriptor.iconUrl = app.iconUrl;
      return descriptor;
    });
    return [...providerUserMessageMentionDescriptors, ...desktopAppDescriptors];
  }, [desktopApps, providerUserMessageMentionDescriptors]);
  const composerMentionDescriptors: readonly ComposerMentionDescriptor[] =
    userMessageMentionDescriptors;

  const composerMenuItems = useComposerCommandMenuItems({
    composerTrigger,
    provider: selectedProvider,
    supportsFastSlashCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    providerNativeCommands,
    providerNativeCommandNames,
    providerPlugins,
    providerSkills,
    workspaceEntries,
    desktopApps,
    searchableModelOptions,
    selectedServiceTierSetting,
  });
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const activeProvider = activeThread?.session?.provider ?? "codex";
  const activeProviderStatus = useMemo(() => {
    const providerStatus =
      providerStatuses.find((status) => status.provider === activeProvider) ?? null;
    if (!providerStatus) {
      return null;
    }

    const liveSession = activeThread?.session;
    const liveSessionMatchesProvider =
      liveSession !== null && liveSession !== undefined && liveSession.provider === activeProvider;
    const liveSessionHealthy =
      liveSessionMatchesProvider &&
      liveSession.lastError === null &&
      (liveSession.status === "connecting" ||
        liveSession.status === "running" ||
        liveSession.status === "ready");

    if (!liveSessionHealthy || providerStatus.status === "ready") {
      return providerStatus;
    }

    const { message: _message, ...providerStatusWithoutMessage } = providerStatus;
    return {
      ...providerStatusWithoutMessage,
      status: "ready" as const,
    };
  }, [activeProvider, activeThread?.session, providerStatuses]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitCwd === null ? false : (branchesQuery.data?.isRepo ?? true);
  const showRuntimeControlInComposer = !isGitRepo;
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const openViewerFile = useFilePanelStore((store) => store.openFile);
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    if (onToggleDiffPanel) {
      onToggleDiffPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const next = withRightPanelMode(
          previous as Record<string, unknown>,
          diffOpen ? "none" : "diff",
        );
        return filesRailOpen ? withFilesRailOpen(next, true) : next;
      },
    });
  }, [diffOpen, filesRailOpen, navigate, onToggleDiffPanel, threadId]);
  const onToggleBrowser = useCallback(() => {
    if (onToggleBrowserPanel) {
      onToggleBrowserPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) =>
        withRightPanelMode(
          previous as Record<string, unknown>,
          browserPaneOpen ? "none" : "browser",
        ),
    });
  }, [browserPaneOpen, navigate, onToggleBrowserPanel, threadId]);
  const onToggleFiles = useCallback(() => {
    if (onToggleFilesPanel) {
      onToggleFilesPanel();
    }
  }, [onToggleFilesPanel]);
  const onOpenFilePath = useCallback(
    (path: string, options?: { cwd?: string | undefined; displayName?: string | undefined }) => {
      if (!activeThreadId) {
        return;
      }
      openViewerFile(activeThreadId, path, options);
      if (onOpenFileViewerPanel) {
        onOpenFileViewerPanel(path);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => {
          const next = withRightPanelMode(previous as Record<string, unknown>, "diff");
          return filesRailOpen ? withFilesRailOpen(next, true) : next;
        },
      });
    },
    [activeThreadId, filesRailOpen, navigate, onOpenFileViewerPanel, openViewerFile, threadId],
  );

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const hasReachedTerminalLimit = terminalState.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError, threads],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const applyNewThreadSuggestion = useCallback(
    (nextPrompt: string) => {
      setPrompt(nextPrompt);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    const terminalId = `terminal-${crypto.randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeSplitTerminal, hasReachedTerminalLimit]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    const terminalId = `terminal-${crypto.randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal, hasReachedTerminalLimit]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({ threadId: activeThreadId, terminalId, deleteHistory: true });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
        allowLocalDraftThread?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (!isServerThread && !options?.allowLocalDraftThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal =
        wantsNewTerminal && terminalState.terminalIds.length < MAX_THREAD_TERMINAL_COUNT;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${crypto.randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: Parameters<typeof api.terminal.open>[0] = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      isServerThread,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const stopActiveThreadSession = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !isServerThread ||
      !activeThread ||
      activeThread.session === null ||
      activeThread.session.status === "closed"
    ) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, isServerThread]);
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const toggleRuntimeMode = useCallback(() => {
    void handleRuntimeModeChange(
      runtimeMode === "full-access" ? "approval-required" : "full-access",
    );
  }, [handleRuntimeModeChange, runtimeMode]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      model?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (input.model !== undefined && input.model !== serverThread.model) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          model: input.model,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  useEffect(() => {
    try {
      if (Object.keys(lastInvokedScriptByProjectId).length === 0) {
        localStorage.removeItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
        return;
      }
      localStorage.setItem(
        LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
        JSON.stringify(lastInvokedScriptByProjectId),
      );
    } catch {
      // Ignore storage write failures (private mode, quota exceeded, etc.)
    }
  }, [lastInvokedScriptByProjectId]);

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottomPill(false);
  }, []);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    if (!shouldAutoScrollRef.current && isNearBottom) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch-all for keyboard/assistive scroll interactions.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    lastKnownScrollTopRef.current = currentScrollTop;
    setShowScrollToBottomPill((current) => (current === !isNearBottom ? current : !isNearBottom));
  }, []);
  const onMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pendingUserScrollUpIntentRef.current = true;
    }
  }, []);
  const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  const onScrollToBottomClick = useCallback(() => {
    pendingUserScrollUpIntentRef.current = false;
    cancelPendingStickToBottom();
    scrollMessagesToBottom("smooth");
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
  useLayoutEffect(() => {
    if (!activeThread?.id) return;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottomPill(false);
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeThread?.id, scheduleStickToBottom]);
  useLayoutEffect(() => {
    if (shouldAutoScrollRef.current) {
      setShowScrollToBottomPill(false);
      return;
    }
    syncScrollToBottomPillVisibility(messagesScrollRef.current);
  }, [messageCount, syncScrollToBottomPillVisibility, timelineEntries]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    setIsComposerFooterCompact(
      shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      }),
    );
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      const nextCompact = shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, scheduleStickToBottom]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, timelineEntries]);

  useEffect(() => {
    setExpandedWorkGroups({});
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => Math.min(Math.max(0, existing), prompt.length));
  }, [prompt]);

  useEffect(() => {
    queuedComposerTurnsRef.current = queuedComposerTurns;
  }, [queuedComposerTurns]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setSendPhase("idle");
    setComposerHighlightedItemId(null);
    setComposerCursor(promptRef.current.length);
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
    setQueuedComposerTurns([]);
    queuedComposerTurnsRef.current = [];
    autoDispatchingQueuedTurnRef.current = false;
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                type: image.type,
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    const isTerminalFocused = (): boolean => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return false;
      if (activeElement.classList.contains("xterm-helper-textarea")) return true;
      return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
    };

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, { context: shortcutContext });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleTerminalVisibility,
  ]);

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      const attachmentType = attachmentTypeForFile(file);
      if (!attachmentType) {
        error = `Unsupported file type for '${file.name}'. Please attach images or PDFs only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${ATTACHMENT_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        break;
      }

      const localPath = localFilesystemPathForFile(file);
      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: attachmentType,
        id: crypto.randomUUID(),
        name: file.name || (attachmentType === "pdf" ? "document.pdf" : "image"),
        ...(localPath ? { localPath } : {}),
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const attachmentFiles = files.filter((file) => attachmentTypeForFile(file) !== null);
    if (attachmentFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(attachmentFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, isConnecting, isRevertingCheckpoint, isSendBusy, phase, setThreadError],
  );

  const interruptActiveTurn = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) {
      return false;
    }
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }, [activeThread]);

  const clearComposerInput = useCallback(
    (
      targetThreadId: ThreadId,
      options?: {
        preserveSelectedExtensions?: SelectedComposerExtension[];
      },
    ) => {
      promptRef.current = "";
      clearComposerDraftContent(targetThreadId);
      clearFilePanelComments(targetThreadId);
      setSelectedComposerExtensions(options?.preserveSelectedExtensions ?? []);
      setSelectedComposerShortcuts([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [clearComposerDraftContent, clearFilePanelComments],
  );

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt =
        queuedTurn.kind === "chat"
          ? (queuedTurn.displayText ?? queuedTurn.prompt)
          : queuedTurn.text;
      promptRef.current = nextPrompt;
      setSelectedComposerShortcuts(queuedTurn.kind === "chat" ? (queuedTurn.shortcuts ?? []) : []);
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
      if (queuedTurn.kind === "chat") {
        for (const capture of queuedTurn.inspectCaptures ?? []) {
          addComposerDraftInspectCapture(activeThread.id, capture);
        }
      }
      if (queuedTurn.kind === "chat" && queuedTurn.images.length > 0) {
        addComposerImagesToDraft(queuedTurn.images);
      }
      setComposerDraftProvider(activeThread.id, queuedTurn.selectedProvider);
      setComposerDraftModel(
        activeThread.id,
        resolveAppModelSelection(
          queuedTurn.selectedProvider,
          queuedTurn.selectedProvider === "opencode"
            ? settings.customOpencodeModels
            : settings.customCodexModels,
          queuedTurn.selectedModel ?? getDefaultModel(queuedTurn.selectedProvider),
        ),
      );
      setComposerDraftEffort(
        activeThread.id,
        queuedTurn.selectedProvider === "codex" ? queuedTurn.selectedEffort : null,
      );
      setComposerDraftCodexFastMode(
        activeThread.id,
        queuedTurn.selectedProvider === "codex" ? queuedTurn.selectedCodexFastModeEnabled : false,
      );
      setComposerDraftRuntimeMode(activeThread.id, queuedTurn.runtimeMode);
      setComposerDraftInteractionMode(activeThread.id, queuedTurn.interactionMode);
      setComposerCursor(nextPrompt.length);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      focusComposer();
    },
    [
      activeThread,
      addComposerImagesToDraft,
      addComposerDraftInspectCapture,
      clearComposerDraftContent,
      focusComposer,
      setComposerDraftCodexFastMode,
      setComposerDraftEffort,
      setComposerDraftInteractionMode,
      setComposerDraftModel,
      setComposerDraftPrompt,
      setComposerDraftProvider,
      setComposerDraftRuntimeMode,
      settings.customCodexModels,
      settings.customOpencodeModels,
    ],
  );

  const removeQueuedComposerTurn = useCallback((queuedTurnId: string) => {
    setQueuedComposerTurns((existing) => existing.filter((entry) => entry.id !== queuedTurnId));
  }, []);

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: "queue" | "steer" = "queue",
    queuedTurn?: QueuedComposerChatTurn,
  ): Promise<boolean> => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread || isSendBusy || isConnecting || sendInFlightRef.current) {
      return false;
    }
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return true;
    }
    const queuedChatTurn = queuedTurn ?? null;
    const composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    const composerInspectCapturesForSend =
      queuedChatTurn?.inspectCaptures ?? composerInspectCaptures;
    const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
    const rawPromptForSend = queuedChatTurn?.displayText ?? promptRef.current;
    const desktopAppsForSend =
      queuedChatTurn === null
        ? await resolveDesktopAppsForPrompt({
            prompt: rawPromptForSend,
            desktopApps,
            computerUseSettings,
            api,
          })
        : desktopApps;
    const inlineSelectedComposerExtensions =
      queuedChatTurn === null
        ? selectedComposerExtensionsFromPrompt({
            prompt: rawPromptForSend,
            plugins: providerPlugins,
            skills: providerSkills,
            desktopApps: desktopAppsForSend,
          })
        : [];
    const selectedComposerExtensionsForSend = mergeSelectedComposerExtensions(
      selectedComposerExtensions,
      inlineSelectedComposerExtensions,
    );
    const persistentDesktopAppExtensionsForSend = selectedComposerExtensionsForSend.filter(
      (extension): extension is SelectedComposerExtension & { type: "desktop-app" } =>
        extension.type === "desktop-app",
    );
    const basePromptForSend =
      queuedChatTurn?.prompt ??
      promptWithSelectedComposerExtensions({
        prompt: rawPromptForSend,
        selectedExtensions: selectedComposerExtensionsForSend,
      });
    const baseDisplayPromptForSend =
      queuedChatTurn?.displayText ??
      displayPromptWithSelectedComposerExtensions({
        prompt: rawPromptForSend,
        selectedExtensions: selectedComposerExtensionsForSend,
      });
    const shortcutPromptForSend =
      queuedChatTurn?.prompt ??
      promptWithSelectedComposerShortcuts({
        prompt: basePromptForSend,
        shortcuts: selectedComposerShortcuts,
        projectId: activeProject?.id ?? null,
      });
    const promptForSend =
      queuedChatTurn?.prompt ??
      promptWithFilePanelComments({
        prompt: promptWithInspectCaptures({
          prompt: shortcutPromptForSend,
          captures: composerInspectCapturesForSend,
        }),
        commentsByFilePath: filePanelCommentsByFilePath,
      });
    const shortcutDisplayPromptForSend =
      queuedChatTurn?.displayText ??
      displayPromptWithSelectedComposerShortcuts({
        prompt: baseDisplayPromptForSend,
        shortcuts: selectedComposerShortcuts,
      });
    const displayPromptForSend =
      queuedChatTurn?.displayText ??
      displayPromptWithFilePanelComments({
        prompt: displayPromptWithInspectCaptures({
          prompt: shortcutDisplayPromptForSend,
          captures: composerInspectCapturesForSend,
        }),
        commentsByFilePath: filePanelCommentsByFilePath,
      });
    const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
    const selectedEffortForSend = queuedChatTurn?.selectedEffort ?? selectedEffort;
    const selectedCodexFastModeEnabledForSend =
      queuedChatTurn?.selectedCodexFastModeEnabled ?? selectedCodexFastModeEnabled;
    const selectedModelOptionsForDispatchForSend =
      queuedChatTurn?.modelOptionsForDispatch ?? selectedModelOptionsForDispatch;
    const runtimeModeForSend = queuedChatTurn?.runtimeMode ?? runtimeMode;
    const interactionModeForSend = queuedChatTurn?.interactionMode ?? interactionMode;
    const envModeForSend = queuedChatTurn?.envMode ?? envMode;
    const providerInputTextForSend = promptWithLocalAttachmentPaths({
      prompt: promptForSend,
      attachments: composerImagesForSend,
    });
    const trimmed = promptForSend.trim();
    const displayTrimmed = displayPromptForSend.trim();
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      if (phase === "running" && queuedChatTurn === null) {
        clearComposerInput(activeThread.id);
        const queuedPlanTurn: QueuedComposerPlanFollowUp = {
          id: crypto.randomUUID(),
          kind: "plan-follow-up",
          createdAt: new Date().toISOString(),
          previewText: followUp.text.trim().length > 0 ? followUp.text.trim() : "Queued follow-up",
          text: followUp.text,
          interactionMode: followUp.interactionMode,
          selectedProvider: selectedProviderForSend,
          selectedModel: selectedModelForSend,
          selectedEffort: selectedEffortForSend,
          selectedCodexFastModeEnabled: selectedCodexFastModeEnabledForSend,
          ...(selectedModelOptionsForDispatchForSend
            ? { modelOptionsForDispatch: selectedModelOptionsForDispatchForSend }
            : {}),
          runtimeMode: runtimeModeForSend,
        };
        setQueuedComposerTurns((existing) =>
          dispatchMode === "steer" ? [queuedPlanTurn, ...existing] : [...existing, queuedPlanTurn],
        );
        if (dispatchMode === "steer") {
          await interruptActiveTurn();
        }
        return true;
      }
      if (queuedChatTurn === null) {
        clearComposerInput(activeThread.id);
      }
      return onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
        dispatchMode,
      });
    }
    if (
      queuedChatTurn === null &&
      composerImagesForSend.length === 0 &&
      selectedComposerExtensionsForSend.length === 0 &&
      selectedComposerShortcuts.length === 0 &&
      composerInspectCapturesForSend.length === 0
    ) {
      const handledStandaloneSlashCommand = await handleStandaloneSlashCommand(trimmed);
      if (handledStandaloneSlashCommand) {
        return true;
      }
    }
    if (!trimmed && composerImagesForSend.length === 0) {
      return false;
    }
    if (!activeProject) {
      return false;
    }
    if (phase === "running") {
      if (queuedChatTurn !== null) {
        return false;
      }
      const queuedTurnFromComposer: QueuedComposerChatTurn = {
        id: crypto.randomUUID(),
        kind: "chat",
        createdAt: new Date().toISOString(),
        previewText: buildQueuedComposerPreviewText({
          trimmedPrompt: displayTrimmed,
          images: composerImagesForSend,
        }),
        prompt: promptForSend,
        displayText: displayPromptForSend,
        shortcuts: selectedComposerShortcuts,
        inspectCaptures: composerInspectCapturesForSend,
        images: composerImagesForSend.map(cloneComposerImageForRetry),
        selectedProvider: selectedProviderForSend,
        selectedModel: selectedModelForSend,
        selectedEffort: selectedEffortForSend,
        selectedCodexFastModeEnabled: selectedCodexFastModeEnabledForSend,
        ...(selectedModelOptionsForDispatchForSend
          ? { modelOptionsForDispatch: selectedModelOptionsForDispatchForSend }
          : {}),
        runtimeMode: runtimeModeForSend,
        interactionMode: interactionModeForSend,
        envMode: envModeForSend,
      };
      clearComposerInput(activeThread.id, {
        preserveSelectedExtensions: persistentDesktopAppExtensionsForSend,
      });
      setQueuedComposerTurns((existing) =>
        dispatchMode === "steer"
          ? [queuedTurnFromComposer, ...existing]
          : [...existing, queuedTurnFromComposer],
      );
      if (dispatchMode === "steer") {
        await interruptActiveTurn();
      }
      return true;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envModeForSend === "worktree" && !activeThread.worktreePath
        ? activeThread.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envModeForSend === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return false;
    }

    sendInFlightRef.current = true;
    setSendPhase(baseBranchForWorktree ? "preparing-worktree" : "sending-turn");

    const composerImagesSnapshot = [...composerImagesForSend];
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map((image) => toUploadChatAttachment(image)),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) =>
      toOptimisticChatAttachment(image),
    );
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: displayTrimmed || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setThreadError(threadIdForSend, null);
    clearComposerInput(threadIdForSend, {
      preserveSelectedExtensions: persistentDesktopAppExtensionsForSend,
    });

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    await (async () => {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        setSendPhase("preparing-worktree");
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          setStoreThreadBranch(threadIdForSend, result.worktree.branch, result.worktree.path);
        }
      }

      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = displayTrimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          const firstComposerAttachment = composerImagesSnapshot[0];
          titleSeed = firstComposerAttachment
            ? attachmentLabel(firstComposerAttachment)
            : `Attachment: ${firstComposerImageName}`;
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncateTitle(titleSeed);
      let threadCreateModel: ModelSlug =
        selectedModelForSend ||
        (activeProject.model as ModelSlug) ||
        DEFAULT_MODEL_BY_PROVIDER.codex;

      if (isActiveHomeProject && nextThreadWorktreePath === null && chatWorkspaceRoot) {
        const initialRelativePath = buildChatThreadRelativePath({
          createdAt: activeThread.createdAt,
          title,
        });
        const [dateSegment, baseSlug] = initialRelativePath.split("/");
        let suffix = 1;
        let relativePath = initialRelativePath;
        if (dateSegment && baseSlug) {
          const existingDirectoryNames = await api.projects
            .listDirectory({ cwd: chatWorkspaceRoot, relativePath: dateSegment })
            .then(
              (result) =>
                new Set(
                  result.entries
                    .filter((entry) => entry.kind === "directory")
                    .map((entry) => entry.name.toLowerCase()),
                ),
            )
            .catch(() => new Set<string>());
          while (
            existingDirectoryNames.has(relativePath.slice(dateSegment.length + 1).toLowerCase())
          ) {
            suffix += 1;
            relativePath = buildChatThreadRelativePath({
              createdAt: activeThread.createdAt,
              title,
              suffix,
            });
          }
        }
        await api.projects.createDirectory({
          cwd: chatWorkspaceRoot,
          relativePath,
        });
        nextThreadWorktreePath = joinClientPath(chatWorkspaceRoot, relativePath);

        if (isServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            worktreePath: nextThreadWorktreePath,
          });
          setStoreThreadBranch(threadIdForSend, nextThreadBranch, nextThreadWorktreePath);
        }
      }

      if (isLocalDraftThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          model: threadCreateModel,
          runtimeMode: runtimeModeForSend,
          interactionMode: interactionModeForSend,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: activeThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
      }

      let setupScript: ProjectScript | null = null;
      if (baseBranchForWorktree) {
        setupScript = setupProjectScript(activeProject.scripts);
      }
      if (setupScript) {
        let shouldRunSetupScript = false;
        if (isServerThread) {
          shouldRunSetupScript = true;
        } else {
          if (createdServerThreadForLocalDraft) {
            shouldRunSetupScript = true;
          }
        }
        if (shouldRunSetupScript) {
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
            allowLocalDraftThread: createdServerThreadForLocalDraft,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          await runProjectScript(setupScript, setupScriptOptions);
        }
      }

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModelForSend ? { model: selectedModelForSend } : {}),
          runtimeMode: runtimeModeForSend,
          interactionMode: interactionModeForSend,
        });
      }

      setSendPhase("sending-turn");
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: displayTrimmed || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          attachments: turnAttachments,
          ...(providerInputTextForSend !== displayPromptForSend
            ? { providerInputText: providerInputTextForSend }
            : {}),
        },
        model: selectedModelForSend || undefined,
        serviceTier: selectedServiceTier,
        ...(selectedModelOptionsForDispatchForSend
          ? { modelOptions: selectedModelOptionsForDispatchForSend }
          : {}),
        provider: selectedProviderForSend,
        assistantDeliveryMode,
        runtimeMode: runtimeModeForSend,
        interactionMode: interactionModeForSend,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
      if (isFirstMessage) {
        clearDraftThread(threadIdForSend);
      }
    })().catch(async (err: unknown) => {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        queuedChatTurn === null &&
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = displayPromptForSend;
        setPrompt(displayPromptForSend);
        setComposerCursor(displayPromptForSend.length);
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        setComposerTrigger(
          detectComposerTrigger(displayPromptForSend, displayPromptForSend.length),
        );
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    setSendPhase("idle");
    return turnStartSucceeded;
  };

  const onInterrupt = async () => {
    await interruptActiveTurn();
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      let wasSubmitted = false;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
        wasSubmitted = true;
      } catch (err: unknown) {
        setStoreThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit approval decision.",
        );
      } finally {
        setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
      if (wasSubmitted) {
        setLocallyDismissedApprovalRequestIds((existing) => ({
          ...existing,
          [String(requestId)]: true,
        }));
      }
    },
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      let wasSubmitted = false;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        });
        wasSubmitted = true;
      } catch (err: unknown) {
        setStoreThreadError(
          activeThreadId,
          err instanceof Error ? err.message : "Failed to submit user input.",
        );
      } finally {
        setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
      if (wasSubmitted) {
        setLocallyDismissedUserInputRequestIds((existing) => ({
          ...existing,
          [String(requestId)]: true,
        }));
        setPendingUserInputAnswersByRequestId((existing) => {
          const key = String(requestId);
          if (!existing[key]) return existing;
          const next = { ...existing };
          delete next[key];
          return next;
        });
        setPendingUserInputQuestionIndexByRequestId((existing) => {
          const key = String(requestId);
          if (!existing[key]) return existing;
          const next = { ...existing };
          delete next[key];
          return next;
        });
      }
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: {
            selectedOptionLabel: optionLabel,
            customAnswer: "",
          },
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (questionId: string, value: string, nextCursor: number, cursorAdjacentToMention: boolean) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention
          ? null
          : detectComposerTrigger(value, expandCollapsedComposerCursor(value, nextCursor)),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
      dispatchMode: _dispatchMode,
      queuedTurn,
    }: {
      text: string;
      interactionMode: "default" | "plan";
      dispatchMode: "queue" | "steer";
      queuedTurn?: QueuedComposerPlanFollowUp;
    }): Promise<boolean> => {
      void _dispatchMode;
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return false;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const selectedProviderForSend = queuedTurn?.selectedProvider ?? selectedProvider;
      const selectedModelForSend = queuedTurn?.selectedModel ?? selectedModel;
      const selectedModelOptionsForDispatchForSend =
        queuedTurn?.modelOptionsForDispatch ?? selectedModelOptionsForDispatch;
      const runtimeModeForSend = queuedTurn?.runtimeMode ?? runtimeMode;

      sendInFlightRef.current = true;
      setSendPhase("sending-turn");
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: trimmed,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModelForSend ? { model: selectedModelForSend } : {}),
          runtimeMode: runtimeModeForSend,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: trimmed,
            attachments: [],
          },
          provider: selectedProviderForSend,
          model: selectedModelForSend || undefined,
          ...(selectedModelOptionsForDispatchForSend
            ? { modelOptions: selectedModelOptionsForDispatchForSend }
            : {}),
          assistantDeliveryMode,
          runtimeMode: runtimeModeForSend,
          interactionMode: nextInteractionMode,
          createdAt: messageCreatedAt,
        });
        sendInFlightRef.current = false;
        setSendPhase("idle");
        return true;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        setSendPhase("idle");
        return false;
      }
    },
    [
      activeThread,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      runtimeMode,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedProvider,
      setComposerDraftInteractionMode,
      setThreadError,
      assistantDeliveryMode,
    ],
  );

  const onSendRef = useRef(onSend);
  const onSubmitPlanFollowUpRef = useRef(onSubmitPlanFollowUp);
  onSendRef.current = onSend;
  onSubmitPlanFollowUpRef.current = onSubmitPlanFollowUp;

  const dispatchQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn, dispatchMode: "queue" | "steer"): Promise<boolean> => {
      if (queuedTurn.kind === "chat") {
        return onSendRef.current(undefined, dispatchMode, queuedTurn);
      }
      return onSubmitPlanFollowUpRef.current({
        text: queuedTurn.text,
        interactionMode: queuedTurn.interactionMode,
        dispatchMode,
        queuedTurn,
      });
    },
    [],
  );

  const onSteerQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn) => {
      const previousQueue = queuedComposerTurnsRef.current;
      const queuedIndex = previousQueue.findIndex((entry) => entry.id === queuedTurn.id);
      if (queuedIndex < 0) {
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting || sendInFlightRef.current) {
        setQueuedComposerTurns((existing) => {
          const remaining = existing.filter((entry) => entry.id !== queuedTurn.id);
          return [queuedTurn, ...remaining];
        });
        await interruptActiveTurn();
        return;
      }
      setQueuedComposerTurns((existing) => existing.filter((entry) => entry.id !== queuedTurn.id));
      const succeeded = await dispatchQueuedComposerTurn(queuedTurn, "steer");
      if (succeeded) {
        return;
      }
      setQueuedComposerTurns((existing) => {
        const next = [...existing];
        next.splice(Math.min(queuedIndex, next.length), 0, queuedTurn);
        return next;
      });
    },
    [dispatchQueuedComposerTurn, interruptActiveTurn, isConnecting, isSendBusy, phase],
  );

  const onEditQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      removeQueuedComposerTurn(queuedTurn.id);
      restoreQueuedTurnToComposer(queuedTurn);
    },
    [removeQueuedComposerTurn, restoreQueuedTurnToComposer],
  );

  useEffect(() => {
    if (autoDispatchingQueuedTurnRef.current) {
      return;
    }
    if (
      phase === "running" ||
      phase === "disconnected" ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current ||
      activePendingApproval !== null ||
      activePendingProgress !== null ||
      effectivePendingUserInputs.length > 0 ||
      queuedComposerTurns.length === 0
    ) {
      return;
    }
    const nextQueuedTurn = queuedComposerTurns[0];
    if (!nextQueuedTurn) {
      return;
    }
    autoDispatchingQueuedTurnRef.current = true;
    void (async () => {
      const succeeded = await dispatchQueuedComposerTurn(nextQueuedTurn, "queue");
      if (succeeded) {
        setQueuedComposerTurns((existing) =>
          existing.filter((entry) => entry.id !== nextQueuedTurn.id),
        );
      }
      autoDispatchingQueuedTurnRef.current = false;
    })();
  }, [
    activePendingApproval,
    activePendingProgress,
    dispatchQueuedComposerTurn,
    isConnecting,
    isSendBusy,
    effectivePendingUserInputs.length,
    phase,
    queuedComposerTurns,
  ]);

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const nextThreadTitle = truncateTitle(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModel: ModelSlug =
      selectedModel ||
      (activeThread.model as ModelSlug) ||
      (activeProject.model as ModelSlug) ||
      DEFAULT_MODEL_BY_PROVIDER.codex;

    sendInFlightRef.current = true;
    setSendPhase("sending-turn");
    const finish = () => {
      sendInFlightRef.current = false;
      setSendPhase("idle");
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        model: nextThreadModel,
        runtimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() =>
        api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: implementationPrompt,
            attachments: [],
          },
          provider: selectedProvider,
          model: selectedModel || undefined,
          ...(selectedModelOptionsForDispatch
            ? { modelOptions: selectedModelOptionsForDispatch }
            : {}),
          assistantDeliveryMode,
          runtimeMode,
          interactionMode: "default",
          createdAt,
        }),
      )
      .then(() => api.orchestration.getSnapshot({ mode: "focused", threadId: nextThreadId }))
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        await api.orchestration
          .getSnapshot({ mode: "bootstrap" })
          .then((snapshot) => {
            syncServerReadModel(snapshot);
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    runtimeMode,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
    assistantDeliveryMode,
    syncServerReadModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      setComposerDraftProvider(activeThread.id, provider);
      const resolvedModel =
        resolveModelForProviderPicker(provider, model, modelOptionsByProvider[provider]) ?? model;
      setComposerDraftModel(activeThread.id, resolvedModel);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      modelOptionsByProvider,
      scheduleComposerFocus,
      setComposerDraftModel,
      setComposerDraftProvider,
    ],
  );
  const onEffortSelect = useCallback(
    (effort: CodexReasoningEffort) => {
      setComposerDraftEffort(threadId, effort);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftEffort, threadId],
  );
  const onCodexFastModeChange = useCallback(
    (enabled: boolean) => {
      setComposerDraftCodexFastMode(threadId, enabled);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftCodexFastMode, threadId],
  );
  const onOpencodeVariantChange = useCallback(
    (variant: string) => {
      setComposerDraftOpencodeVariant(threadId, variant);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftOpencodeVariant, threadId],
  );
  const onOpencodeAgentChange = useCallback(
    (agent: string) => {
      setComposerDraftOpencodeAgent(threadId, agent);
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setComposerDraftOpencodeAgent, threadId],
  );
  const compactTraitsMenuContent = useMemo(() => {
    if (selectedProvider === "opencode") {
      const variantOptions = selectedOpencodeModelCapabilities?.variantOptions ?? [];
      const agentOptions = selectedOpencodeModelCapabilities?.agentOptions ?? [];
      if (variantOptions.length === 0 && agentOptions.length === 0) {
        return null;
      }
      return (
        <>
          {variantOptions.length > 0 ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Variant</div>
              <MenuRadioGroup
                value={
                  selectedOpencodeVariant ??
                  variantOptions.find((option) => option.isDefault)?.value ??
                  ""
                }
                onValueChange={(value) => {
                  if (!value) return;
                  onOpencodeVariantChange(value);
                }}
              >
                {variantOptions.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                    {option.isDefault ? " (default)" : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </>
          ) : null}
          {variantOptions.length > 0 && agentOptions.length > 0 ? <MenuDivider /> : null}
          {agentOptions.length > 0 ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agent</div>
              <MenuRadioGroup
                value={
                  selectedOpencodeAgent ??
                  agentOptions.find((option) => option.isDefault)?.value ??
                  ""
                }
                onValueChange={(value) => {
                  if (!value) return;
                  onOpencodeAgentChange(value);
                }}
              >
                {agentOptions.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                    {option.isDefault ? " (default)" : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </>
          ) : null}
        </>
      );
    }
    if (selectedProvider !== "codex" || selectedEffort == null) {
      return null;
    }
    const defaultReasoningEffort = getDefaultReasoningEffort("codex");
    return (
      <>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
        <MenuRadioGroup
          value={selectedEffort}
          onValueChange={(value) => {
            if (!value) return;
            const nextEffort = reasoningOptions.find((option) => option === value);
            if (!nextEffort) return;
            onEffortSelect(nextEffort);
          }}
        >
          {reasoningOptions.map((effort) => (
            <MenuRadioItem key={effort} value={effort}>
              {CODEX_REASONING_LABEL_BY_OPTION[effort]}
              {effort === defaultReasoningEffort ? " (default)" : ""}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuDivider />
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
        <MenuRadioGroup
          value={selectedCodexFastModeEnabled ? "on" : "off"}
          onValueChange={(value) => {
            onCodexFastModeChange(value === "on");
          }}
        >
          <MenuRadioItem value="off">off</MenuRadioItem>
          <MenuRadioItem value="on">on</MenuRadioItem>
        </MenuRadioGroup>
      </>
    );
  }, [
    onCodexFastModeChange,
    onEffortSelect,
    onOpencodeAgentChange,
    onOpencodeVariantChange,
    reasoningOptions,
    selectedCodexFastModeEnabled,
    selectedEffort,
    selectedOpencodeAgent,
    selectedOpencodeModelCapabilities?.agentOptions,
    selectedOpencodeModelCapabilities?.variantOptions,
    selectedOpencodeVariant,
    selectedProvider,
  ]);
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );
  const onCreateProviderHandoffThread = useCallback(async () => {
    if (!activeThread || handoffDisabled) {
      return;
    }

    try {
      await createThreadHandoff(
        activeThread,
        handoffTargetProvider ? { targetProvider: handoffTargetProvider } : undefined,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create handoff thread",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while creating the handoff thread.",
      });
    }
  }, [activeThread, createThreadHandoff, handoffDisabled, handoffTargetProvider]);
  const onHandoffToWorktree = useCallback(() => {
    if (!activeThread || !isServerThread || handoffBusy) {
      return;
    }

    const baseBranch = activeRootBranch ?? activeThread.branch;
    if (!baseBranch) {
      setThreadError(activeThread.id, "Select a base branch before handing off to a worktree.");
      return;
    }

    setWorktreeHandoffName(
      buildSuggestedWorktreeName({
        existingWorktreeBranch: activeThread.branch,
        title: activeThread.title,
      }),
    );
    setWorktreeHandoffDialogOpen(true);
  }, [activeRootBranch, activeThread, handoffBusy, isServerThread, setThreadError]);

  const confirmWorktreeHandoff = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeProject || !activeThread || !isServerThread || handoffBusy) {
      return;
    }

    const baseBranch = activeRootBranch ?? activeThread.branch;
    if (!baseBranch) {
      setThreadError(activeThread.id, "Select a base branch before handing off to a worktree.");
      return;
    }

    const normalizedWorktreeName = normalizeWorktreeBranchName(worktreeHandoffName);
    setWorktreeHandoffName(normalizedWorktreeName);
    setHandoffBusy(true);
    setThreadError(activeThread.id, null);
    try {
      await stopActiveThreadSession();
      const result = await createWorktreeMutation.mutateAsync({
        cwd: activeProject.cwd,
        branch: baseBranch,
        newBranch: normalizedWorktreeName,
      });

      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThread.id,
        branch: result.worktree.branch,
        worktreePath: result.worktree.path,
      });
      setStoreThreadBranch(activeThread.id, result.worktree.branch, result.worktree.path);

      const setupScript = setupProjectScript(activeProject.scripts);
      if (setupScript) {
        await runProjectScript(setupScript, {
          cwd: result.worktree.path,
          worktreePath: result.worktree.path,
          rememberAsLastInvoked: false,
        });
      }
      setWorktreeHandoffDialogOpen(false);
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to hand off this thread to a worktree.",
      );
    } finally {
      setHandoffBusy(false);
      scheduleComposerFocus();
    }
  }, [
    activeProject,
    activeRootBranch,
    activeThread,
    createWorktreeMutation,
    handoffBusy,
    isServerThread,
    runProjectScript,
    scheduleComposerFocus,
    setStoreThreadBranch,
    setThreadError,
    stopActiveThreadSession,
    worktreeHandoffName,
  ]);
  const onHandoffToLocal = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !isServerThread ||
      activeThread.worktreePath === null ||
      handoffBusy
    ) {
      return;
    }

    const nextBranch = activeRootBranch ?? activeThread.branch;
    setHandoffBusy(true);
    setThreadError(activeThread.id, null);
    try {
      await stopActiveThreadSession();
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThread.id,
        branch: nextBranch,
        worktreePath: null,
      });
      setStoreThreadBranch(activeThread.id, nextBranch, null);
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to hand off this thread to local.",
      );
    } finally {
      setHandoffBusy(false);
      scheduleComposerFocus();
    }
  }, [
    activeRootBranch,
    activeThread,
    handoffBusy,
    isServerThread,
    scheduleComposerFocus,
    setStoreThreadBranch,
    setThreadError,
    stopActiveThreadSession,
  ]);

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(next.cursor);
      setComposerTrigger(detectComposerTrigger(next.text, next.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(next.cursor);
      });
      return true;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): { value: string; cursor: number } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return { value: promptRef.current, cursor: composerCursor };
  }, [composerCursor]);

  const onAskAboutSelectedText = useCallback(
    (selectedText: string) => {
      const snapshot = readComposerSnapshot();
      const insertion = buildQuotedSelectionInsertion(snapshot.value, selectedText);
      if (!insertion) {
        return;
      }

      promptRef.current = snapshot.value;
      applyPromptReplacement(snapshot.value.length, snapshot.value.length, insertion, {
        expectedText: "",
      });
    },
    [applyPromptReplacement, readComposerSnapshot],
  );

  const onPinSelectedText = useCallback(
    (selection: Omit<PinnedSelectionDraft, "id" | "createdAt">) => {
      if (!activeThread) {
        return;
      }
      const normalizedSelectedText = normalizeSelectedText(selection.selectedText);
      if (!normalizedSelectedText) {
        return;
      }
      addComposerDraftPinnedSelection(activeThread.id, {
        ...selection,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        selectedText: normalizedSelectedText,
      });
      scheduleComposerFocus();
    },
    [activeThread, addComposerDraftPinnedSelection, scheduleComposerFocus],
  );

  const onRemovePinnedSelection = useCallback(
    (pinnedSelectionId: string) => {
      removeComposerDraftPinnedSelection(threadId, pinnedSelectionId);
    },
    [removeComposerDraftPinnedSelection, threadId],
  );

  const onClearPinnedSelections = useCallback(() => {
    clearComposerDraftPinnedSelections(threadId);
  }, [clearComposerDraftPinnedSelections, threadId]);

  const onJumpToPinnedSelection = useCallback((pinnedSelectionId: string) => {
    setPendingPinnedSelectionJumpId(pinnedSelectionId);
  }, []);

  const onPinnedSelectionJumpHandled = useCallback((pinnedSelectionId: string) => {
    setPendingPinnedSelectionJumpId((current) => (current === pinnedSelectionId ? null : current));
  }, []);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    const expandedCursor = expandCollapsedComposerCursor(snapshot.value, snapshot.cursor);
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, expandedCursor),
    };
  }, [readComposerSnapshot]);

  const setComposerPromptValue = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = nextPrompt.length;
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextCursor));
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [setPrompt],
  );

  const handleClearConversation = useCallback(async () => {
    if (!activeProject) {
      toastManager.add({
        type: "warning",
        title: "Clear is unavailable",
        description: "Open a project before starting a fresh thread.",
      });
      return;
    }
    const nextThreadId = newThreadId();
    const createdAt = new Date().toISOString();
    setProjectDraftThreadId(activeProject.id, nextThreadId, {
      createdAt,
      branch: activeThread?.branch ?? null,
      worktreePath: activeThread?.worktreePath ?? null,
      envMode: activeThread?.worktreePath ? "worktree" : "local",
      runtimeMode,
      interactionMode,
    });
    await navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
    });
  }, [
    activeProject,
    activeThread?.branch,
    activeThread?.worktreePath,
    interactionMode,
    navigate,
    runtimeMode,
    setProjectDraftThreadId,
  ]);

  const onSelectNewThreadLandingProject = useCallback(
    async (projectId: ProjectId) => {
      if (projectId.length === 0) {
        return;
      }

      const reusableDraft = getDraftThreadByProjectId(projectId);
      const reusableThreadId =
        reusableDraft &&
        reusableDraft.isTemporary !== true &&
        !threads.some((thread) => thread.id === reusableDraft.threadId)
          ? reusableDraft.threadId
          : null;

      if (reusableThreadId) {
        if (reusableThreadId === threadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: reusableThreadId },
        });
        return;
      }

      const nextThreadId = newThreadId();
      setProjectDraftThreadId(projectId, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: draftThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: draftThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
        envMode: "local",
      });

      if (nextThreadId === threadId) {
        return;
      }
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      draftThread?.interactionMode,
      draftThread?.runtimeMode,
      getDraftThreadByProjectId,
      navigate,
      setProjectDraftThreadId,
      threadId,
      threads,
    ],
  );

  const onAddProjectFromNewThreadLanding = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Unable to add project",
        description: "Native API is unavailable.",
      });
      return;
    }

    const pickedPath = await api.dialogs.pickFolder().catch(() => null);
    const cwd = pickedPath?.trim() ?? "";
    if (!cwd) {
      return;
    }

    const existingProject = projects.find((project) => project.cwd === cwd);
    if (existingProject) {
      await onSelectNewThreadLandingProject(existingProject.id);
      return;
    }

    const projectId = newProjectId();
    const createdAt = new Date().toISOString();
    const title = cwd.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? cwd;
    try {
      await api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title,
        workspaceRoot: cwd,
        defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
        createdAt,
      });

      const snapshot = await api.orchestration.getSnapshot({ mode: "bootstrap" }).catch(() => null);
      if (snapshot) {
        syncServerReadModel(snapshot);
      }

      await onSelectNewThreadLandingProject(projectId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to add project",
        description:
          error instanceof Error ? error.message : "The project could not be created. Try again.",
      });
    }
  }, [onSelectNewThreadLandingProject, projects, syncServerReadModel]);

  const handleStatusCommand = useCallback(() => {
    const defaultMessage = `${selectedProvider} provider is ready.`;
    toastManager.add({
      type: activeProviderStatus?.status === "error" ? "error" : "info",
      title: "Provider status",
      description: activeProviderStatus?.message ?? defaultMessage,
    });
  }, [activeProviderStatus?.message, activeProviderStatus?.status, selectedProvider]);

  const handleForkCommand = useCallback(async () => {
    onHandoffToWorktree();
  }, [onHandoffToWorktree]);

  const handleShortcutCommand = useCallback(
    (command: SelectedComposerShortcut["command"], args: string) => {
      const trimmedArgs = args.trim();
      const shortcut: SelectedComposerShortcut = {
        id: `shortcut:${command}:${crypto.randomUUID()}`,
        command,
        label: selectedComposerShortcutLabel(command),
        args: trimmedArgs,
      };
      setSelectedComposerShortcuts((existing) => [...existing, shortcut]);
      promptRef.current = "";
      setPrompt("");
      setComposerCursor(0);
      setComposerTrigger(null);
      setComposerHighlightedItemId(null);
      scheduleComposerFocus();
    },
    [setPrompt, scheduleComposerFocus],
  );

  const { handleStandaloneSlashCommand, handleSlashCommandSelection } = useComposerSlashCommands({
    selectedProvider,
    providerNativeCommandNames,
    supportsFastSlashCommand,
    fastModeEnabled: selectedCodexFastModeEnabled,
    handleInteractionModeChange,
    handleClearConversation,
    handleForkCommand,
    handleStatusCommand,
    handleShortcutCommand,
    setFastModeFromSlash: onCodexFastModeChange,
    editorActions: {
      resolveActiveComposerTrigger,
      applyPromptReplacement,
      clearComposerSlashDraft: () => {
        promptRef.current = "";
        setPrompt("");
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
      },
      setComposerPromptValue,
      scheduleComposerFocus,
      setComposerHighlightedItemId,
    },
  });

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      const expectedToken = snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd);
      if (item.type === "path") {
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `@${item.path} `,
          { expectedText: expectedToken },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "desktop-app") {
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `@${desktopAppMentionName(item.app)} `,
          {
            expectedText: expectedToken,
          },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        handleSlashCommandSelection(item);
        return;
      }
      if (item.type === "provider-native-command") {
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `/${item.command} `,
          {
            expectedText: expectedToken,
          },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `${skillMentionPrefix()}${item.skill.name} `,
          {
            expectedText: expectedToken,
          },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "plugin") {
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `${skillMentionPrefix()}${item.plugin.name} `,
          {
            expectedText: expectedToken,
          },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      onProviderModelSelect(item.provider, item.model);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: expectedToken,
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
    },
    [
      applyPromptReplacement,
      handleSlashCommandSelection,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching)) ||
    ((composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
      providerCommandsQuery.isFetching) ||
    ((composerTriggerKind === "skill" || composerTriggerKind === "slash-command") &&
      (providerSkillsQuery.isFetching || providerPluginsQuery.isFetching));

  const onPromptChange = useCallback(
    (nextPrompt: string, nextCursor: number, cursorAdjacentToMention: boolean) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention
          ? null
          : detectComposerTrigger(
              nextPrompt,
              expandCollapsedComposerCursor(nextPrompt, nextCursor),
            ),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Backspace",
    event: KeyboardEvent,
  ) => {
    if (
      key === "Backspace" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      promptRef.current.length === 0 &&
      (selectedComposerExtensions.length > 0 ||
        selectedComposerShortcuts.length > 0 ||
        composerInspectCaptures.length > 0)
    ) {
      if (selectedComposerExtensions.length > 0) {
        setSelectedComposerExtensions((existing) => existing.slice(0, -1));
      } else if (selectedComposerShortcuts.length > 0) {
        setSelectedComposerShortcuts((existing) => existing.slice(0, -1));
      } else if (activeThread) {
        const lastCapture = composerInspectCaptures.at(-1);
        if (lastCapture) {
          removeComposerDraftInspectCapture(activeThread.id, lastCapture.id);
        }
      }
      return true;
    }

    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend(undefined, event.metaKey || event.ctrlKey ? "steer" : "queue");
      return true;
    }
    return false;
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) =>
          withDiffSelection(previous as Record<string, unknown>, {
            turnId,
            ...(filePath ? { filePath } : {}),
          }),
      });
    },
    [navigate, threadId],
  );
  const onRevertUserMessage = (messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-thread-surface)] text-muted-foreground/40">
        {!isElectron && (
          <header className="px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarInsetTrigger className="shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
        {usesDesktopAppChrome && (
          <div
            className="flex h-[var(--app-desktop-content-header-height)] shrink-0 items-center px-3 sm:px-5"
            data-testid="chat-empty-top-row"
          >
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-thread-surface)]"
      data-testid="chat-view-root"
    >
      {/* Top bar */}
      <header
        className={cn(
          "flex shrink-0 items-center px-3 sm:px-5",
          usesDesktopAppChrome ? "h-[var(--app-desktop-content-header-height)]" : "py-2 sm:py-3",
        )}
        data-testid="chat-top-header"
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          activeTaskTitle={activeTask?.title ?? null}
          isGitRepo={isGitRepo}
          openInCwd={threadWorkspaceCwd}
          activeProjectScripts={activeProject?.scripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          handoffBadgeLabel={handoffBadgeLabel}
          handoffActionLabel={handoffActionLabel}
          handoffDisabled={handoffDisabled}
          handoffActionTargetProvider={handoffTargetProvider}
          handoffTargetProviderCount={handoffTargetProviders.length}
          handoffBadgeSourceProvider={handoffBadgeSourceProvider}
          handoffBadgeTargetProvider={handoffBadgeTargetProvider}
          terminalOpen={terminalState.terminalOpen}
          filesRailOpen={filesRailOpen}
          browserPaneOpen={resolvedBrowserPaneOpen}
          diffOpen={resolvedDiffOpen}
          surfaceMode={surfaceMode}
          isFocusedPane={isFocusedPane}
          {...(onSplitSurface ? { onSplitSurface } : {})}
          {...(onMaximizeSurface ? { onMaximizeSurface } : {})}
          onRunProjectScript={(script) => {
            void runProjectScript(script);
          }}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onOpenTask={
            activeTask
              ? () => {
                  void navigate({
                    to: "/orchestrate",
                    search: {
                      projectId: activeThread.projectId,
                      taskId: activeTask.id,
                    },
                  });
                }
              : null
          }
          onToggleTerminal={toggleTerminalVisibility}
          onToggleFiles={onToggleFiles}
          onToggleDiff={onToggleDiff}
          onToggleBrowser={onToggleBrowser}
          onCreateHandoff={onCreateProviderHandoffThread}
          onCycleHandoffTargetProvider={onCycleHandoffTargetProvider}
        />
      </header>

      {/* Error banner */}
      <div className="shrink-0">
        <ProviderHealthBanner status={activeProviderStatus} />
        <ThreadErrorBanner error={activeThread.error} />
        <PlanModePanel activePlan={activePlan} />
      </div>

      {!resolvedDiffOpen && !resolvedBrowserPaneOpen ? (
        <ThreadContextPanel
          thread={activeThread}
          gitCwd={gitCwd}
          workspaceCwd={threadWorkspaceCwd}
          homeDirectory={homeDirectory ?? undefined}
          activeThreadId={activeThread.id}
          onOpenFilePath={onOpenFilePath}
          onOpenChanges={onToggleDiff}
        />
      ) : null}

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={setMessagesScrollContainerRef}
          className="min-h-0 size-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
          data-testid="chat-messages-scroll-container"
          onScroll={onMessagesScroll}
          onClickCapture={onMessagesClickCapture}
          onWheel={onMessagesWheel}
          onPointerDown={onMessagesPointerDown}
          onPointerUp={onMessagesPointerUp}
          onPointerCancel={onMessagesPointerCancel}
          onTouchStart={onMessagesTouchStart}
          onTouchMove={onMessagesTouchMove}
          onTouchEnd={onMessagesTouchEnd}
          onTouchCancel={onMessagesTouchEnd}
        >
          {shouldShowNewThreadLanding ? (
            <div
              data-testid="chat-new-thread-landing"
              data-thread-id={activeThread.id}
              className="flex h-full items-center justify-center"
            >
              <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center">
                <h3 className="text-xl font-normal text-foreground/90">Let's build</h3>
                {activeProject && !isActiveHomeProject ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 max-w-full gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground"
                          data-testid="chat-new-thread-project-picker-trigger"
                          aria-label="Choose project"
                        />
                      }
                    >
                      {isActiveHomeProject ? (
                        <MessageSquareIcon className="size-3.5 shrink-0" />
                      ) : (
                        <FolderClosedIcon className="size-3.5 shrink-0" />
                      )}
                      <span className="max-w-64 truncate">
                        {isActiveHomeProject ? "Chat" : activeProject.name}
                      </span>
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    </MenuTrigger>
                    <MenuPopup align="center" side="bottom">
                      {projectPickerProjects.map((project) => (
                        <MenuItem
                          key={project.id}
                          data-testid={`chat-new-thread-project-option-${project.id}`}
                          onClick={() => {
                            void onSelectNewThreadLandingProject(project.id);
                          }}
                        >
                          {project.name}
                        </MenuItem>
                      ))}
                      <MenuDivider />
                      <MenuItem
                        data-testid="chat-new-thread-project-option-add"
                        onClick={() => {
                          void onAddProjectFromNewThreadLanding();
                        }}
                      >
                        <PlusIcon className="size-3.5" />
                        Add project
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                ) : null}
              </div>
            </div>
          ) : (
            <MessagesTimeline
              key={activeThread.id}
              isFocusedPane={isFocusedPane}
              hasMessages={timelineEntries.length > 0}
              isWorking={isWorking}
              activeTurnInProgress={!latestTurnSettled}
              threadId={activeThread.id}
              activeTurnStartedAt={activeLatestTurn?.startedAt ?? null}
              scrollContainer={messagesScrollElement}
              timelineEntries={timelineEntries}
              completionDividerBeforeEntryId={completionDividerBeforeEntryId}
              completionSummary={completionSummary}
              turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
              turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
              nowIso={nowIso}
              expandedWorkGroups={expandedWorkGroups}
              onToggleWorkGroup={onToggleWorkGroup}
              onOpenTurnDiff={onOpenTurnDiff}
              revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
              onRevertUserMessage={onRevertUserMessage}
              isRevertingCheckpoint={isRevertingCheckpoint}
              onImageExpand={onExpandTimelineImage}
              onOpenThread={(threadId) => {
                void navigate({
                  to: "/$threadId",
                  params: { threadId },
                });
              }}
              onOpenFilePath={onOpenFilePath}
              markdownCwd={threadWorkspaceCwd ?? undefined}
              resolvedTheme={resolvedTheme}
              workspaceRoot={threadWorkspaceCwd ?? undefined}
              homeDirectory={homeDirectory ?? undefined}
              pinnedSelections={composerPinnedSelections}
              onAskAboutSelectedText={onAskAboutSelectedText}
              onPinSelectedText={onPinSelectedText}
              onRemovePinnedSelection={onRemovePinnedSelection}
              pendingPinnedSelectionJumpId={pendingPinnedSelectionJumpId}
              onPinnedSelectionJumpHandled={onPinnedSelectionJumpHandled}
              userMessageMentionDescriptors={userMessageMentionDescriptors}
            />
          )}
        </div>
        {showScrollToBottomPill ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:bottom-4 sm:px-5">
            <Button
              variant="outline"
              size="sm"
              className="pointer-events-auto h-9 rounded-full border-border/80 bg-background/90 px-3.5 shadow-lg shadow-black/5 backdrop-blur supports-[backdrop-filter]:bg-background/75"
              onClick={onScrollToBottomClick}
              data-scroll-to-bottom-pill="true"
            >
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
              Scroll to bottom
            </Button>
          </div>
        ) : null}
      </div>

      {/* Input bar */}
      <div
        className={cn(
          floatingComposer
            ? "fixed bottom-6 left-1/2 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 px-0 pb-0 pt-0"
            : "px-3 pt-4 sm:px-5 sm:pt-4",
          !floatingComposer && (isGitRepo ? "pb-1" : "pb-2.5 sm:pb-3"),
        )}
      >
        {showNewThreadSuggestionsLoading ? (
          <div
            className="mx-auto mb-3 w-full max-w-3xl rounded-xl border border-border/60 bg-card/60 px-3 py-3 text-sm text-muted-foreground"
            data-testid="chat-new-thread-suggestions-loading"
          >
            Reviewing current changes for suggested tasks...
          </div>
        ) : null}
        {shouldShowNewThreadSuggestions && newThreadSuggestionCount > 0 ? (
          <div className="mx-auto mb-3 w-full max-w-3xl" data-testid="chat-new-thread-suggestions">
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Suggested tasks
            </div>
            <div className="overflow-hidden rounded-xl">
              {visibleNewThreadSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  type="button"
                  data-testid={`chat-new-thread-suggestion-${suggestion.id}`}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2.5 px-3 py-3 text-left text-sm text-foreground/88 transition-colors hover:bg-accent/35",
                    index < newThreadSuggestionCount - 1 && "mb-px",
                  )}
                  onClick={() => applyNewThreadSuggestion(suggestion.prompt)}
                >
                  <span className="mt-0.5 shrink-0 rounded-full p-1 text-muted-foreground/75">
                    <MessageSquareIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0 leading-5">{suggestion.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 mx-auto w-full min-w-0 max-w-3xl"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
        >
          {queuedComposerTurns.length > 0 ? (
            <div className="mx-auto flex w-5/6 flex-col">
              {queuedComposerTurns.map((queuedTurn) => (
                <div
                  key={queuedTurn.id}
                  data-testid="queued-follow-up-row"
                  className="flex items-center gap-2 rounded-t-sm border border-b-0 border-border/60 bg-card px-2.5 py-2 text-[12px]"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Undo2Icon className="size-3 shrink-0 text-muted-foreground/70" />
                    <span className="truncate text-[12px] font-medium text-foreground/85">
                      {queuedTurn.previewText}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-0">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg bg-muted/80 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                      onClick={() => void onSteerQueuedComposerTurn(queuedTurn)}
                    >
                      <Undo2Icon className="size-3" />
                      <span>Steer</span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                      aria-label="Delete queued follow-up"
                      onClick={() => removeQueuedComposerTurn(queuedTurn.id)}
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <button
                            type="button"
                            className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                            aria-label="Queued follow-up actions"
                          />
                        }
                      >
                        <EllipsisIcon className="size-3" />
                      </MenuTrigger>
                      <MenuPopup align="end" side="top">
                        <MenuItem onClick={() => onEditQueuedComposerTurn(queuedTurn)}>
                          Edit queued prompt
                        </MenuItem>
                        <MenuItem onClick={() => removeQueuedComposerTurn(queuedTurn.id)}>
                          Delete queued prompt
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div
            className="group rounded-2xl p-px transition-colors duration-200"
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <div
              className={cn(
                "rounded-md border bg-card transition-colors duration-200 focus-within:border-neutral-500/15",
                isDragOverComposer ? "border-primary/50 bg-accent/20" : "border-border/60",
              )}
            >
              {activePendingApproval ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={effectivePendingApprovals.length}
                  />
                </div>
              ) : effectivePendingUserInputs.length > 0 ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={effectivePendingUserInputs}
                    respondingRequestIds={respondingUserInputRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onSelectOption={onSelectActivePendingUserInputOption}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : null}

              {/* Textarea area */}
              <div className="relative px-4 pb-1 pt-3.5">
                {composerMenuOpen && !isComposerApprovalState && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                    <ComposerCommandMenu
                      items={composerMenuItems}
                      resolvedTheme={resolvedTheme}
                      isLoading={isComposerMenuLoading}
                      triggerKind={composerTriggerKind}
                      activeItemId={activeComposerMenuItem?.id ?? null}
                      onHighlightedItemChange={onComposerMenuItemHighlighted}
                      onSelect={onSelectComposerItem}
                    />
                  </div>
                )}

                {!isComposerApprovalState &&
                effectivePendingUserInputs.length === 0 &&
                (selectedComposerShortcuts.length > 0 ||
                  composerInspectCaptures.length > 0 ||
                  filePanelCommentCount > 0) ? (
                  <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {filePanelCommentCount > 0 ? (
                      <button
                        type="button"
                        className="group inline-flex shrink-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm font-medium text-amber-500 outline-none transition-colors hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-400/45 dark:text-amber-400"
                        title="Clear local review comments"
                        aria-label="Clear local review comments"
                        onClick={() => {
                          if (activeThread) {
                            clearFilePanelComments(activeThread.id);
                          }
                          scheduleComposerFocus();
                        }}
                      >
                        <SelectedLocalCommentIcon />
                        <span className="max-w-52 truncate">
                          {filePanelCommentCount}{" "}
                          {filePanelCommentCount === 1 ? "comment" : "comments"}
                        </span>
                        <XIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
                      </button>
                    ) : null}
                    {composerInspectCaptures.map((capture) => (
                      <button
                        type="button"
                        key={capture.id}
                        className="group inline-flex shrink-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm font-medium text-cyan-500 outline-none transition-colors hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-400/45 dark:text-cyan-400"
                        title={`Remove inspected element: ${capture.label}`}
                        aria-label={`Remove inspected element: ${capture.label}`}
                        onClick={() => {
                          if (activeThread) {
                            removeComposerDraftInspectCapture(activeThread.id, capture.id);
                          }
                          scheduleComposerFocus();
                        }}
                      >
                        <SelectedInspectCaptureIcon />
                        <span className="max-w-52 truncate">Inspect: {capture.label}</span>
                        <XIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
                      </button>
                    ))}
                    {selectedComposerShortcuts.map((shortcut) => (
                      <button
                        type="button"
                        key={shortcut.id}
                        className="group inline-flex shrink-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm font-medium text-emerald-400 outline-none transition-colors hover:bg-emerald-400/10 focus-visible:ring-2 focus-visible:ring-emerald-400/45"
                        title={`Remove ${shortcut.label}`}
                        aria-label={`Remove ${shortcut.label}`}
                        onClick={() => {
                          setSelectedComposerShortcuts((existing) =>
                            removeSelectedComposerShortcutById(existing, shortcut.id),
                          );
                          scheduleComposerFocus();
                        }}
                      >
                        <SelectedComposerShortcutIcon shortcut={shortcut} />
                        <span className="max-w-40 truncate">
                          {shortcut.args ? `${shortcut.label}: ${shortcut.args}` : shortcut.label}
                        </span>
                        <XIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
                      </button>
                    ))}
                  </div>
                ) : null}

                {!isComposerApprovalState &&
                effectivePendingUserInputs.length === 0 &&
                composerPinnedSelections.length > 0 ? (
                  <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {composerPinnedSelections.map((selection, index) => (
                      <div
                        key={selection.id}
                        className="group/pinned-pill relative inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground/90"
                      >
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full pr-0.5 text-left text-foreground/90 transition-[padding,color] hover:text-foreground group-hover/pinned-pill:pr-5 group-focus-within/pinned-pill:pr-5"
                          onClick={() => onJumpToPinnedSelection(selection.id)}
                          title={selection.selectedText}
                        >
                          <PinIcon className="size-3" />
                          <span className="font-medium">{index + 1}</span>
                          <span className="max-w-44 truncate">{selection.selectedText}</span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-events-none absolute right-1 top-1/2 size-4 -translate-y-1/2 rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/pinned-pill:pointer-events-auto group-hover/pinned-pill:opacity-100 group-focus-within/pinned-pill:pointer-events-auto group-focus-within/pinned-pill:opacity-100"
                          onClick={() => onRemovePinnedSelection(selection.id)}
                          aria-label={`Remove pinned passage ${index + 1}`}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </div>
                    ))}
                    {composerPinnedSelections.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={onClearPinnedSelections}
                      >
                        Clear all
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {!isComposerApprovalState &&
                  effectivePendingUserInputs.length === 0 &&
                  composerImages.length > 0 && (
                    <div className="mb-2.5 flex flex-wrap gap-1.5">
                      {composerImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative h-14 w-14 overflow-hidden rounded-md border border-border/50 bg-background"
                        >
                          {image.type === "image" && image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(composerImages, image.id);
                                if (!preview) return;
                                setExpandedImage(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-center text-[10px] text-muted-foreground/70">
                              {image.type === "pdf" ? (
                                <>
                                  <span className="font-medium uppercase tracking-wide text-foreground/75">
                                    PDF
                                  </span>
                                  <span className="line-clamp-2">{image.name}</span>
                                </>
                              ) : (
                                image.name
                              )}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                  >
                                    <CircleAlertIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                            onClick={() => removeComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                <ComposerPromptEditor
                  ref={composerEditorRef}
                  value={
                    isComposerApprovalState
                      ? ""
                      : activePendingProgress
                        ? activePendingProgress.customAnswer
                        : prompt
                  }
                  cursor={composerCursor}
                  onChange={onPromptChange}
                  onCommandKeyDown={onComposerCommandKey}
                  onPaste={onComposerPaste}
                  placeholder={
                    isComposerApprovalState
                      ? (activePendingApproval?.detail ??
                        "Resolve this approval request to continue")
                      : activePendingProgress
                        ? "Type your own answer, or leave this blank to use the selected option"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : floatingComposer
                            ? "Ask for follow-up changes"
                            : phase === "running"
                              ? "Ask for follow-up changes"
                              : phase === "disconnected"
                                ? "Ask for follow-up changes or attach images"
                                : "Ask anything, @tag files/folders, or use / to show available commands"
                  }
                  disabled={isConnecting || isComposerApprovalState}
                  mentionDescriptors={composerMentionDescriptors}
                />
              </div>

              {/* Bottom toolbar */}
              {activePendingApproval ? (
                <div className="flex items-center justify-end gap-2 px-3.5 pb-2.5">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  data-chat-composer-footer="true"
                  className={cn(
                    "flex items-end justify-between px-3 pb-2.5",
                    isComposerFooterCompact
                      ? "gap-1.5"
                      : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                  )}
                >
                  <div
                    className={cn(
                      "flex min-w-0 flex-1 items-center",
                      isComposerFooterCompact
                        ? "gap-1 overflow-hidden"
                        : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                    )}
                  >
                    <ComposerExtrasMenu
                      interactionMode={interactionMode}
                      showInteractionModeToggle={selectedProvider !== "opencode"}
                      supportsFastMode={selectedProvider === "codex"}
                      fastModeEnabled={selectedCodexFastModeEnabled}
                      onAddPhotos={addComposerImages}
                      onSetFastMode={onCodexFastModeChange}
                      onSetPlanMode={(enabled) => {
                        handleInteractionModeChange(enabled ? "plan" : "default");
                      }}
                    />

                    {/* Provider/model picker */}
                    <ProviderModelPicker
                      compact={isComposerFooterCompact}
                      provider={selectedProvider}
                      model={selectedModelForPickerWithCustomFallback}
                      lockedProvider={lockedProvider}
                      modelOptionsByProvider={modelOptionsByProvider}
                      serviceTierSetting={selectedServiceTierSetting}
                      onProviderModelChange={onProviderModelSelect}
                    />

                    {isComposerFooterCompact ? (
                      <CompactComposerControlsMenu
                        traitsMenuContent={compactTraitsMenuContent}
                        interactionMode={interactionMode}
                        showInteractionModeToggle={selectedProvider !== "opencode"}
                        onToggleInteractionMode={toggleInteractionMode}
                        {...(showRuntimeControlInComposer
                          ? {
                              runtimeMode,
                              onToggleRuntimeMode: toggleRuntimeMode,
                            }
                          : {})}
                      />
                    ) : null}

                    {isComposerFooterCompact ? null : (
                      <>
                        {selectedProvider === "codex" && selectedEffort != null ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            <CodexTraitsPicker
                              effort={selectedEffort}
                              fastModeEnabled={selectedCodexFastModeEnabled}
                              options={reasoningOptions}
                              onEffortChange={onEffortSelect}
                              onFastModeChange={onCodexFastModeChange}
                            />
                          </>
                        ) : null}
                        {selectedProvider === "opencode" &&
                        ((selectedOpencodeModelCapabilities?.variantOptions?.length ?? 0) > 0 ||
                          (selectedOpencodeModelCapabilities?.agentOptions?.length ?? 0) > 0) ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            <OpenCodeTraitsPicker
                              variantOptions={
                                selectedOpencodeModelCapabilities?.variantOptions ?? []
                              }
                              agentOptions={selectedOpencodeModelCapabilities?.agentOptions ?? []}
                              selectedVariant={selectedOpencodeVariant}
                              selectedAgent={selectedOpencodeAgent}
                              onVariantChange={onOpencodeVariantChange}
                              onAgentChange={onOpencodeAgentChange}
                            />
                          </>
                        ) : null}

                        {/* Divider */}
                        {selectedProvider !== "opencode" ? (
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />
                        ) : null}

                        {/* Interaction mode toggle */}
                        {selectedProvider !== "opencode" ? (
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                            size="sm"
                            type="button"
                            onClick={toggleInteractionMode}
                            title={
                              interactionMode === "plan"
                                ? "Plan mode — click to return to normal chat mode"
                                : "Default mode — click to enter plan mode"
                            }
                          >
                            <BotIcon />
                            <span className="sr-only sm:not-sr-only">
                              {interactionMode === "plan" ? "Plan" : "Chat"}
                            </span>
                          </Button>
                        ) : null}

                        {showRuntimeControlInComposer ? (
                          <>
                            {/* Divider */}
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />

                            {/* Runtime mode toggle */}
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                              size="sm"
                              type="button"
                              onClick={toggleRuntimeMode}
                              title={
                                runtimeMode === "full-access"
                                  ? "Full access applies to future turns in this thread. Click for approvals."
                                  : "Approval required for this turn. Click to enable full access for this thread."
                              }
                            >
                              {runtimeMode === "full-access"
                                ? "Full access (thread)"
                                : "Supervised"}
                            </Button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>

                  {/* Right side: send / stop button */}
                  <div
                    data-chat-composer-actions="right"
                    className="flex shrink-0 items-center gap-2"
                  >
                    {isPreparingWorktree ? (
                      <span className="text-muted-foreground/70 text-xs">
                        Preparing worktree...
                      </span>
                    ) : null}
                    {activePendingProgress ? (
                      <div className="flex items-center gap-2">
                        {activePendingProgress.questionIndex > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            onClick={onPreviousActivePendingUserInputQuestion}
                            disabled={activePendingIsResponding}
                          >
                            Previous
                          </Button>
                        ) : null}
                        <Button
                          type="submit"
                          size="sm"
                          className="rounded-full px-4"
                          disabled={
                            activePendingIsResponding ||
                            (activePendingProgress.isLastQuestion
                              ? !activePendingResolvedAnswers
                              : !activePendingProgress.canAdvance)
                          }
                        >
                          {activePendingIsResponding
                            ? "Submitting..."
                            : activePendingProgress.isLastQuestion
                              ? "Submit answers"
                              : "Next question"}
                        </Button>
                      </div>
                    ) : phase === "running" ? (
                      <button
                        type="button"
                        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-foreground/80 text-background transition-all duration-150 hover:bg-foreground hover:scale-105"
                        onClick={() => void onInterrupt()}
                        aria-label="Stop generation"
                        title="Stop the current response. Press Enter to queue or Cmd/Ctrl+Enter to steer."
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <rect x="3" y="3" width="10" height="10" rx="2" />
                        </svg>
                      </button>
                    ) : effectivePendingUserInputs.length === 0 ? (
                      showPlanFollowUpPrompt ? (
                        prompt.trim().length > 0 ? (
                          <Button
                            type="submit"
                            size="sm"
                            className="h-9 rounded-full px-4 sm:h-8"
                            disabled={isSendBusy || isConnecting}
                          >
                            {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                          </Button>
                        ) : (
                          <div className="flex items-center">
                            <Button
                              type="submit"
                              size="sm"
                              className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                              disabled={isSendBusy || isConnecting}
                            >
                              {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                            </Button>
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                    aria-label="Implementation actions"
                                    disabled={isSendBusy || isConnecting}
                                  />
                                }
                              >
                                <ChevronDownIcon className="size-3.5" />
                              </MenuTrigger>
                              <MenuPopup align="end" side="top">
                                <MenuItem
                                  disabled={isSendBusy || isConnecting}
                                  onClick={() => void onImplementPlanInNewThread()}
                                >
                                  Implement in new thread
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          </div>
                        )
                      ) : (
                        <button
                          type="submit"
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/80 text-background transition-all duration-150 hover:bg-foreground hover:scale-105 disabled:opacity-20 disabled:hover:scale-100 sm:h-7 sm:w-7"
                          disabled={
                            isSendBusy ||
                            isConnecting ||
                            (!prompt.trim() &&
                              selectedComposerExtensions.length === 0 &&
                              composerImages.length === 0)
                          }
                          aria-label={
                            isConnecting
                              ? "Connecting"
                              : isPreparingWorktree
                                ? "Preparing worktree"
                                : isSendBusy
                                  ? "Sending"
                                  : "Send message"
                          }
                        >
                          {isConnecting || isSendBusy ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              className="animate-spin"
                              aria-hidden="true"
                            >
                              <circle
                                cx="7"
                                cy="7"
                                r="5.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeDasharray="20 12"
                              />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      )
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>

      {(() => {
        if (!terminalState.terminalOpen || !activeProject) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
            threadId={activeThread.id}
            cwd={activeThread.worktreePath ?? gitCwd ?? activeProject.cwd}
            runtimeEnv={threadTerminalRuntimeEnv}
            height={terminalState.terminalHeight}
            terminalIds={terminalState.terminalIds}
            activeTerminalId={terminalState.activeTerminalId}
            terminalGroups={terminalState.terminalGroups}
            activeTerminalGroupId={terminalState.activeTerminalGroupId}
            focusRequestId={terminalFocusRequestId}
            onSplitTerminal={splitTerminal}
            onNewTerminal={createNewTerminal}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            onActiveTerminalChange={activateTerminal}
            onCloseTerminal={closeTerminal}
            onHeightChange={setTerminalHeight}
          />
        );
      })()}

      <ExpandedImagePreviewDialog
        preview={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
      <ThreadWorktreeHandoffDialog
        open={worktreeHandoffDialogOpen}
        busy={handoffBusy}
        worktreeName={worktreeHandoffName}
        onWorktreeNameChange={setWorktreeHandoffName}
        onOpenChange={setWorktreeHandoffDialogOpen}
        onConfirm={confirmWorktreeHandoff}
      />
    </div>
  );
}

interface ThreadContextPanelProps {
  thread: Thread;
  gitCwd: string | null;
  workspaceCwd: string | null;
  homeDirectory: string | undefined;
  activeThreadId: ThreadId;
  onOpenFilePath: (
    path: string,
    options?: { cwd?: string | undefined; displayName?: string | undefined },
  ) => void;
  onOpenChanges: () => void;
}

function readThreadContextPanelPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = localStorage.getItem(key);
  if (value === null) {
    return fallback;
  }
  return value === "true";
}

function persistThreadContextPanelPreference(key: string, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(key, value ? "true" : "false");
}

function ThreadContextCollapsibleSection(props: {
  title: string;
  count: number;
  collapsed: boolean;
  emptyLabel: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { title, count, collapsed, emptyLabel, onToggle, children } = props;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground/80 transition-colors hover:bg-muted/45 hover:text-foreground/78"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            collapsed ? "-rotate-90" : "rotate-0",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/55">{count}</span>
      </button>
      {collapsed ? null : count > 0 ? (
        <div className="max-h-44 space-y-1 overflow-y-auto pr-1">{children}</div>
      ) : (
        <p className="px-1.5 py-1.5 text-xs text-muted-foreground/55">{emptyLabel}</p>
      )}
    </div>
  );
}

const ThreadContextPanel = memo(function ThreadContextPanel({
  thread,
  gitCwd,
  workspaceCwd,
  homeDirectory,
  activeThreadId,
  onOpenFilePath,
  onOpenChanges,
}: ThreadContextPanelProps) {
  const [pinned, setPinned] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return localStorage.getItem(THREAD_CONTEXT_PANEL_PINNED_KEY) !== "false";
  });
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() =>
    readThreadContextPanelPreference(THREAD_CONTEXT_PANEL_ARTIFACTS_COLLAPSED_KEY, false),
  );
  const [sourcesCollapsed, setSourcesCollapsed] = useState(() =>
    readThreadContextPanelPreference(THREAD_CONTEXT_PANEL_SOURCES_COLLAPSED_KEY, false),
  );
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const progressItems = useMemo(() => collectThreadContextProgress(thread), [thread]);
  const artifacts = useMemo(
    () => collectThreadContextArtifacts({ thread, homeDirectory }),
    [homeDirectory, thread],
  );
  const sources = useMemo(() => collectThreadContextSources(thread), [thread]);
  const hasGitContext = gitCwd !== null;
  const hasChanges =
    (gitStatus?.workingTree.insertions ?? 0) > 0 || (gitStatus?.workingTree.deletions ?? 0) > 0;

  const togglePinned = useCallback(() => {
    setPinned((current) => {
      const next = !current;
      localStorage.setItem(THREAD_CONTEXT_PANEL_PINNED_KEY, next ? "true" : "false");
      return next;
    });
  }, []);
  const toggleArtifactsCollapsed = useCallback(() => {
    setArtifactsCollapsed((current) => {
      const next = !current;
      persistThreadContextPanelPreference(THREAD_CONTEXT_PANEL_ARTIFACTS_COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  const toggleSourcesCollapsed = useCallback(() => {
    setSourcesCollapsed((current) => {
      const next = !current;
      persistThreadContextPanelPreference(THREAD_CONTEXT_PANEL_SOURCES_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const panel = (
    <aside
      className={cn(
        "w-64 overflow-hidden rounded-lg border border-border/70 bg-background/88 text-sm text-foreground shadow-none backdrop-blur supports-[backdrop-filter]:bg-background/76",
        "transition-[opacity,transform] duration-150",
        pinned
          ? "opacity-100"
          : "pointer-events-none translate-x-2 opacity-0 group-hover/thread-context:pointer-events-auto group-hover/thread-context:translate-x-0 group-hover/thread-context:opacity-100 focus-within:pointer-events-auto focus-within:translate-x-0 focus-within:opacity-100",
      )}
      aria-label={hasGitContext ? "Branch details" : "Thread context"}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-sm font-medium text-foreground/82">
          {progressItems.length > 0 ? "Progress" : hasGitContext ? "Branch details" : "Context"}
        </p>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-7 text-muted-foreground/70 hover:text-foreground"
          aria-label={pinned ? "Unpin branch details" : "Pin branch details"}
          onClick={togglePinned}
        >
          {pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
        </Button>
      </div>

      <div className="px-3 pb-3">
        {progressItems.length > 0 ? (
          <>
            <div className="space-y-1">
              {progressItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-md px-1.5 py-1.5 text-foreground/78"
                  title={item.label}
                >
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none",
                      item.status === "completed"
                        ? "border-muted-foreground/35 bg-muted-foreground/80 text-background"
                        : item.status === "failed"
                          ? "border-destructive/45 text-destructive"
                          : item.status === "inProgress"
                            ? "border-muted-foreground/45 text-muted-foreground"
                            : "border-muted-foreground/30 text-muted-foreground/60",
                    )}
                    aria-hidden="true"
                  >
                    {item.status === "completed" ? (
                      <span className="size-1.5 rounded-full bg-background" />
                    ) : item.status === "failed" ? (
                      "!"
                    ) : item.status === "inProgress" ? (
                      <span className="size-1.5 rounded-full bg-muted-foreground/70" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 text-sm leading-5 line-clamp-2">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {hasGitContext ? (
              <>
                <Separator className="my-3 bg-border/60" />
                <p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground/80">
                  Branch details
                </p>
              </>
            ) : null}
          </>
        ) : null}

        {hasGitContext ? (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/45"
              onClick={onOpenChanges}
            >
              <BoxIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-foreground/88">Changes</span>
              {hasChanges ? (
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-success">+{gitStatus?.workingTree.insertions ?? 0}</span>
                  <span className="px-1 text-muted-foreground/50"> </span>
                  <span className="text-destructive">-{gitStatus?.workingTree.deletions ?? 0}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground/60">clean</span>
              )}
            </button>

            <div className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5">
              <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-foreground/88">Git actions</span>
              <div className="shrink-0">
                <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
              </div>
            </div>

            <Separator className="my-2 bg-border/60" />
          </>
        ) : null}

        <ThreadContextCollapsibleSection
          title="Artifacts"
          count={artifacts.length}
          collapsed={artifactsCollapsed}
          emptyLabel="No artifacts yet"
          onToggle={toggleArtifactsCollapsed}
        >
          {artifacts.map((artifact) => (
            <button
              type="button"
              key={`${artifact.kind}:${artifact.path}`}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/45"
              title={artifact.path}
              onClick={() =>
                onOpenFilePath(artifact.path, {
                  cwd: artifact.cwd ?? workspaceCwd ?? undefined,
                  displayName: artifact.label,
                })
              }
            >
              {extensionOf(artifact.path) === "png" ||
              extensionOf(artifact.path) === "jpg" ||
              extensionOf(artifact.path) === "jpeg" ||
              extensionOf(artifact.path) === "webp" ||
              extensionOf(artifact.path) === "gif" ? (
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FilesIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground/88">{artifact.label}</span>
            </button>
          ))}
        </ThreadContextCollapsibleSection>

        <Separator className="my-2 bg-border/60" />

        <ThreadContextCollapsibleSection
          title="Sources"
          count={sources.length}
          collapsed={sourcesCollapsed}
          emptyLabel="No sources yet"
          onToggle={toggleSourcesCollapsed}
        >
          {sources.map((source) => (
            <div
              key={source.id}
              className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-foreground/72"
            >
              {source.icon === "web" ? (
                <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : source.icon === "browser" ? (
                <MousePointer2Icon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FilesIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{source.label}</span>
            </div>
          ))}
        </ThreadContextCollapsibleSection>
      </div>
    </aside>
  );

  return (
    <div
      className={cn(
        "group/thread-context absolute right-3 top-16 z-30 hidden lg:block",
        pinned ? "pointer-events-auto" : "pointer-events-none bottom-4 w-8",
      )}
    >
      {!pinned ? (
        <div
          className="pointer-events-auto absolute right-0 top-0 h-28 w-2 rounded-full bg-border/45 opacity-45 transition-colors hover:bg-border hover:opacity-80"
          aria-hidden="true"
        />
      ) : null}
      <div className={pinned ? "" : "absolute right-0 top-0"}>{panel}</div>
    </div>
  );
});

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeTaskTitle: string | null;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  handoffBadgeLabel: string | null;
  handoffActionLabel: string;
  handoffDisabled: boolean;
  handoffActionTargetProvider: ProviderKind | null;
  handoffTargetProviderCount: number;
  handoffBadgeSourceProvider: ProviderKind | null;
  handoffBadgeTargetProvider: ProviderKind | null;
  terminalOpen: boolean;
  filesRailOpen: boolean;
  browserPaneOpen: boolean;
  diffOpen: boolean;
  surfaceMode: "single" | "split";
  isFocusedPane: boolean;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onOpenTask: (() => void) | null;
  onToggleTerminal: () => void;
  onToggleFiles: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onCreateHandoff: () => void;
  onCycleHandoffTargetProvider: (direction: 1 | -1) => void;
}

const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  activeTaskTitle,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  handoffBadgeLabel,
  handoffActionLabel,
  handoffDisabled,
  handoffActionTargetProvider,
  handoffTargetProviderCount,
  handoffBadgeSourceProvider,
  handoffBadgeTargetProvider,
  terminalOpen,
  filesRailOpen,
  browserPaneOpen,
  diffOpen,
  surfaceMode,
  isFocusedPane,
  onSplitSurface,
  onMaximizeSurface,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onOpenTask,
  onToggleTerminal,
  onToggleFiles,
  onToggleDiff,
  onToggleBrowser,
  onCreateHandoff,
  onCycleHandoffTargetProvider,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const needsDesktopTrafficLightInset = isElectron && !isMobile && state === "collapsed";
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const isDisposableThread = useIsDisposableThread(activeThreadId);
  const chatLayoutAction =
    surfaceMode === "single" && onSplitSurface
      ? { kind: "split" as const, label: "Split chat", onClick: onSplitSurface }
      : surfaceMode === "split" && isFocusedPane && onMaximizeSurface
        ? { kind: "maximize" as const, label: "Expand this chat", onClick: onMaximizeSurface }
        : null;
  const [handoffFlipDirection, setHandoffFlipDirection] = useState<1 | -1 | 0>(0);
  const handoffWheelAccumRef = useRef(0);
  const handoffWheelCooldownUntilRef = useRef(0);
  const handoffWheelLastEventAtRef = useRef(0);
  const handoffCanCycle = handoffTargetProviderCount > 1 && !handoffDisabled;
  const cycleHandoffTargetProvider = useCallback(
    (direction: 1 | -1) => {
      if (!handoffCanCycle) {
        return;
      }
      setHandoffFlipDirection(direction);
      onCycleHandoffTargetProvider(direction);
    },
    [handoffCanCycle, onCycleHandoffTargetProvider],
  );
  const onHandoffWheel = useCallback(
    (event: ReactWheelEvent<HTMLButtonElement>) => {
      if (!handoffCanCycle) {
        return;
      }
      const now = Date.now();
      if (now < handoffWheelCooldownUntilRef.current) {
        return;
      }

      if (now - handoffWheelLastEventAtRef.current > HANDOFF_WHEEL_RESET_GAP_MS) {
        handoffWheelAccumRef.current = 0;
      }
      handoffWheelLastEventAtRef.current = now;

      if (Math.abs(event.deltaY) < 1) {
        return;
      }
      if (
        handoffWheelAccumRef.current !== 0 &&
        Math.sign(handoffWheelAccumRef.current) !== Math.sign(event.deltaY)
      ) {
        handoffWheelAccumRef.current = 0;
      }

      handoffWheelAccumRef.current += event.deltaY;
      if (Math.abs(handoffWheelAccumRef.current) < HANDOFF_WHEEL_SNAP_DELTA) {
        return;
      }

      const direction: 1 | -1 = handoffWheelAccumRef.current > 0 ? 1 : -1;
      handoffWheelAccumRef.current = 0;
      handoffWheelCooldownUntilRef.current = now + HANDOFF_WHEEL_COOLDOWN_MS;
      cycleHandoffTargetProvider(direction);
    },
    [cycleHandoffTargetProvider, handoffCanCycle],
  );
  useEffect(() => {
    if (handoffCanCycle) {
      return;
    }
    handoffWheelAccumRef.current = 0;
    handoffWheelCooldownUntilRef.current = 0;
    handoffWheelLastEventAtRef.current = 0;
  }, [handoffCanCycle]);
  const onHandoffKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!handoffCanCycle) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        cycleHandoffTargetProvider(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        cycleHandoffTargetProvider(-1);
      }
    },
    [cycleHandoffTargetProvider, handoffCanCycle],
  );
  useEffect(() => {
    if (handoffFlipDirection === 0) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setHandoffFlipDirection(0);
    }, 200);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [handoffActionTargetProvider, handoffFlipDirection]);
  const handoffProviderAnimationClass =
    handoffFlipDirection > 0
      ? "handoff-provider-flip-down"
      : handoffFlipDirection < 0
        ? "handoff-provider-flip-up"
        : "";
  const renderProviderIcon = (provider: ProviderKind | null, className: string) => {
    if (provider === "claudeAgent") {
      return <ClaudeAI className={cn("text-[#d97757]", className)} />;
    }
    if (provider === "opencode") {
      return <OpenCodeIcon className={cn("text-muted-foreground/75", className)} />;
    }
    return <OpenAI className={cn("text-muted-foreground/75", className)} />;
  };
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () =>
      setCompact(surfaceMode === "split" || el.clientWidth < HEADER_COMPACT_BREAKPOINT);
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [surfaceMode]);

  return (
    <div ref={headerRef} className="flex min-w-0 flex-1 items-center gap-2">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3",
          needsDesktopTrafficLightInset ? "pl-[84px]" : "",
        )}
      >
        <div className="shrink-0 md:hidden">
          <SidebarTrigger className="size-7 shrink-0" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2
            className="max-w-[clamp(16rem,50vw,40rem)] min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            data-testid="chat-header-title"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {!isDisposableThread && handoffBadgeLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="outline"
                    className="hidden !h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] sm:inline-flex"
                  >
                    <span className="inline-flex size-4 shrink-0 items-center justify-center">
                      {renderProviderIcon(handoffBadgeSourceProvider, "size-3")}
                    </span>
                    <span className="text-muted-foreground/45">→</span>
                    <span className="inline-flex size-4 shrink-0 items-center justify-center">
                      {renderProviderIcon(handoffBadgeTargetProvider, "size-3")}
                    </span>
                  </Badge>
                }
              />
              <TooltipPopup side="bottom">{handoffBadgeLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {activeTaskTitle ? (
          <Badge variant="outline" className="min-w-0 max-w-24 truncate gap-1 sm:max-w-36">
            <KanbanSquareIcon className="size-3" />
            <span className="truncate">{activeTaskTitle}</span>
          </Badge>
        ) : null}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center",
          compact ? "gap-1" : "gap-1.5 @lg/header-actions:gap-2",
        )}
        data-testid="chat-header-actions"
      >
        <OpenInPicker
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={filesRailOpen}
                onPressedChange={onToggleFiles}
                aria-label="Toggle files rail"
                variant="outline"
                size="xs"
              >
                <FilesIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Toggle files rail</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
              >
                <TerminalIcon className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Toggle terminal drawer</TooltipPopup>
        </Tooltip>
        {chatLayoutAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label={chatLayoutAction.label}
                  onClick={chatLayoutAction.onClick}
                />
              }
            >
              {chatLayoutAction.kind === "split" ? (
                <ArrowLeftRight className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{chatLayoutAction.label}</TooltipPopup>
          </Tooltip>
        ) : null}
        {isElectron ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={browserPaneOpen}
                  onPressedChange={onToggleBrowser}
                  aria-label="Toggle browser pane"
                  variant="outline"
                  size="xs"
                >
                  <GlobeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">Toggle browser pane</TooltipPopup>
          </Tooltip>
        ) : null}
        {!diffOpen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  variant="outline"
                  size="xs"
                >
                  <PanelLeftIcon className="size-3.5 text-muted-foreground" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});

const ThreadErrorBanner = memo(function ThreadErrorBanner({ error }: { error: string | null }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [error]);

  if (!error || dismissed) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertTitle>Session error</AlertTitle>
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label="Dismiss session error"
            onClick={() => setDismissed(true)}
            size="icon-xs"
            title="Dismiss"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});

const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
}: {
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const defaultMessage =
    status.status === "error"
      ? `${status.provider} provider is unavailable.`
      : `${status.provider} provider has limited availability.`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>
          {status.provider === "codex" ? "Codex provider status" : `${status.provider} status`}
        </AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
    </div>
  );
});

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});

interface PlanModePanelProps {
  activePlan: ReturnType<typeof deriveActivePlanState>;
}

const PlanModePanel = memo(function PlanModePanel({ activePlan }: PlanModePanelProps) {
  if (!activePlan) return null;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <span className="text-xs text-muted-foreground">
            Updated {formatTimestamp(activePlan.createdAt)}
          </span>
        </div>
        {activePlan.explanation ? (
          <p className="mt-2 text-sm text-muted-foreground">{activePlan.explanation}</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {activePlan.steps.map((step) => (
            <div
              key={`${step.status}:${step.step}`}
              className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/80 px-3 py-2"
            >
              <Badge
                variant={
                  step.status === "completed"
                    ? "default"
                    : step.status === "inProgress"
                      ? "secondary"
                      : "outline"
                }
              >
                {step.status === "inProgress"
                  ? "In progress"
                  : step.status === "completed"
                    ? "Done"
                    : "Pending"}
              </Badge>
              <div className="min-w-0 flex-1 text-sm">{step.step}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
}

const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">
          {questionIndex + 1}/{prompt.questions.length} {activeQuestion.header}
        </span>
        <div className="text-sm font-medium">{activeQuestion.question}</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {activeQuestion.options.map((option) => {
          const isSelected = progress.selectedOptionLabel === option.label;
          return (
            <Button
              key={`${activeQuestion.id}:${option.label}`}
              size="sm"
              variant={isSelected ? "default" : "outline"}
              disabled={isResponding}
              onClick={() => onSelectOption(activeQuestion.id, option.label)}
              title={option.description}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
});

const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{planTitle}</span>
        ) : null}
      </div>
      {/* <div className="mt-2 text-xs text-muted-foreground">
        Review the plan
      </div> */}
    </div>
  );
});

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const COMING_SOON_PROVIDER_OPTIONS = [{ id: "gemini", label: "Gemini", icon: Gemini }] as const;

function getCustomModelOptionsByProvider(
  settings: {
    customCodexModels: readonly string[];
    customOpencodeModels: readonly string[];
    customClaudeModels: readonly string[];
  },
  providerStatuses: readonly ServerProviderStatus[],
  codexRuntimeModels: ReadonlyArray<{ slug: string; name: string }>,
  opencodeRuntimeModels: ReadonlyArray<{ slug: string; name: string }>,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  const opencodeProvider = providerStatuses.find((provider) => provider.provider === "opencode");
  const opencodeOptions =
    opencodeRuntimeModels.length > 0
      ? opencodeRuntimeModels
      : opencodeProvider?.models && opencodeProvider.models.length > 0
        ? opencodeProvider.models.map((model) => ({ slug: model.slug, name: model.name }))
        : getAppModelOptions("opencode", settings.customOpencodeModels);
  const codexOptions =
    codexRuntimeModels.length > 0
      ? mergeRuntimeAndCustomModelOptions("codex", codexRuntimeModels, settings.customCodexModels)
      : getAppModelOptions("codex", settings.customCodexModels);
  return {
    codex: codexOptions,
    opencode: opencodeOptions,
    claudeAgent: getAppModelOptions("claudeAgent", settings.customClaudeModels),
  };
}

function mergeRuntimeAndCustomModelOptions(
  provider: ProviderKind,
  runtimeModels: ReadonlyArray<{ slug: string; name: string }>,
  customModels: readonly string[],
): ReadonlyArray<{ slug: string; name: string }> {
  const seen = new Set<string>();
  const options: Array<{ slug: string; name: string }> = [];
  for (const model of runtimeModels) {
    const normalized = normalizeModelSlug(model.slug, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    options.push({
      slug: normalized,
      name: model.name || normalized,
    });
  }
  for (const model of getAppModelOptions(provider, customModels)) {
    if (seen.has(model.slug)) {
      continue;
    }
    seen.add(model.slug);
    options.push({
      slug: model.slug,
      name: model.name,
    });
  }
  return options;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  opencode: OpenCodeIcon,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
};

function providerModelKey(provider: ProviderKind, model: string): string {
  return `${provider}:${model}`;
}

function readModelPickerFavorites(): string[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(MODEL_PICKER_FAVORITES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function persistModelPickerFavorites(favorites: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(MODEL_PICKER_FAVORITES_KEY, JSON.stringify([...favorites]));
}

type OpenCodeModelFamilyId = "favorites" | "zen" | "openai" | "go" | "free" | "other";

const OPENCODE_MODEL_FAMILY_ORDER: Record<OpenCodeModelFamilyId, number> = {
  favorites: 0,
  zen: 1,
  openai: 2,
  go: 3,
  free: 4,
  other: 5,
};

const OPENCODE_MODEL_FAMILY_META: Record<OpenCodeModelFamilyId, { label: string }> = {
  favorites: {
    label: "Favorites",
  },
  zen: {
    label: "Zen",
  },
  openai: {
    label: "OpenAI",
  },
  go: {
    label: "Go",
  },
  free: {
    label: "Free",
  },
  other: {
    label: "Other",
  },
};

function opencodeProviderIdFromSlug(slug: string): string {
  const slashIndex = slug.indexOf("/");
  return slashIndex > 0 ? slug.slice(0, slashIndex).toLowerCase() : "";
}

function resolveOpenCodeModelFamily(model: { slug: string; name: string }): OpenCodeModelFamilyId {
  const providerId = opencodeProviderIdFromSlug(model.slug);
  const modelId = model.slug.slice(model.slug.indexOf("/") + 1).toLowerCase();
  const normalizedName = model.name.toLowerCase();
  if (providerId === "zen" || providerId.includes("zen")) {
    return "zen";
  }
  if (providerId === "openai") {
    return "openai";
  }
  if (providerId === "opencode-go" || providerId === "go" || providerId.endsWith("-go")) {
    return "go";
  }
  if (providerId === "free" || providerId === "opencode-free" || providerId.endsWith("-free")) {
    return "free";
  }
  if (modelId.includes("free") || normalizedName.includes(" free")) {
    return "free";
  }
  if (
    providerId === "opencode" ||
    normalizedName.startsWith("opencode zen") ||
    normalizedName.includes(" opencode zen")
  ) {
    return "zen";
  }
  return "other";
}

function getOpenCodeModelDisplayName(model: { slug: string; name: string }): string {
  const family = resolveOpenCodeModelFamily(model);
  if (family === "other") {
    return model.name;
  }
  return (
    model.name
      .replace(/^OpenCode\s+(?:Zen|Go|Default)\s*(?:[·-]\s*)?/i, "")
      .replace(/^OpenAI\s*(?:[·-]\s*)?/i, "")
      .trim() || model.name
  );
}

function resolveModelForProviderPicker(
  provider: ProviderKind,
  value: string,
  options: ReadonlyArray<{ slug: string; name: string }>,
): ModelSlug | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmedValue);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmedValue.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmedValue, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  if (resolved) {
    return resolved.slug;
  }

  return null;
}

const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  serviceTierSetting: AppServiceTier;
  compact?: boolean;
  disabled?: boolean;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [favoriteModelKeys, setFavoriteModelKeys] = useState<ReadonlySet<string>>(
    () => new Set(readModelPickerFavorites()),
  );
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | "favorites">(() =>
    favoriteModelKeys.size > 0 ? "favorites" : props.provider,
  );
  const [collapsedOpenCodeFamilies, setCollapsedOpenCodeFamilies] = useState<
    ReadonlySet<OpenCodeModelFamilyId>
  >(() => new Set(["zen", "openai", "go", "free", "other"]));
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedProviderOptions = props.modelOptionsByProvider[props.provider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.provider];
  const selectedModelKey = `${props.provider}:${props.model}`;
  const shouldBuildModelPicker = isMenuOpen;

  useEffect(() => {
    if (props.lockedProvider !== null) {
      setSelectedProvider(props.provider);
    }
  }, [props.lockedProvider, props.provider]);

  useLayoutEffect(() => {
    if (!isMenuOpen) return;
    searchInputRef.current?.focus({ preventScroll: true });
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMenuOpen]);

  const flatModels = useMemo(() => {
    if (!shouldBuildModelPicker) {
      return [];
    }
    return AVAILABLE_PROVIDER_OPTIONS.flatMap((option) =>
      props.modelOptionsByProvider[option.value].map((modelOption, originalIndex) => ({
        ...modelOption,
        provider: option.value,
        providerLabel: option.label,
        displayName:
          option.value === "opencode" ? getOpenCodeModelDisplayName(modelOption) : modelOption.name,
        originalIndex,
        openCodeFamily:
          option.value === "opencode" ? resolveOpenCodeModelFamily(modelOption) : null,
      })),
    );
  }, [props.modelOptionsByProvider, shouldBuildModelPicker]);

  const filteredModels = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    const scopedModels =
      props.lockedProvider === null
        ? flatModels
        : flatModels.filter((modelOption) => modelOption.provider === props.lockedProvider);

    if (trimmedQuery.length > 0) {
      const tokens = trimmedQuery.split(/\s+/u).filter(Boolean);
      return scopedModels
        .map((modelOption) => {
          const haystack = [
            modelOption.name,
            modelOption.slug,
            modelOption.provider,
            modelOption.providerLabel,
            modelOption.displayName,
            modelOption.openCodeFamily
              ? OPENCODE_MODEL_FAMILY_META[modelOption.openCodeFamily].label
              : "",
          ]
            .join(" ")
            .toLowerCase();
          const matches = tokens.every((token) => haystack.includes(token));
          if (!matches) return null;
          const exactName = modelOption.name.toLowerCase() === trimmedQuery ? 0 : 1;
          const prefixName = modelOption.name.toLowerCase().startsWith(trimmedQuery) ? 0 : 1;
          return {
            modelOption,
            score: exactName + prefixName + haystack.indexOf(tokens[0] ?? ""),
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            modelOption: (typeof scopedModels)[number];
            score: number;
          } => entry !== null,
        )
        .toSorted((left, right) => {
          const leftFamily = left.modelOption.openCodeFamily;
          const rightFamily = right.modelOption.openCodeFamily;
          if (leftFamily && rightFamily && leftFamily !== rightFamily) {
            return (
              OPENCODE_MODEL_FAMILY_ORDER[leftFamily] - OPENCODE_MODEL_FAMILY_ORDER[rightFamily]
            );
          }
          const scoreDelta = left.score - right.score;
          if (scoreDelta !== 0) return scoreDelta;
          return left.modelOption.displayName.localeCompare(right.modelOption.displayName);
        })
        .map((entry) => entry.modelOption);
    }

    if (selectedProvider === "favorites") {
      return scopedModels.filter((modelOption) =>
        favoriteModelKeys.has(providerModelKey(modelOption.provider, modelOption.slug)),
      );
    }

    const groupOpenCodeFavorites = selectedProvider === "opencode";

    return scopedModels
      .filter((modelOption) => modelOption.provider === selectedProvider)
      .toSorted((left, right) => {
        const leftFavorite = favoriteModelKeys.has(providerModelKey(left.provider, left.slug));
        const rightFavorite = favoriteModelKeys.has(providerModelKey(right.provider, right.slug));
        const leftFamily =
          groupOpenCodeFavorites && left.openCodeFamily && leftFavorite
            ? "favorites"
            : left.openCodeFamily;
        const rightFamily =
          groupOpenCodeFavorites && right.openCodeFamily && rightFavorite
            ? "favorites"
            : right.openCodeFamily;
        if (leftFamily && rightFamily && leftFamily !== rightFamily) {
          return OPENCODE_MODEL_FAMILY_ORDER[leftFamily] - OPENCODE_MODEL_FAMILY_ORDER[rightFamily];
        }
        if (!groupOpenCodeFavorites && leftFavorite !== rightFavorite) {
          return leftFavorite ? -1 : 1;
        }
        return left.originalIndex - right.originalIndex;
      });
  }, [favoriteModelKeys, flatModels, props.lockedProvider, searchQuery, selectedProvider]);

  const modelKeys = useMemo(
    () => flatModels.map((modelOption) => `${modelOption.provider}:${modelOption.slug}`),
    [flatModels],
  );
  const isSearchingModels = searchQuery.trim().length > 0;
  const groupOpenCodeFavorites = selectedProvider === "opencode" && !isSearchingModels;
  const openCodeSectionForModel = useCallback(
    (modelOption: (typeof flatModels)[number]): OpenCodeModelFamilyId | null => {
      if (!modelOption.openCodeFamily) {
        return null;
      }
      if (
        groupOpenCodeFavorites &&
        favoriteModelKeys.has(providerModelKey(modelOption.provider, modelOption.slug))
      ) {
        return "favorites";
      }
      return modelOption.openCodeFamily;
    },
    [favoriteModelKeys, groupOpenCodeFavorites],
  );
  const visibleModels = useMemo(
    () =>
      isSearchingModels
        ? filteredModels
        : filteredModels.filter((modelOption) => {
            const openCodeSection = openCodeSectionForModel(modelOption);
            return !openCodeSection || !collapsedOpenCodeFamilies.has(openCodeSection);
          }),
    [collapsedOpenCodeFamilies, filteredModels, isSearchingModels, openCodeSectionForModel],
  );
  const filteredModelKeys = useMemo(
    () => visibleModels.map((modelOption) => `${modelOption.provider}:${modelOption.slug}`),
    [visibleModels],
  );

  const openCodeFamilyCounts = useMemo(() => {
    const counts = new Map<OpenCodeModelFamilyId, number>();
    for (const modelOption of filteredModels) {
      const openCodeSection = openCodeSectionForModel(modelOption);
      if (!openCodeSection) {
        continue;
      }
      counts.set(openCodeSection, (counts.get(openCodeSection) ?? 0) + 1);
    }
    return counts;
  }, [filteredModels, openCodeSectionForModel]);

  const renderedModelEntries = useMemo(() => {
    const entries: Array<
      | {
          readonly type: "header";
          readonly section: OpenCodeModelFamilyId;
        }
      | {
          readonly type: "model";
          readonly modelOption: (typeof flatModels)[number];
          readonly index: number;
        }
    > = [];
    let previousOpenCodeSection: OpenCodeModelFamilyId | null = null;
    let visibleModelIndex = 0;

    for (const modelOption of filteredModels) {
      const openCodeSection = openCodeSectionForModel(modelOption);
      if (openCodeSection !== null && openCodeSection !== previousOpenCodeSection) {
        entries.push({ type: "header", section: openCodeSection });
      }
      previousOpenCodeSection = openCodeSection;

      if (
        !isSearchingModels &&
        openCodeSection !== null &&
        collapsedOpenCodeFamilies.has(openCodeSection)
      ) {
        continue;
      }

      entries.push({
        type: "model",
        modelOption,
        index: visibleModelIndex,
      });
      visibleModelIndex += 1;
    }

    return entries;
  }, [collapsedOpenCodeFamilies, filteredModels, isSearchingModels, openCodeSectionForModel]);

  const selectProviderModel = (value: string) => {
    const colonIndex = value.indexOf(":");
    if (colonIndex === -1) return;
    const provider = value.slice(0, colonIndex) as ProviderKind;
    const model = value.slice(colonIndex + 1);
    if (props.disabled) return;
    if (props.lockedProvider !== null && props.lockedProvider !== provider) return;
    const resolvedModel = resolveModelForProviderPicker(
      provider,
      model,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  const toggleFavoriteModel = (provider: ProviderKind, model: string) => {
    setFavoriteModelKeys((current) => {
      const next = new Set(current);
      const key = providerModelKey(provider, model);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      persistModelPickerFavorites(next);
      if (selectedProvider === "favorites" && next.size === 0) {
        setSelectedProvider(provider);
      }
      return next;
    });
  };

  const toggleOpenCodeFamilyCollapsed = (family: OpenCodeModelFamilyId) => {
    setCollapsedOpenCodeFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) {
        next.delete(family);
      } else {
        next.add(family);
      }
      return next;
    });
  };

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-44 shrink-0 pl-2 pr-1.5" : "max-w-56 shrink-0 px-2 sm:px-3",
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2">
          <ProviderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
          {props.provider === "codex" &&
          shouldShowFastTierIcon(props.model, props.serviceTierSetting) ? (
            <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
          ) : null}
          <span className="min-w-0 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <div className="relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5">
          <ScrollArea scrollFade className="w-12 shrink-0 border-r bg-muted/30">
            <div className="flex min-h-full flex-col gap-1 p-1">
              {props.lockedProvider === null ? (
                <>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          className={cn(
                            "relative flex aspect-square w-full cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                            selectedProvider === "favorites" &&
                              "bg-background text-foreground shadow-sm",
                          )}
                          type="button"
                          aria-label="Favorites"
                          onClick={() => {
                            setSelectedProvider("favorites");
                            window.requestAnimationFrame(() => {
                              searchInputRef.current?.focus({ preventScroll: true });
                            });
                          }}
                        >
                          {selectedProvider === "favorites" ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-primary"
                            />
                          ) : null}
                          <StarIcon className="size-5 shrink-0 fill-current" />
                        </button>
                      }
                    />
                    <TooltipPopup side="left" align="center">
                      Favorites
                    </TooltipPopup>
                  </Tooltip>
                  <div className="my-1 h-px bg-border" />
                </>
              ) : null}
              {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
                const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
                const isDisabled =
                  props.lockedProvider !== null && props.lockedProvider !== option.value;
                const isSelected = selectedProvider === option.value;
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger
                      render={
                        <button
                          className={cn(
                            "relative flex aspect-square w-full cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                            isSelected && "bg-background text-foreground shadow-sm",
                            isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                          )}
                          disabled={isDisabled}
                          type="button"
                          aria-label={option.label}
                          onClick={() => {
                            if (isDisabled) return;
                            setSelectedProvider(option.value);
                            window.requestAnimationFrame(() => {
                              searchInputRef.current?.focus({ preventScroll: true });
                            });
                          }}
                        >
                          {isSelected ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-primary"
                            />
                          ) : null}
                          <OptionIcon className="size-5 shrink-0 text-muted-foreground/85" />
                        </button>
                      }
                    />
                    <TooltipPopup side="left" align="center">
                      {option.label}
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
              {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 ||
              COMING_SOON_PROVIDER_OPTIONS.length > 0 ? (
                <div className="my-1 h-px bg-border" />
              ) : null}
              {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
                const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger
                      render={
                        <span className="block w-full">
                          <button
                            className="flex aspect-square w-full cursor-not-allowed items-center justify-center rounded opacity-50"
                            disabled
                            type="button"
                            aria-label={`${option.label} - coming soon`}
                          >
                            <OptionIcon className="size-5 shrink-0 text-muted-foreground/85" />
                          </button>
                        </span>
                      }
                    />
                    <TooltipPopup side="left" align="center">
                      {option.label} - Coming soon
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
              {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <Tooltip key={option.id}>
                    <TooltipTrigger
                      render={
                        <span className="block w-full">
                          <button
                            className="flex aspect-square w-full cursor-not-allowed items-center justify-center rounded opacity-50"
                            disabled
                            type="button"
                            aria-label={`${option.label} - coming soon`}
                          >
                            <OptionIcon className="size-5 shrink-0 text-muted-foreground/85" />
                          </button>
                        </span>
                      }
                    />
                    <TooltipPopup side="left" align="center">
                      {option.label} - Coming soon
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
          </ScrollArea>

          <Combobox
            inline
            items={modelKeys}
            filteredItems={filteredModelKeys}
            filter={null}
            autoHighlight
            open
            value={selectedModelKey}
            onValueChange={(value) => {
              if (typeof value === "string") {
                selectProviderModel(value);
              }
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="border-b px-3 py-2">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:font-sans rounded-md"
                  inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={<SearchIcon className="size-4 text-muted-foreground/50" />}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsMenuOpen(false);
                    }
                    event.stopPropagation();
                  }}
                  size="sm"
                />
              </div>
              <div className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40">
                <ComboboxList className="model-picker-list size-full divide-y px-2 py-1">
                  {renderedModelEntries.map((entry) => {
                    if (entry.type === "header") {
                      const sectionMeta = OPENCODE_MODEL_FAMILY_META[entry.section];
                      const isCollapsed =
                        !isSearchingModels && collapsedOpenCodeFamilies.has(entry.section);
                      return (
                        <button
                          key={`header:${entry.section}`}
                          type="button"
                          className="sticky top-0 z-10 flex w-full items-center gap-2 bg-popover/95 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground backdrop-blur transition-colors hover:bg-muted/70 hover:text-foreground"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleOpenCodeFamilyCollapsed(entry.section)}
                        >
                          <ChevronDownIcon
                            className={cn(
                              "size-3.5 shrink-0 transition-transform",
                              isCollapsed ? "-rotate-90" : "rotate-0",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate">{sectionMeta.label}</span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/65">
                            {openCodeFamilyCounts.get(entry.section) ?? 0}
                          </span>
                        </button>
                      );
                    }

                    const modelOption = entry.modelOption;
                    const modelKey = `${modelOption.provider}:${modelOption.slug}`;
                    const familyMeta = modelOption.openCodeFamily
                      ? OPENCODE_MODEL_FAMILY_META[modelOption.openCodeFamily]
                      : null;
                    const RowIcon = PROVIDER_ICON_BY_PROVIDER[modelOption.provider];
                    const isFavorite = favoriteModelKeys.has(
                      providerModelKey(modelOption.provider, modelOption.slug),
                    );
                    return (
                      <ComboboxItem
                        key={modelKey}
                        hideIndicator
                        index={entry.index}
                        value={modelKey}
                        className="w-full cursor-pointer rounded px-3 py-2 transition-colors data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground"
                      >
                        <div className="flex w-full items-start gap-2">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  className="mt-0.5 shrink-0 cursor-pointer opacity-45 transition-opacity hover:opacity-100"
                                  type="button"
                                  aria-label={
                                    isFavorite ? "Remove from favorites" : "Add to favorites"
                                  }
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    toggleFavoriteModel(modelOption.provider, modelOption.slug);
                                  }}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                  }}
                                >
                                  <StarIcon
                                    className={cn(
                                      "size-4",
                                      isFavorite && "fill-current text-yellow-500",
                                    )}
                                  />
                                </button>
                              }
                            />
                            <TooltipPopup side="top" align="center">
                              {isFavorite ? "Remove from favorites" : "Add to favorites"}
                            </TooltipPopup>
                          </Tooltip>
                          <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                            {modelOption.provider === "codex" &&
                            shouldShowFastTierIcon(modelOption.slug, props.serviceTierSetting) ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <RowIcon className="size-4 text-muted-foreground/85" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 text-left">
                            <div className="truncate text-xs font-medium leading-snug">
                              {modelOption.displayName}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-xs leading-snug text-muted-foreground/70">
                              <RowIcon className="size-3 shrink-0" />
                              <span className="truncate">
                                {familyMeta
                                  ? `${modelOption.providerLabel} · ${familyMeta.label}`
                                  : modelOption.providerLabel}
                              </span>
                              {modelOption.slug !== modelOption.displayName ? (
                                <span className="truncate opacity-80">· {modelOption.slug}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </div>
              <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
                No models found
              </ComboboxEmpty>
            </div>
          </Combobox>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

const CodexTraitsPicker = memo(function CodexTraitsPicker(props: {
  effort: CodexReasoningEffort;
  fastModeEnabled: boolean;
  options: ReadonlyArray<CodexReasoningEffort>;
  onEffortChange: (effort: CodexReasoningEffort) => void;
  onFastModeChange: (enabled: boolean) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const triggerLabel = [
    CODEX_REASONING_LABEL_BY_OPTION[props.effort],
    ...(props.fastModeEnabled ? ["Fast"] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
          <MenuRadioGroup
            value={props.effort}
            onValueChange={(value) => {
              if (!value) return;
              const nextEffort = props.options.find((option) => option === value);
              if (!nextEffort) return;
              props.onEffortChange(nextEffort);
            }}
          >
            {props.options.map((effort) => (
              <MenuRadioItem key={effort} value={effort}>
                {CODEX_REASONING_LABEL_BY_OPTION[effort]}
                {effort === defaultReasoningEffort ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
          <MenuRadioGroup
            value={props.fastModeEnabled ? "on" : "off"}
            onValueChange={(value) => {
              props.onFastModeChange(value === "on");
            }}
          >
            <MenuRadioItem value="off">off</MenuRadioItem>
            <MenuRadioItem value="on">on</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const OpenCodeTraitsPicker = memo(function OpenCodeTraitsPicker(props: {
  variantOptions: ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>;
  agentOptions: ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>;
  selectedVariant: string | null;
  selectedAgent: string | null;
  onVariantChange: (value: string) => void;
  onAgentChange: (value: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const selectedVariantLabel =
    props.variantOptions.find((option) => option.value === props.selectedVariant)?.label ??
    props.variantOptions.find((option) => option.isDefault)?.label ??
    "Default";
  const selectedAgentLabel =
    props.agentOptions.find((option) => option.value === props.selectedAgent)?.label ??
    props.agentOptions.find((option) => option.isDefault)?.label;
  const triggerLabel = [selectedVariantLabel, ...(selectedAgentLabel ? [selectedAgentLabel] : [])]
    .filter(Boolean)
    .join(" · ");

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
          />
        }
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.variantOptions.length > 0 ? (
          <>
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Variant</div>
              <MenuRadioGroup
                value={
                  props.selectedVariant ??
                  props.variantOptions.find((option) => option.isDefault)?.value ??
                  ""
                }
                onValueChange={(value) => {
                  if (!value) return;
                  props.onVariantChange(value);
                }}
              >
                {props.variantOptions.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                    {option.isDefault ? " (default)" : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            {props.agentOptions.length > 0 ? <MenuDivider /> : null}
          </>
        ) : null}
        {props.agentOptions.length > 0 ? (
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Agent</div>
            <MenuRadioGroup
              value={
                props.selectedAgent ??
                props.agentOptions.find((option) => option.isDefault)?.value ??
                ""
              }
              onValueChange={(value) => {
                if (!value) return;
                props.onAgentChange(value);
              }}
            >
              {props.agentOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.isDefault ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((e) => e.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });

  const allOptions = useMemo<Array<{ label: string; Icon: Icon; value: EditorId }>>(
    () => [
      {
        label: "Cursor",
        Icon: CursorIcon,
        value: "cursor",
      },
      {
        label: "VS Code",
        Icon: VisualStudioCode,
        value: "vscode",
      },
      {
        label: "Zed",
        Icon: Zed,
        value: "zed",
      },
      {
        label: isMacPlatform(navigator.platform)
          ? "Finder"
          : isWindowsPlatform(navigator.platform)
            ? "Explorer"
            : "Files",
        Icon: FolderClosedIcon,
        value: "file-manager",
      },
    ],
    [],
  );
  const options = useMemo(
    () => allOptions.filter((option) => availableEditors.includes(option.value)),
    [allOptions, availableEditors],
  );

  const effectiveEditor = options.some((option) => option.value === lastEditor)
    ? lastEditor
    : (options[0]?.value ?? null);
  const primaryOption = options.find(({ value }) => value === effectiveEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? effectiveEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      localStorage.setItem(LAST_EDITOR_KEY, editor);
      setLastEditor(editor);
    },
    [effectiveEditor, openInCwd, setLastEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!effectiveEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, effectiveEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!effectiveEditor || !openInCwd}
        onClick={() => openInEditor(effectiveEditor)}
        aria-label="Open in editor"
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @lg/header-actions:not-sr-only @lg/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @lg/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Choose editor" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === effectiveEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
