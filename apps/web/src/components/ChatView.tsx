import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EDITORS,
  type EditorId,
  type KeybindingCommand,
  type CodexReasoningEffort,
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
  type ProviderSkillDescriptor,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
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
  type WheelEvent as ReactWheelEvent,
} from "react";
import { FiGitBranch } from "react-icons/fi";
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
import {
  resolveProviderDiscoveryCwd,
} from "~/lib/providerDiscovery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";

import { isElectron, isElectronRuntime } from "../env";
import {
  parseDiffRouteSearch,
  resolveRightPanelMode,
  withDiffSelection,
  withRightPanelMode,
} from "../diffRouteSearch";
import {
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../composer-logic";
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
import BranchToolbar from "./BranchToolbar";
import GitActionsControl from "./GitActionsControl";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";
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
  FolderClosedIcon,
  GlobeIcon,
  KanbanSquareIcon,
  PanelLeftIcon,
  PlusIcon,
  Maximize2Icon,
  ArrowLeftRight,
  Undo2Icon,
  Trash2Icon,
  XIcon,
  ZapIcon,
  PinIcon,
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
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
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
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { Toggle } from "./ui/toggle";
import { SidebarInsetTrigger, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
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
  type DraftThreadEnvMode,
  type DraftThreadState,
  type PinnedSelectionDraft,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { shouldUseCompactComposerFooter } from "./composerFooterLayout";
import { buildQuotedSelectionInsertion, normalizeSelectedText } from "../chatPinnedSelections";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import {
  ExpandedImagePreview as ExpandedImagePreviewDialog,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import {
  ComposerCommandMenu,
  type ComposerCommandItem,
} from "./chat/ComposerCommandMenu";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";

const LAST_EDITOR_KEY = "t3code:last-editor";
const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
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
const CODEX_REASONING_LABEL_BY_OPTION: Record<CodexReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function skillMentionPrefix(provider: ProviderKind): string {
  return provider === "claudeAgent" ? "/" : "$";
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
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
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
  const firstImage = input.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  return "Queued follow-up";
}

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
    diffTurnId: TurnId | null;
    diffFilePath: string | null;
    hasOpenedPanel: boolean;
    lastOpenPanel: "browser" | "diff";
  };
  onToggleDiffPanel?: () => void;
  onToggleBrowserPanel?: () => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
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
  onOpenTurnDiffPanel: _onOpenTurnDiffPanel,
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
  const composerPinnedSelections = composerDraft.pinnedSelections;
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
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftPinnedSelection = useComposerDraftStore((store) => store.addPinnedSelection);
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
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
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
  const [queuedComposerTurns, setQueuedComposerTurns] = useState<QueuedComposerTurn[]>([]);
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
  const selectedServiceTierSetting = settings.codexServiceTier;
  const selectedServiceTier = resolveAppServiceTier(selectedServiceTierSetting);
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
  const assistantDeliveryMode =
    selectedProvider === "opencode" || settings.enableAssistantStreaming
      ? "streaming"
      : "buffered";
  const baseThreadModel = resolveModelSlugForProvider(
    selectedProvider,
    activeThread?.model ?? activeProject?.model ?? getDefaultModel(selectedProvider),
  );
  const customModelsForSelectedProvider =
    selectedProvider === "opencode" ? settings.customOpencodeModels : settings.customCodexModels;
  const selectedModel = useMemo(() => {
    const draftModel = composerDraft.model;
    if (!draftModel) {
      return baseThreadModel;
    }
    return resolveAppModelSelection(
      selectedProvider,
      customModelsForSelectedProvider,
      draftModel,
    ) as ModelSlug;
  }, [baseThreadModel, composerDraft.model, customModelsForSelectedProvider, selectedProvider]);
  const reasoningOptions = getReasoningEffortOptions(selectedProvider);
  const supportsReasoningEffort = reasoningOptions.length > 0;
  const selectedEffort = composerDraft.effort ?? getDefaultReasoningEffort(selectedProvider);
  const selectedCodexFastModeEnabled =
    selectedProvider === "codex" ? composerDraft.codexFastMode : false;
  const selectedModelOptionsForDispatch = useMemo(() => {
    if (selectedProvider !== "codex") {
      return undefined;
    }
    const codexOptions = {
      ...(supportsReasoningEffort && selectedEffort ? { reasoningEffort: selectedEffort } : {}),
      ...(selectedCodexFastModeEnabled ? { fastMode: true } : {}),
    };
    return Object.keys(codexOptions).length > 0 ? { codex: codexOptions } : undefined;
  }, [selectedCodexFastModeEnabled, selectedEffort, selectedProvider, supportsReasoningEffort]);
  const selectedModelForPicker = selectedModel;
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings),
    [settings],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
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
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
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
  const handoffBadgeLabel = useMemo(
    () => (activeThread ? resolveThreadHandoffBadgeLabel(activeThread) : null),
    [activeThread],
  );
  const handoffBadgeSourceProvider = activeThread?.handoff?.sourceProvider ?? null;
  const handoffBadgeTargetProvider = activeThread ? inferProviderFromModel(activeThread.model) : null;
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
      ? handoffTargetProviders[((handoffTargetProviderIndex % handoffTargetProviders.length) + handoffTargetProviders.length) % handoffTargetProviders.length] ?? null
      : null;
  const onCycleHandoffTargetProvider = useCallback((direction: 1 | -1) => {
    setHandoffTargetProviderIndex((currentIndex) => {
      if (handoffTargetProviders.length <= 1) {
        return 0;
      }
      const nextIndex = currentIndex + direction;
      const normalized = ((nextIndex % handoffTargetProviders.length) + handoffTargetProviders.length) % handoffTargetProviders.length;
      return normalized;
    });
  }, [handoffTargetProviders.length]);
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
      hasPendingApprovals: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
    })
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
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
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    activeProposedPlan !== null;
  const activePendingApproval = pendingApprovals[0] ?? null;
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
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
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
  const syncScrollToBottomPillVisibility = useCallback((scrollContainer: HTMLDivElement | null) => {
    const nextVisible =
      scrollContainer !== null &&
      timelineEntries.length > 0 &&
      !isScrollContainerNearBottom(scrollContainer);
    setShowScrollToBottomPill((current) => (current === nextVisible ? current : nextVisible));
  }, [timelineEntries.length]);
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
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const skillTriggerQuery = composerTrigger?.kind === "skill" ? composerTrigger.query : "";
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
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
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
        (isSkillTrigger ||
          (composerTriggerKind === "slash-command" && selectedProvider === "claudeAgent")) &&
        supportsSkillDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerDiscoveryCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const providerNativeCommands = providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const supportsFastSlashCommand = selectedProvider === "codex";
  const canOfferReviewCommand = selectedProvider === "codex";
  const canOfferForkCommand = selectedProvider === "codex";
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;
  const composerMenuItems = useComposerCommandMenuItems({
    composerTrigger,
    provider: selectedProvider,
    supportsFastSlashCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    providerNativeCommands,
    providerNativeCommandNames,
    providerSkills,
    workspaceEntries,
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
  const providerStatuses = serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;
  const activeProvider = activeThread?.session?.provider ?? "codex";
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === activeProvider) ?? null,
    [activeProvider, providerStatuses],
  );
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
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
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
      search: (previous) =>
        withRightPanelMode(
          previous as Record<string, unknown>,
          diffOpen ? "none" : "diff",
        ),
    });
  }, [diffOpen, navigate, onToggleDiffPanel, threadId]);
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
    void handleRuntimeModeChange(runtimeMode === "full-access" ? "approval-required" : "full-access");
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
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: crypto.randomUUID(),
        name: file.name || "image",
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
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
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
    (targetThreadId: ThreadId) => {
      promptRef.current = "";
      clearComposerDraftContent(targetThreadId);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [clearComposerDraftContent],
  );

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
      promptRef.current = nextPrompt;
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
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
    const promptForSend = queuedChatTurn?.prompt ?? promptRef.current;
    const composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
    const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
    const selectedEffortForSend = queuedChatTurn?.selectedEffort ?? selectedEffort;
    const selectedCodexFastModeEnabledForSend =
      queuedChatTurn?.selectedCodexFastModeEnabled ?? selectedCodexFastModeEnabled;
    const selectedModelOptionsForDispatchForSend =
      queuedChatTurn?.modelOptionsForDispatch ?? selectedModelOptionsForDispatch;
    const runtimeModeForSend = queuedChatTurn?.runtimeMode ?? runtimeMode;
    const interactionModeForSend = queuedChatTurn?.interactionMode ?? interactionMode;
    const envModeForSend = queuedChatTurn?.envMode ?? envMode;
    const trimmed = promptForSend.trim();
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
    if (queuedChatTurn === null && composerImagesForSend.length === 0) {
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
          trimmedPrompt: trimmed,
          images: composerImagesForSend,
        }),
        prompt: promptForSend,
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
      clearComposerInput(activeThread.id);
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
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    setOptimisticUserMessages((existing) => [
      ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: trimmed || IMAGE_ONLY_BOOTSTRAP_PROMPT,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          createdAt: messageCreatedAt,
          streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setThreadError(threadIdForSend, null);
    clearComposerInput(threadIdForSend);

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
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncateTitle(titleSeed);
      let threadCreateModel: ModelSlug =
        selectedModelForSend || (activeProject.model as ModelSlug) || DEFAULT_MODEL_BY_PROVIDER.codex;

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
          text: trimmed || IMAGE_ONLY_BOOTSTRAP_PROMPT,
          attachments: turnAttachments,
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
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        setComposerCursor(promptForSend.length);
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
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
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
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
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
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
      pendingUserInputs.length > 0 ||
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
    pendingUserInputs.length,
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
      .then(() => api.orchestration.getSnapshot())
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
          .getSnapshot()
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
      setComposerDraftModel(
        activeThread.id,
        resolveAppModelSelection(
          provider,
          provider === "opencode" ? settings.customOpencodeModels : settings.customCodexModels,
          model,
        ),
      );
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModel,
      setComposerDraftProvider,
      settings.customCodexModels,
      settings.customOpencodeModels,
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
  const compactTraitsMenuContent = useMemo(() => {
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
    reasoningOptions,
    selectedCodexFastModeEnabled,
    selectedEffort,
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
    setPendingPinnedSelectionJumpId((current) =>
      current === pinnedSelectionId ? null : current,
    );
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

  const { handleStandaloneSlashCommand, handleSlashCommandSelection } = useComposerSlashCommands({
    selectedProvider,
    providerNativeCommandNames,
    supportsFastSlashCommand,
    fastModeEnabled: selectedCodexFastModeEnabled,
    handleInteractionModeChange,
    handleClearConversation,
    handleForkCommand,
    handleStatusCommand,
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
          `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
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
      selectedProvider,
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
    (composerTriggerKind === "skill" && providerSkillsQuery.isFetching);

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
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
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
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-thread-surface)]"
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
          openInCwd={activeThread.worktreePath ?? activeProject?.cwd ?? null}
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
          browserPaneOpen={resolvedBrowserPaneOpen}
          gitCwd={gitCwd}
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
          <MessagesTimeline
            key={activeThread.id}
            isFocusedPane={isFocusedPane}
            hasMessages={timelineEntries.length > 0}
            isWorking={isWorking}
            activeTurnInProgress={!latestTurnSettled}
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
            markdownCwd={gitCwd ?? undefined}
            resolvedTheme={resolvedTheme}
            workspaceRoot={activeProject?.cwd ?? undefined}
            pinnedSelections={composerPinnedSelections}
            onAskAboutSelectedText={onAskAboutSelectedText}
            onPinSelectedText={onPinSelectedText}
            onRemovePinnedSelection={onRemovePinnedSelection}
            pendingPinnedSelectionJumpId={pendingPinnedSelectionJumpId}
            onPinnedSelectionJumpHandled={onPinnedSelectionJumpHandled}
          />
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
          "px-3 pt-4 sm:px-5 sm:pt-4",
          isGitRepo ? "pb-1" : "pb-2.5 sm:pb-3",
        )}
      >
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
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
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
              pendingUserInputs.length === 0 &&
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
              {!isComposerApprovalState && pendingUserInputs.length === 0 && composerImages.length > 0 && (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-14 w-14 overflow-hidden rounded-md border border-border/50 bg-background"
                    >
                      {image.previewUrl ? (
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
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                          {image.name}
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
                      ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                      : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : phase === "running"
                          ? "Ask for follow-up changes"
                        : phase === "disconnected"
                          ? "Ask for follow-up changes or attach images"
                          : "Ask anything, @tag files/folders, or use / to show available commands"
                  }
                  disabled={isConnecting || isComposerApprovalState}
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
                          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                          <CodexTraitsPicker
                            effort={selectedEffort}
                            fastModeEnabled={selectedCodexFastModeEnabled}
                            options={reasoningOptions}
                            onEffortChange={onEffortSelect}
                            onFastModeChange={onCodexFastModeChange}
                          />
                        </>
                      ) : null}

                      {/* Divider */}
                      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                      {/* Interaction mode toggle */}
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

                      {showRuntimeControlInComposer ? (
                        <>
                          {/* Divider */}
                          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                          {/* Runtime mode toggle */}
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                            size="sm"
                            type="button"
                            onClick={toggleRuntimeMode}
                            title={
                              runtimeMode === "full-access"
                                ? "Full access — click to require approvals"
                                : "Approval required — click for full access"
                            }
                          >
                            {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                          </Button>
                        </>
                      ) : null}
                    </>
                  )}
                </div>

                {/* Right side: send / stop button */}
                <div data-chat-composer-actions="right" className="flex shrink-0 items-center gap-2">
                  {isPreparingWorktree ? (
                    <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
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
                  ) : pendingUserInputs.length === 0 ? (
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
                          (!prompt.trim() && composerImages.length === 0)
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

      {isGitRepo && (
        <BranchToolbar
          threadId={activeThread.id}
          onEnvModeChange={onEnvModeChange}
          envLocked={envLocked}
          runtimeMode={runtimeMode}
          onRuntimeModeChange={handleRuntimeModeChange}
          onHandoffToWorktree={onHandoffToWorktree}
          onHandoffToLocal={onHandoffToLocal}
          handoffBusy={handoffBusy}
          onComposerFocusRequest={scheduleComposerFocus}
        />
      )}

      {(() => {
        if (!terminalState.terminalOpen || !activeProject) {
          return null;
        }
        return (
          <ThreadTerminalDrawer
            key={activeThread.id}
            threadId={activeThread.id}
            cwd={gitCwd ?? activeProject.cwd}
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
  browserPaneOpen: boolean;
  gitCwd: string | null;
  diffOpen: boolean;
  surfaceMode: "single" | "split";
  isFocusedPane: boolean;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onOpenTask: (() => void) | null;
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
  browserPaneOpen,
  gitCwd,
  diffOpen,
  surfaceMode,
  isFocusedPane,
  onSplitSurface,
  onMaximizeSurface,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onOpenTask,
  onToggleDiff,
  onToggleBrowser,
  onCreateHandoff,
  onCycleHandoffTargetProvider,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const needsDesktopTrafficLightInset = isElectron && !isMobile && state === "collapsed";
  const headerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const diffTotals = gitStatus?.workingTree ?? null;
  const showDiffTotals = (diffTotals?.insertions ?? 0) > 0 || (diffTotals?.deletions ?? 0) > 0;
  const isDisposableThread = useIsDisposableThread(activeThreadId);
  const chatLayoutAction =
    surfaceMode === "single" && onSplitSurface
      ? { kind: "split" as const, label: "Split chat", onClick: onSplitSurface }
      : surfaceMode === "split" && isFocusedPane && onMaximizeSurface
        ? { kind: "maximize" as const, label: "Expand this chat", onClick: onMaximizeSurface }
        : null;
  const hasCollapsibleControls = Boolean(activeProjectScripts || activeProjectName || onOpenTask);
  const [handoffFlipDirection, setHandoffFlipDirection] = useState<1 | -1 | 0>(0);
  const handoffWheelAccumRef = useRef(0);
  const handoffWheelCooldownUntilRef = useRef(0);
  const handoffWheelLastEventAtRef = useRef(0);
  const handoffCanCycle = handoffTargetProviderCount > 1 && !handoffDisabled;
  const cycleHandoffTargetProvider = useCallback((direction: 1 | -1) => {
    if (!handoffCanCycle) {
      return;
    }
    setHandoffFlipDirection(direction);
    onCycleHandoffTargetProvider(direction);
  }, [handoffCanCycle, onCycleHandoffTargetProvider]);
  const onHandoffWheel = useCallback((event: ReactWheelEvent<HTMLButtonElement>) => {
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
  }, [cycleHandoffTargetProvider, handoffCanCycle]);
  useEffect(() => {
    if (handoffCanCycle) {
      return;
    }
    handoffWheelAccumRef.current = 0;
    handoffWheelCooldownUntilRef.current = 0;
    handoffWheelLastEventAtRef.current = 0;
  }, [handoffCanCycle]);
  const onHandoffKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
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
  }, [cycleHandoffTargetProvider, handoffCanCycle]);
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
  const preferredEditor = useMemo<EditorId | null>(() => {
    const stored =
      typeof window !== "undefined"
        ? (localStorage.getItem(LAST_EDITOR_KEY) as EditorId | null)
        : null;
    if (stored && availableEditors.includes(stored)) {
      return stored;
    }
    return availableEditors[0] ?? null;
  }, [availableEditors]);
  const openInPreferredEditor = useCallback(() => {
    const api = readNativeApi();
    if (!api || !openInCwd || !preferredEditor) return;
    void api.shell.openInEditor(openInCwd, preferredEditor);
    localStorage.setItem(LAST_EDITOR_KEY, preferredEditor);
  }, [openInCwd, preferredEditor]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setCompact(surfaceMode === "split" || el.clientWidth < HEADER_COMPACT_BREAKPOINT);
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
        className="flex shrink-0 items-center gap-1.5 @lg/header-actions:gap-2"
        data-testid="chat-header-actions"
      >
        {!isDisposableThread ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className={cn(
                    compact ? "shrink-0 gap-1" : "shrink-0 gap-1.5",
                    handoffCanCycle ? "cursor-ns-resize" : "",
                  )}
                  aria-label={handoffActionLabel}
                  disabled={handoffDisabled}
                  onClick={onCreateHandoff}
                  onWheel={onHandoffWheel}
                  onKeyDown={onHandoffKeyDown}
                >
                  <FiGitBranch className="size-3.5 shrink-0" />
                  {compact ? null : <span className="truncate">Hand off to</span>}
                  <span
                    key={handoffActionTargetProvider ?? "codex"}
                    className={cn("inline-flex items-center gap-1.5", handoffProviderAnimationClass)}
                  >
                    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                      {renderProviderIcon(handoffActionTargetProvider, "size-3.5")}
                    </span>
                    {!compact && (
                      <span className="truncate">
                        {PROVIDER_DISPLAY_NAMES[handoffActionTargetProvider ?? "codex"]}
                      </span>
                    )}
                  </span>
                </Button>
              }
            />
            <TooltipPopup side="bottom">{handoffActionLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        {!compact && activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
          />
        )}
        {!compact && activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {!compact && onOpenTask ? (
          <Button variant="outline" size="xs" className="shrink-0" onClick={onOpenTask}>
            <KanbanSquareIcon className="size-3" />
            <span className="hidden sm:inline">Open task</span>
          </Button>
        ) : null}
        {compact && hasCollapsibleControls ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label="More actions"
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {activeProjectScripts
                ? activeProjectScripts.map((script) => (
                    <MenuItem key={script.id} onClick={() => onRunProjectScript(script)}>
                      <span className="truncate">{script.name}</span>
                    </MenuItem>
                  ))
                : null}
              {activeProjectScripts ? (
                <MenuItem onClick={() => setCompact(false)}>
                  <PlusIcon className="size-3.5" />
                  Add action
                </MenuItem>
              ) : null}
              {activeProjectName ? (
                <>
                  <MenuDivider />
                  <MenuItem onClick={openInPreferredEditor} disabled={!openInCwd || !preferredEditor}>
                    Open in editor
                  </MenuItem>
                </>
              ) : null}
              {onOpenTask ? (
                <MenuItem onClick={onOpenTask}>
                  <KanbanSquareIcon className="size-3.5" />
                  Open task
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        {activeProjectName && <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />}
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className={cn("shrink-0", showDiffTotals ? "gap-1 px-1.5 text-[12px]" : "")}
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                {showDiffTotals ? (
                  <>
                    <span className="font-mono text-[12px] font-light tracking-normal tabular-nums text-success">
                      +{diffTotals?.insertions ?? 0}
                    </span>
                    <span className="font-mono text-[12px] font-light tracking-normal tabular-nums text-destructive">
                      -{diffTotals?.deletions ?? 0}
                    </span>
                    <span
                      aria-hidden
                      className="ml-0.5 h-3.5 w-px shrink-0 bg-border/80"
                    />
                    <PanelLeftIcon className="size-3.5 text-muted-foreground" />
                  </>
                ) : (
                  <PanelLeftIcon className="size-3.5 text-muted-foreground" />
                )}
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
              ? `Toggle diff panel (${diffToggleShortcutLabel})`
              : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
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
const COMING_SOON_PROVIDER_OPTIONS = [
  { id: "gemini", label: "Gemini", icon: Gemini },
] as const;

function getCustomModelOptionsByProvider(settings: {
  customCodexModels: readonly string[];
  customOpencodeModels: readonly string[];
  customClaudeModels: readonly string[];
}): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    codex: getAppModelOptions("codex", settings.customCodexModels),
    opencode: getAppModelOptions("opencode", settings.customOpencodeModels),
    claudeAgent: getAppModelOptions("claudeAgent", settings.customClaudeModels),
  };
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  opencode: OpenCodeIcon,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
};

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
  const selectedProviderOptions = props.modelOptionsByProvider[props.provider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.provider];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "min-w-0 justify-start whitespace-nowrap text-muted-foreground/70 hover:text-foreground/80",
              props.compact ? "max-w-44 shrink-0 pl-2 pr-1.5 [&_svg]:mx-0" : "shrink-0 px-2 sm:px-3",
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2">
          <ProviderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
          {props.provider === "codex" && shouldShowFastTierIcon(props.model, props.serviceTierSetting) ? (
            <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
          ) : null}
          <span className="min-w-0 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
          const isDisabledByProviderLock =
            props.lockedProvider !== null && props.lockedProvider !== option.value;
          return (
            <MenuSub key={option.value}>
              <MenuSubTrigger disabled={isDisabledByProviderLock}>
                <OptionIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/85"
                />
                {option.label}
              </MenuSubTrigger>
              <MenuSubPopup className="[--available-height:min(24rem,70vh)]">
                <MenuGroup>
                  <MenuRadioGroup
                    value={props.provider === option.value ? props.model : ""}
                    onValueChange={(value) => {
                      if (props.disabled) return;
                      if (isDisabledByProviderLock) return;
                      if (!value) return;
                      const resolvedModel = resolveModelForProviderPicker(
                        option.value,
                        value,
                        props.modelOptionsByProvider[option.value],
                      );
                      if (!resolvedModel) return;
                      props.onProviderModelChange(option.value, resolvedModel);
                      setIsMenuOpen(false);
                    }}
                  >
                    {props.modelOptionsByProvider[option.value].map((modelOption) => (
                      <MenuRadioItem
                        key={`${option.value}:${modelOption.slug}`}
                        value={modelOption.slug}
                        onClick={() => setIsMenuOpen(false)}
                      >
                        {option.value === "codex" &&
                        shouldShowFastTierIcon(modelOption.slug, props.serviceTierSetting) ? (
                          <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                        ) : null}
                        {modelOption.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
        {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
        {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
          return (
            <MenuItem key={option.value} disabled>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 opacity-80",
                  option.value === "claudeAgent" ? "" : "text-muted-foreground/85",
                )}
              />
              <span>{option.label}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                Coming soon
              </span>
            </MenuItem>
          );
        })}
        {UNAVAILABLE_PROVIDER_OPTIONS.length === 0 && <MenuDivider />}
        {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <MenuItem key={option.id} disabled>
              <OptionIcon aria-hidden="true" className="size-4 shrink-0 opacity-80" />
              <span>{option.label}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                Coming soon
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
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
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @lg/header-actions:not-sr-only @lg/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @lg/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
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
