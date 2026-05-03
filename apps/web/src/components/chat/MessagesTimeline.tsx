import { ThreadId, type MessageId, type TurnId } from "@t3tools/contracts";
import { clamp } from "effect/Number";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { FileDiff } from "@pierre/diffs/react";
import {
  BotIcon,
  BoxIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileIcon,
  FolderClosedIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  MousePointer2Icon,
  PinIcon,
  PlugIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import {
  deriveTimelineEntries,
  formatElapsed,
  formatTimestamp,
  type InvocationDiffFile,
  type WorkLogEntry,
} from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import {
  type TurnDiffFileChange,
  type TurnDiffSummary,
} from "../../types";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import {
  type RenderableInvocationDiffFile,
  toRenderableInvocationDiffFile,
} from "../../lib/invocationDiffRendering";
import {
  normalizeSelectedText,
  reconstructRangeFromOffsets,
  serializeRangeWithinContainer,
} from "../../chatPinnedSelections";
import {
  buildProposedPlanMarkdownFilename,
  proposedPlanTitle,
} from "../../proposedPlan";
import { type PinnedSelectionDraft } from "../../composerDraftStore";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { getVscodeIconUrlForEntry } from "../../vscode-icons";
import {
  humanizeSubagentStatus,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const LARGE_THREAD_ROW_COUNT = 180;
const HUGE_THREAD_ROW_COUNT = 420;
const LARGE_THREAD_UNVIRTUALIZED_TAIL_ROWS = 5;
const HUGE_THREAD_UNVIRTUALIZED_TAIL_ROWS = 3;
const CHAT_SELECTION_REGION_ATTRIBUTE = "data-chat-selection-region";
const CHAT_SELECTION_REGION_VALUE = "assistant-output";
const CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE = "data-chat-selection-source-kind";
const CHAT_SELECTION_SOURCE_ID_ATTRIBUTE = "data-chat-selection-source-id";
const CHAT_SELECTION_QUOTE_ACTION_LABEL = "Quote selected text";
const CHAT_SELECTION_PIN_ACTION_LABEL = "Pin selected text";
const CHAT_SELECTION_ACTION_WIDTH_PX = 96;
const CHAT_SELECTION_ACTION_HEIGHT_PX = 36;
const CHAT_SELECTION_VIEWPORT_PADDING_PX = 12;
const CHAT_SELECTION_ACTION_OFFSET_PX = 8;
const CHAT_PIN_MARKER_SIZE_PX = 24;
const CHAT_PIN_MARKER_SCROLL_SETTLE_MS = 96;
const CHAT_SELECTION_IGNORE_SELECTOR =
  "button, summary, [role='button'], [role='menuitem'], input, textarea, select, option, [data-chat-selection-ignore='true']";
const EMPTY_INVOCATION_DIFF_FILES: ReadonlyArray<InvocationDiffFile> = [];
const LEADING_PROVIDER_MENTION_PATTERN = /^([$/])([^\s]+)(?=\s|$)/;

type AssistantArtifactKind = "document" | "markdown" | "slides" | "spreadsheet" | "pdf";

const ASSISTANT_ARTIFACT_EXTENSIONS: ReadonlyMap<string, AssistantArtifactKind> = new Map([
  ["docx", "document"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mdown", "markdown"],
  ["mdx", "markdown"],
  ["mkd", "markdown"],
  ["pptx", "slides"],
  ["xls", "spreadsheet"],
  ["xlsx", "spreadsheet"],
  ["pdf", "pdf"],
]);

export interface MessagesTimelineProps {
  isFocusedPane?: boolean;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  onOpenFilePath?: ((path: string, options?: { cwd?: string | undefined }) => void) | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  homeDirectory: string | undefined;
  pinnedSelections: readonly PinnedSelectionDraft[];
  onAskAboutSelectedText: (selectedText: string) => void;
  onPinSelectedText: (
    selection: Omit<PinnedSelectionDraft, "id" | "createdAt">,
  ) => void;
  onRemovePinnedSelection: (pinnedSelectionId: string) => void;
  pendingPinnedSelectionJumpId: string | null;
  onPinnedSelectionJumpHandled: (pinnedSelectionId: string) => void;
  userMessageMentionDescriptors: readonly UserMessageMentionDescriptor[];
}

export interface UserMessageMentionDescriptor {
  mentionName: string;
  label: string;
  type: "plugin" | "skill";
  iconUrl?: string | undefined;
}

function formatSubagentModelLabel(model: string | undefined): string | null {
  if (!model) {
    return null;
  }
  return model.includes("/") ? model.split("/").at(-1) ?? model : model;
}

function subagentStatusClasses(
  statusLabel: string | null | undefined,
  rawStatus: string | undefined,
  isActive: boolean | undefined,
): string {
  const normalized = humanizeSubagentStatus(rawStatus ?? statusLabel ?? null, isActive === true);
  if (normalized === "Running") {
    return "border-sky-400/35 bg-sky-400/10 text-sky-300";
  }
  if (normalized === "Completed") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  }
  if (normalized === "Failed") {
    return "border-rose-400/35 bg-rose-400/10 text-rose-300";
  }
  if (normalized === "Stopped") {
    return "border-amber-400/30 bg-amber-400/10 text-amber-300";
  }
  return "border-border/50 bg-background/70 text-muted-foreground/80";
}

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

interface AssistantSelectionActionState {
  left: number;
  top: number;
  selectedText: string;
  sourceKind: PinnedSelectionDraft["sourceKind"];
  sourceId: string;
  plainTextStart: number;
  plainTextEnd: number;
}

type UserMessageTextSegment =
  | { type: "shortcut"; key: string; command: "browser" | "review" | "subagents" | "inspect"; args: string }
  | { type: "mention"; key: string; descriptor: UserMessageMentionDescriptor }
  | { type: "text"; key: string; text: string };

function parseLeadingShortcut(rawName: string): {
  command: "browser" | "review" | "subagents" | "inspect";
  label: string;
} | null {
  switch (rawName.toLowerCase()) {
    case "browser":
      return { command: "browser", label: "T3 Browser Use" };
    case "review":
      return { command: "review", label: "Code Review" };
    case "subagents":
      return { command: "subagents", label: "Subagents" };
    case "inspect":
      return { command: "inspect", label: "Inspected element" };
    default:
      return null;
  }
}

function splitUserMessageProviderMentions(
  text: string,
  descriptors: readonly UserMessageMentionDescriptor[],
): UserMessageTextSegment[] {
  const descriptorsByName = new Map(
    descriptors.map((descriptor) => [descriptor.mentionName.toLowerCase(), descriptor]),
  );
  const segments: UserMessageTextSegment[] = [];
  let remaining = text;
  let offset = 0;

  while (remaining.length > 0) {
    const match = LEADING_PROVIDER_MENTION_PATTERN.exec(remaining);
    if (!match?.[2]) break;
    const rawName = match[2];
    const shortcut = match[1] === "/" ? parseLeadingShortcut(rawName) : null;
    if (shortcut) {
      segments.push({
        type: "shortcut",
        key: `shortcut:${offset}:${rawName}`,
        command: shortcut.command,
        args: "",
      });
      const nextRemaining = remaining.slice(match[0].length);
      const trimmedRemaining = nextRemaining.trimStart();
      offset += match[0].length + nextRemaining.length - trimmedRemaining.length;
      remaining = trimmedRemaining;
      continue;
    }
    const descriptor =
      descriptorsByName.get(rawName.toLowerCase()) ?? {
        mentionName: rawName,
        label: rawName,
        type: "plugin" as const,
      };
    segments.push({
      type: "mention",
      key: `mention:${offset}:${rawName}`,
      descriptor,
    });
    const nextRemaining = remaining.slice(match[0].length);
    const trimmedRemaining = nextRemaining.trimStart();
    offset += match[0].length + nextRemaining.length - trimmedRemaining.length;
    remaining = trimmedRemaining;
  }

  if (remaining.length > 0) {
    segments.push({ type: "text", key: `text:${offset}`, text: remaining });
  }
  return segments.length > 0 ? segments : [{ type: "text", key: "text:0", text }];
}

const UserMessageMentionChip = memo(function UserMessageMentionChip(props: {
  descriptor: UserMessageMentionDescriptor;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const failed =
    props.descriptor.iconUrl !== undefined && failedIconUrl === props.descriptor.iconUrl;
  const Icon = props.descriptor.type === "plugin" ? PlugIcon : BoxIcon;

  return (
    <span className="inline-flex align-middle items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm font-medium text-blue-500 dark:text-blue-400">
      {props.descriptor.iconUrl && !failed ? (
        <img
          src={props.descriptor.iconUrl}
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0 object-contain"
          draggable={false}
          onError={() => setFailedIconUrl(props.descriptor.iconUrl ?? null)}
        />
      ) : (
        <Icon className="size-4 shrink-0" />
      )}
      <span className="max-w-40 truncate">{props.descriptor.label}</span>
    </span>
  );
});

const UserMessageShortcutChip = memo(function UserMessageShortcutChip(props: {
  command: "browser" | "review" | "subagents" | "inspect";
}) {
  const Icon =
    props.command === "browser"
      ? GlobeIcon
      : props.command === "review"
        ? SquarePenIcon
        : props.command === "inspect"
          ? MousePointer2Icon
          : BotIcon;
  const label =
    props.command === "browser"
      ? "T3 Browser Use"
      : props.command === "review"
        ? "Code Review"
        : props.command === "inspect"
          ? "Inspected element"
          : "Subagents";
  return (
    <span
      className={cn(
        "inline-flex align-middle items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm font-medium",
        props.command === "inspect"
          ? "text-cyan-500 dark:text-cyan-400"
          : "text-emerald-500 dark:text-emerald-400",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="max-w-40 truncate">{label}</span>
    </span>
  );
});

const UserMessageText = memo(function UserMessageText(props: {
  text: string;
  cwd: string | undefined;
  descriptors: readonly UserMessageMentionDescriptor[];
  onOpenFilePath: ((path: string) => void) | undefined;
}) {
  const segments = useMemo(
    () => splitUserMessageProviderMentions(props.text, props.descriptors),
    [props.descriptors, props.text],
  );

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
      {segments.map((segment) =>
        segment.type === "shortcut" ? (
          <UserMessageShortcutChip key={segment.key} command={segment.command} />
        ) : segment.type === "mention" ? (
          <UserMessageMentionChip
            key={segment.key}
            descriptor={segment.descriptor}
          />
        ) : (
          <ChatMarkdown
            key={segment.key}
            text={segment.text}
            cwd={props.cwd}
            isStreaming={false}
            variant="user"
            onOpenFilePath={props.onOpenFilePath}
          />
        ),
      )}
    </div>
  );
});

interface PinnedSelectionMarker {
  id: string;
  left: number;
  top: number;
  selectedText: string;
}

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function getSelectionRegionElement(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node instanceof Element ? node : node.parentElement;
  return (
    element?.closest<HTMLElement>(
      `[${CHAT_SELECTION_REGION_ATTRIBUTE}="${CHAT_SELECTION_REGION_VALUE}"]`,
    ) ?? null
  );
}

function getSelectionSourceKind(
  element: HTMLElement,
): PinnedSelectionDraft["sourceKind"] | null {
  const sourceKind = element.getAttribute(CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE);
  return sourceKind === "assistant-message" || sourceKind === "proposed-plan" ? sourceKind : null;
}

function getSelectionSourceId(element: HTMLElement): string | null {
  const sourceId = element.getAttribute(CHAT_SELECTION_SOURCE_ID_ATTRIBUTE);
  return sourceId && sourceId.length > 0 ? sourceId : null;
}

function isIgnoredSelectionTarget(node: Node | null): boolean {
  if (!node) return false;
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(CHAT_SELECTION_IGNORE_SELECTOR));
}

function getSelectionAnchorRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const anchorRect = rects.at(-1) ?? range.getBoundingClientRect();
  if (anchorRect.width <= 0 && anchorRect.height <= 0) {
    return null;
  }
  return anchorRect;
}

function getPinnedSelectionMarkerPosition(range: Range): { left: number; top: number } | null {
  const anchorRect = getSelectionAnchorRect(range);
  if (!anchorRect) {
    return null;
  }

  const minViewportEdge = CHAT_SELECTION_VIEWPORT_PADDING_PX;
  const maxViewportEdgeX = window.innerWidth - CHAT_SELECTION_VIEWPORT_PADDING_PX;
  const maxViewportEdgeY = window.innerHeight - CHAT_SELECTION_VIEWPORT_PADDING_PX;
  const isOutsideViewport =
    anchorRect.bottom <= minViewportEdge ||
    anchorRect.top >= maxViewportEdgeY ||
    anchorRect.right <= minViewportEdge ||
    anchorRect.left >= maxViewportEdgeX;
  if (isOutsideViewport) {
    return null;
  }

  return {
    left: clamp(anchorRect.right - Math.round(CHAT_PIN_MARKER_SIZE_PX * 0.4), {
      minimum: minViewportEdge,
      maximum: maxViewportEdgeX - CHAT_PIN_MARKER_SIZE_PX,
    }),
    top: clamp(anchorRect.top + anchorRect.height / 2 - CHAT_PIN_MARKER_SIZE_PX / 2, {
      minimum: minViewportEdge,
      maximum: maxViewportEdgeY - CHAT_PIN_MARKER_SIZE_PX,
    }),
  };
}

function scrollRangeIntoContainerView(
  range: Range,
  scrollContainer: HTMLElement,
  behavior: ScrollBehavior = "smooth",
): boolean {
  const anchorRect = getSelectionAnchorRect(range);
  if (!anchorRect) {
    return false;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const targetTop =
    scrollContainer.scrollTop +
    (anchorRect.top - containerRect.top) -
    (containerRect.height / 2 - anchorRect.height / 2);
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

  scrollContainer.scrollTo({
    top: clamp(targetTop, { minimum: 0, maximum: maxScrollTop }),
    behavior,
  });
  return true;
}

function getSelectionActionPosition(anchorRect: DOMRect): { left: number; top: number } {
  const preferredLeft = anchorRect.right + CHAT_SELECTION_ACTION_OFFSET_PX;
  const preferredTop = anchorRect.bottom + CHAT_SELECTION_ACTION_OFFSET_PX;
  const maxLeft =
    window.innerWidth - CHAT_SELECTION_VIEWPORT_PADDING_PX - CHAT_SELECTION_ACTION_WIDTH_PX;
  const maxTop =
    window.innerHeight - CHAT_SELECTION_VIEWPORT_PADDING_PX - CHAT_SELECTION_ACTION_HEIGHT_PX;
  const minLeft = CHAT_SELECTION_VIEWPORT_PADDING_PX;
  const minTop = CHAT_SELECTION_VIEWPORT_PADDING_PX;

  const left = clamp(
    preferredLeft > maxLeft ? anchorRect.left - CHAT_SELECTION_ACTION_WIDTH_PX : preferredLeft,
    {
      minimum: minLeft,
      maximum: Math.max(minLeft, maxLeft),
    },
  );
  const top = clamp(
    preferredTop > maxTop ? anchorRect.top - CHAT_SELECTION_ACTION_HEIGHT_PX : preferredTop,
    {
      minimum: minTop,
      maximum: Math.max(minTop, maxTop),
    },
  );

  return { left, top };
}

function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
    default:
      return workToneIcon(workEntry.tone).icon;
  }
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function workEntryKindLabel(workEntry: TimelineWorkEntry): string | null {
  if (workEntry.requestKind === "command") return "Approval";
  if (workEntry.requestKind === "file-read") return "Read";
  if (workEntry.requestKind === "file-change") return "Approval";

  switch (workEntry.itemType) {
    case "command_execution":
      return "Command";
    case "file_change":
      return "Edit";
    case "web_search":
      return "Search";
    case "image_view":
      return "View";
    case "mcp_tool_call":
      return "MCP";
    case "dynamic_tool_call":
      return "Tool";
    case "collab_agent_tool_call":
      return "Agent";
    default:
      return workEntry.tone === "tool" ? "Tool" : null;
  }
}

function estimateTimelineProposedPlanHeight(proposedPlan: TimelineProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );
  const failed = failedIconUrl === iconUrl;

  if (failed) {
    return props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 text-muted-foreground/80", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 text-muted-foreground/80", props.className)} />
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={cn("size-4 shrink-0", props.className)}
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
});

const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button type="button" size="xs" variant="outline" onClick={handleCopy} title="Copy message">
      {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  showParentheses?: boolean;
}) {
  const { additions, deletions, showParentheses = false } = props;
  return (
    <>
      {showParentheses && <span className="text-muted-foreground/70">(</span>}
      <span className="text-success">+{additions}</span>
      <span className="mx-0.5 text-muted-foreground/70">/</span>
      <span className="text-destructive">-{deletions}</span>
      {showParentheses && <span className="text-muted-foreground/70">)</span>}
    </>
  );
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

function buildDirectoryExpansionState(
  directoryPaths: ReadonlyArray<string>,
  expanded: boolean,
): Record<string, boolean> {
  const expandedState: Record<string, boolean> = {};
  for (const directoryPath of directoryPaths) {
    expandedState[directoryPath] = expanded;
  }
  return expandedState;
}

function fileExtension(pathValue: string): string {
  const fileName = pathValue.split(/[\\/]/).at(-1) ?? pathValue;
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === fileName.length - 1) return "";
  return fileName.slice(extensionIndex + 1).toLowerCase();
}

function artifactKindForPath(pathValue: string): AssistantArtifactKind | null {
  return ASSISTANT_ARTIFACT_EXTENSIONS.get(fileExtension(pathValue)) ?? null;
}

function artifactFileName(pathValue: string): string {
  return pathValue.split(/[\\/]/).at(-1) ?? pathValue;
}

function artifactKindLabel(kind: AssistantArtifactKind): string {
  switch (kind) {
    case "document":
      return "Document";
    case "markdown":
      return "Markdown";
    case "slides":
      return "Slides";
    case "spreadsheet":
      return "Spreadsheet";
    case "pdf":
      return "PDF";
  }
}

function collectAssistantArtifacts(
  files: ReadonlyArray<TurnDiffFileChange>,
): AssistantArtifact[] {
  const seenPaths = new Set<string>();
  const artifacts: AssistantArtifact[] = [];
  for (const file of files) {
    const artifactKind = artifactKindForPath(file.path);
    if (!artifactKind || seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);
    artifacts.push({ ...file, artifactKind, source: "checkpoint" });
  }
  return artifacts;
}

type AssistantArtifact = TurnDiffFileChange & {
  artifactKind: AssistantArtifactKind;
  source: "checkpoint" | "message";
  cwd?: string | undefined;
};

function collectMentionedAssistantArtifacts(input: {
  text: string;
  existingPaths: ReadonlySet<string>;
  workspaceRoot: string | undefined;
  homeDirectory: string | undefined;
}): AssistantArtifact[] {
  const normalizedText = input.text.replaceAll("\\", "/");
  const lowerText = input.text.toLowerCase();
  const mentionedHome =
    lowerText.includes("user directory") ||
    lowerText.includes("home directory") ||
    lowerText.includes("home folder");
  const baseCwd = mentionedHome ? input.homeDirectory : input.workspaceRoot;
  const artifacts: AssistantArtifact[] = [];
  const seenPaths = new Set(input.existingPaths);
  const artifactPattern =
    /(?:^|[\s`"'(])((?:[A-Za-z]:\/)?(?:[\w .@()[\]-]+\/)*[\w .@()[\]-]+\.(?:markdown|mdown|mdx?|mkd|docx|pptx|xlsx|xls|pdf))(?=$|[\s`"',).])/gi;

  for (const match of normalizedText.matchAll(artifactPattern)) {
    const rawPath = match[1]?.trim();
    if (!rawPath) continue;
    const artifactKind = artifactKindForPath(rawPath);
    if (!artifactKind) continue;
    const pathValue = rawPath.replace(/^[`"']|[`"']$/g, "");
    const windowsAbsoluteMatch = /^([A-Za-z]:\/.*)\/([^/]+)$/.exec(pathValue);
    const artifactPath = windowsAbsoluteMatch?.[2] ?? pathValue;
    const artifactCwd = windowsAbsoluteMatch?.[1] ?? baseCwd;
    const artifactKey = artifactCwd ? `${artifactCwd}\u0000${artifactPath}` : artifactPath;
    if (seenPaths.has(artifactKey)) continue;
    seenPaths.add(artifactKey);
    artifacts.push({
      path: artifactPath,
      artifactKind,
      source: "message",
      ...(artifactCwd ? { cwd: artifactCwd } : {}),
    });
  }

  return artifacts;
}

const AssistantArtifactCards = memo(function AssistantArtifactCards(props: {
  artifacts: ReadonlyArray<AssistantArtifact>;
  resolvedTheme: "light" | "dark";
  onOpenFilePath?: ((path: string, options?: { cwd?: string | undefined }) => void) | undefined;
}) {
  if (props.artifacts.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {props.artifacts.map((artifact) => {
        const extension = fileExtension(artifact.path).toUpperCase();
        const title = artifactFileName(artifact.path);
        const canOpen = Boolean(props.onOpenFilePath);
        return (
          <div
            key={`assistant-artifact:${artifact.path}`}
            className="flex min-w-0 items-center gap-3 rounded-lg border border-border/80 bg-card/55 p-2.5"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/80">
              <VscodeEntryIcon
                pathValue={artifact.path}
                kind="file"
                theme={props.resolvedTheme}
                className="size-5"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground" title={title}>
                {title}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {artifactKindLabel(artifact.artifactKind)}
                {extension ? ` · ${extension}` : ""}
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canOpen}
              onClick={() => props.onOpenFilePath?.(artifact.path, { cwd: artifact.cwd })}
              title={canOpen ? `Open ${title}` : "File viewer is unavailable"}
              className="shrink-0"
            >
              <span>Open</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
});

const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, turnId } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const allDirectoryExpansionState = useMemo(
    () =>
      buildDirectoryExpansionState(
        directoryPathsKey ? directoryPathsKey.split("\u0000") : [],
        allDirectoriesExpanded,
      ),
    [allDirectoriesExpanded, directoryPathsKey],
  );
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(() =>
    buildDirectoryExpansionState(directoryPathsKey ? directoryPathsKey.split("\u0000") : [], true),
  );

  useEffect(() => {
    setExpandedDirectories(allDirectoryExpansionState);
  }, [allDirectoryExpansionState]);

  const toggleDirectory = useCallback((pathValue: string, fallbackExpanded: boolean) => {
    setExpandedDirectories((current) => ({
      ...current,
      [pathValue]: !(current[pathValue] ?? fallbackExpanded),
    }));
  }, []);

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? depth === 0;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path, depth === 0)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="truncate font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

const ProposedPlanCard = memo(function ProposedPlanCard(props: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  sourceId: string;
  onOpenFilePath?: ((path: string) => void) | undefined;
}) {
  const { planMarkdown, cwd, workspaceRoot, sourceId } = props;
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadTextFile(downloadFilename, saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readNativeApi();
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred while saving.",
        });
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          <div
            {...{
              [CHAT_SELECTION_REGION_ATTRIBUTE]: CHAT_SELECTION_REGION_VALUE,
              [CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE]: "proposed-plan",
              [CHAT_SELECTION_SOURCE_ID_ATTRIBUTE]: sourceId,
            }}
          >
            <ChatMarkdown
              text={planMarkdown}
              cwd={cwd}
              isStreaming={false}
              onOpenFilePath={props.onOpenFilePath}
            />
          </div>
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="outline" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: WorkLogEntry;
  resolvedTheme: "light" | "dark";
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { onOpenThread, workEntry, resolvedTheme } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const detailPreview =
    !workEntry.command && workEntry.detail
      ? workEntry.detail.split(/\r?\n/, 1)[0]?.trim() ?? null
      : null;
  const displayText = detailPreview ? `${heading} - ${detailPreview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const kindLabel = workEntryKindLabel(workEntry);
  const hasInvocationDiffStat = workEntry.invocationDiffStat
    ? hasNonZeroStat(workEntry.invocationDiffStat)
    : false;
  const invocationDiffFiles = workEntry.invocationDiffFiles ?? EMPTY_INVOCATION_DIFF_FILES;
  const canExpandInvocationDiff = invocationDiffFiles.length > 0;
  const primaryInvocationPath = invocationDiffFiles[0]?.path ?? null;
  const changedFilesLabel = hasChangedFiles
    ? (() => {
        const visible = workEntry.changedFiles?.slice(0, 2) ?? [];
        const hiddenCount = Math.max(0, (workEntry.changedFiles?.length ?? 0) - visible.length);
        return hiddenCount > 0 ? `${visible.join(", ")}, +${hiddenCount} more` : visible.join(", ");
      })()
    : null;
  const [isInvocationDiffExpanded, setIsInvocationDiffExpanded] = useState(false);
  const [activeInvocationDiffPath, setActiveInvocationDiffPath] = useState<string | null>(
    primaryInvocationPath,
  );
  const [parsedByPath, setParsedByPath] = useState<Record<string, RenderableInvocationDiffFile | null>>(
    {},
  );

  useEffect(() => {
    if (!canExpandInvocationDiff) {
      setIsInvocationDiffExpanded(false);
      setActiveInvocationDiffPath(null);
      setParsedByPath({});
      return;
    }
    const nextPrimary = invocationDiffFiles[0]?.path ?? null;
    if (!activeInvocationDiffPath) {
      setActiveInvocationDiffPath(nextPrimary);
      return;
    }
    const activeExists = invocationDiffFiles.some((file) => file.path === activeInvocationDiffPath);
    if (!activeExists) {
      setActiveInvocationDiffPath(nextPrimary);
    }
  }, [activeInvocationDiffPath, canExpandInvocationDiff, invocationDiffFiles]);

  const ensureInvocationDiffParsed = useCallback(
    (path: string | null) => {
      if (!path) return;
      const target = invocationDiffFiles.find((file) => file.path === path);
      if (!target) return;
      setParsedByPath((current) => {
        if (Object.prototype.hasOwnProperty.call(current, path)) {
          return current;
        }
        const parsed = toRenderableInvocationDiffFile(target, `invocation:${workEntry.id}:${path}`);
        return {
          ...current,
          [path]: parsed,
        };
      });
    },
    [invocationDiffFiles, workEntry.id],
  );

  const onToggleInvocationDiff = useCallback(() => {
    setIsInvocationDiffExpanded((current) => {
      const next = !current;
      if (next) {
        ensureInvocationDiffParsed(activeInvocationDiffPath);
      }
      return next;
    });
  }, [activeInvocationDiffPath, ensureInvocationDiffParsed]);

  const onSelectInvocationDiffPath = useCallback(
    (path: string) => {
      setActiveInvocationDiffPath(path);
      ensureInvocationDiffParsed(path);
    },
    [ensureInvocationDiffParsed],
  );

  const activeInvocationDiff =
    (activeInvocationDiffPath ? parsedByPath[activeInvocationDiffPath] : null) ?? null;

  if ((workEntry.subagents?.length ?? 0) > 0 || workEntry.subagentAction) {
    const subagentSummary =
      workEntry.subagentAction?.summaryText ??
      ((workEntry.subagents?.length ?? 0) === 1
        ? workEntry.subagents?.[0]?.nickname ?? workEntry.subagents?.[0]?.title ?? "Subagent"
        : `${workEntry.subagents?.length ?? 0} subagents`);
    const subagentMeta = [
      formatSubagentModelLabel(workEntry.subagentAction?.model),
      workEntry.subagentAction?.prompt,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" • ");
    const visibleSubagents = workEntry.subagents?.slice(0, 3) ?? [];
    const hiddenSubagentCount = Math.max(
      0,
      (workEntry.subagents?.length ?? 0) - visibleSubagents.length,
    );

    return (
      <div className="space-y-1.5 rounded-md border border-border/35 bg-background/35 px-2 py-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className={cn("mt-0.5 flex size-4.5 shrink-0 items-center justify-center", iconConfig.className)}>
            <EntryIcon className="size-3" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium leading-4.5 text-foreground/85" title={subagentSummary}>
              {subagentSummary}
            </p>
            {subagentMeta ? (
              <p className="truncate text-[10px] leading-4 text-muted-foreground/70" title={subagentMeta}>
                {subagentMeta}
              </p>
            ) : null}
          </div>
        </div>
        {(visibleSubagents.length > 0 || hiddenSubagentCount > 0) && (
          <div className="space-y-[5px] rounded-lg border border-border/45 bg-background/55 px-2.5 py-2">
            {visibleSubagents.map((subagent) => {
              const presentation = resolveSubagentPresentation({
                nickname: subagent.nickname,
                role: subagent.role,
                title: subagent.title,
                fallbackId: subagent.threadId,
              });
              const secondaryLabel = [subagent.title, formatSubagentModelLabel(subagent.model)]
                .filter((value): value is string => Boolean(value))
                .join(" • ");
              const displayStatusLabel =
                subagent.statusLabel ??
                humanizeSubagentStatus(subagent.rawStatus ?? null, subagent.isActive);
              const resolvedThreadId = subagent.resolvedThreadId
                ? ThreadId.makeUnsafe(subagent.resolvedThreadId)
                : null;
              return (
                <div
                  key={`${workEntry.id}:${subagent.threadId}`}
                  className="flex items-start gap-2.5 rounded-lg border border-border/28 bg-background/82 px-[11px] py-2"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      subagent.isActive ? "bg-sky-300/95" : "bg-muted-foreground/22",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-[11px] font-semibold leading-[18px] text-foreground/90"
                      title={presentation.fullLabel}
                    >
                      <span style={{ color: presentation.accentColor }}>
                        {presentation.nickname ?? presentation.primaryLabel}
                      </span>
                      {presentation.role ? (
                        <span className="ml-1 text-[10px] font-medium text-muted-foreground/48">
                          ({presentation.role})
                        </span>
                      ) : null}
                    </div>
                    {secondaryLabel ? (
                      <div className="truncate pt-0.5 text-[10px] leading-4 text-muted-foreground/56" title={secondaryLabel}>
                        {secondaryLabel}
                      </div>
                    ) : null}
                    {subagent.latestUpdate ? (
                      <div className="flex items-baseline gap-1.5 pt-1 text-[9px] text-muted-foreground/42" title={subagent.latestUpdate}>
                        <span className="shrink-0 uppercase tracking-[0.14em] text-muted-foreground/30">
                          Latest
                        </span>
                        <span className="truncate">{subagent.latestUpdate}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {displayStatusLabel ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-[0.08em]",
                          subagentStatusClasses(
                            displayStatusLabel,
                            subagent.rawStatus,
                            subagent.isActive,
                          ),
                        )}
                      >
                        {displayStatusLabel}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={cn(
                        "shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/62 transition-colors",
                        resolvedThreadId && onOpenThread
                          ? "hover:border-foreground/15 hover:text-foreground/84"
                          : "cursor-default opacity-50",
                      )}
                      disabled={!resolvedThreadId || !onOpenThread}
                      onClick={() => {
                        if (resolvedThreadId && onOpenThread) {
                          onOpenThread(resolvedThreadId);
                        }
                      }}
                    >
                      Open thread
                    </button>
                  </div>
                </div>
              );
            })}
            {hiddenSubagentCount > 0 ? (
              <div className="px-1 text-[10px] text-muted-foreground/55">
                +{hiddenSubagentCount} more
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/35 bg-background/35 px-2 py-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn("mt-0.5 flex size-4.5 shrink-0 items-center justify-center", iconConfig.className)}>
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="min-w-0 truncate text-[11px] font-medium leading-4.5 text-foreground/85" title={displayText}>
              {heading}
            </p>
            {kindLabel && (
              <span className="shrink-0 rounded border border-border/50 px-1 py-0.5 text-[9px] leading-none text-muted-foreground/80">
                {kindLabel}
              </span>
            )}
            {hasInvocationDiffStat && workEntry.invocationDiffStat && (
              <span className="shrink-0 rounded border border-border/50 px-1 py-0.5 font-mono text-[9px] leading-none text-muted-foreground/80">
                +{workEntry.invocationDiffStat.additions} -{workEntry.invocationDiffStat.deletions}
              </span>
            )}
            {canExpandInvocationDiff && (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border/50 px-1 py-0.5 text-[9px] leading-none text-muted-foreground/80 transition-colors duration-150 hover:text-foreground/85"
                onClick={onToggleInvocationDiff}
                aria-label={isInvocationDiffExpanded ? "Collapse invocation diff" : "Expand invocation diff"}
              >
                <ChevronRightIcon
                  className={cn("size-2.5 transition-transform duration-150", isInvocationDiffExpanded ? "rotate-90" : "")}
                />
                <span>{isInvocationDiffExpanded ? "Hide diff" : "Show diff"}</span>
              </button>
            )}
          </div>
          {workEntry.command ? (
            <p className="truncate font-mono text-[10px] leading-4 text-muted-foreground/80" title={workEntry.command}>
              {workEntry.command}
            </p>
          ) : null}
          {!workEntry.command && detailPreview && detailPreview !== heading && (
            <p className={cn("truncate text-[10px] leading-4", workToneClass(workEntry.tone))} title={workEntry.detail}>
              {detailPreview}
            </p>
          )}
          {primaryInvocationPath && (
            <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground/75" title={primaryInvocationPath}>
              {primaryInvocationPath}
            </span>
          )}
          {changedFilesLabel && (
            <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground/75" title={changedFilesLabel}>
              {changedFilesLabel}
            </span>
          )}
          {canExpandInvocationDiff && isInvocationDiffExpanded && (
            <div className="mt-1.5 rounded border border-border/55 bg-background/50 p-1.5">
              {invocationDiffFiles.length > 1 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {invocationDiffFiles.map((file) => (
                    <button
                      key={`${workEntry.id}:invocation-diff:${file.path}`}
                      type="button"
                      className={cn(
                        "rounded border px-1 py-0.5 font-mono text-[9px] text-muted-foreground/80 transition-colors duration-150",
                        file.path === activeInvocationDiffPath
                          ? "border-border bg-background/80 text-foreground/90"
                          : "border-border/55 bg-background/50 hover:text-foreground/85",
                      )}
                      onClick={() => onSelectInvocationDiffPath(file.path)}
                    >
                      {file.path}
                    </button>
                  ))}
                </div>
              )}
              {activeInvocationDiff ? (
                <div className="overflow-hidden rounded border border-border/60 bg-background/65">
                  <FileDiff
                    fileDiff={activeInvocationDiff.fileDiff}
                    options={{
                      diffStyle: "unified",
                      lineDiffType: "none",
                      theme: resolveDiffThemeName(resolvedTheme),
                      themeType: resolvedTheme,
                    }}
                  />
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground/70">No invocation diff available for this file.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export const MessagesTimeline = memo(function MessagesTimeline(props: MessagesTimelineProps) {
  const {
    isFocusedPane = true,
    hasMessages,
    isWorking,
    activeTurnInProgress,
    activeTurnStartedAt,
    scrollContainer,
    timelineEntries,
    completionDividerBeforeEntryId,
    completionSummary,
    turnDiffSummaryByAssistantMessageId,
    turnDiffSummaryByTurnId,
    nowIso,
    expandedWorkGroups,
    onToggleWorkGroup,
    onOpenTurnDiff,
    revertTurnCountByUserMessageId,
    onRevertUserMessage,
    isRevertingCheckpoint,
    onImageExpand,
    onOpenThread,
    markdownCwd,
    resolvedTheme,
    workspaceRoot,
    pinnedSelections,
    onAskAboutSelectedText,
    onPinSelectedText,
    onRemovePinnedSelection,
    pendingPinnedSelectionJumpId,
    onPinnedSelectionJumpHandled,
  } = props;
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const [selectionActionState, setSelectionActionState] =
    useState<AssistantSelectionActionState | null>(null);
  const [pinnedSelectionMarkers, setPinnedSelectionMarkers] = useState<PinnedSelectionMarker[]>([]);
  const selectionActionStateRef = useRef<AssistantSelectionActionState | null>(null);
  const selectionActionPointerDownRef = useRef(false);
  const selectionActionFrameRef = useRef<number | null>(null);
  const pinnedSelectionMarkerFrameRef = useRef<number | null>(null);
  const pinnedSelectionMarkerScrollTimeoutRef = useRef<number | null>(null);
  const isTimelineScrollingRef = useRef(false);

  const clearSelectionAction = useCallback(() => {
    selectionActionStateRef.current = null;
    setSelectionActionState(null);
  }, []);

  const hidePinnedSelectionMarkers = useCallback(() => {
    setPinnedSelectionMarkers([]);
  }, []);

  const updatePinnedSelectionMarkers = useCallback(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot || typeof document === "undefined" || isTimelineScrollingRef.current) {
      hidePinnedSelectionMarkers();
      return;
    }

    const nextMarkers = pinnedSelections.flatMap((selection) => {
      const selector = `[${CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE}="${selection.sourceKind}"][${CHAT_SELECTION_SOURCE_ID_ATTRIBUTE}="${selection.sourceId}"]`;
      const region = timelineRoot.querySelector<HTMLElement>(selector);
      if (!region || !region.isConnected) {
        return [];
      }
      const range = reconstructRangeFromOffsets(
        region,
        selection.plainTextStart,
        selection.plainTextEnd,
      );
      if (!range) {
        return [];
      }
      const markerPosition = getPinnedSelectionMarkerPosition(range);
      if (!markerPosition) {
        return [];
      }
      return [
        {
          id: selection.id,
          left: markerPosition.left,
          top: markerPosition.top,
          selectedText: selection.selectedText,
        } satisfies PinnedSelectionMarker,
      ];
    });

    setPinnedSelectionMarkers((previousMarkers) => {
      if (
        previousMarkers.length === nextMarkers.length &&
        previousMarkers.every((marker, index) => {
          const nextMarker = nextMarkers[index];
          return (
            nextMarker &&
            nextMarker.id === marker.id &&
            nextMarker.selectedText === marker.selectedText &&
            Math.abs(nextMarker.left - marker.left) < 0.5 &&
            Math.abs(nextMarker.top - marker.top) < 0.5
          );
        })
      ) {
        return previousMarkers;
      }
      return nextMarkers;
    });
  }, [hidePinnedSelectionMarkers, pinnedSelections]);

  const updateSelectionActionState = useCallback(() => {
    const timelineRoot = timelineRootRef.current;
    if (!isFocusedPane || !timelineRoot || selectionActionPointerDownRef.current) {
      clearSelectionAction();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearSelectionAction();
      return;
    }

    const range = selection.getRangeAt(0);
    const startRegion = getSelectionRegionElement(range.startContainer);
    const endRegion = getSelectionRegionElement(range.endContainer);
    if (!startRegion || startRegion !== endRegion || !startRegion.isConnected) {
      clearSelectionAction();
      return;
    }
    if (!timelineRoot.contains(startRegion) || !timelineRoot.contains(endRegion)) {
      clearSelectionAction();
      return;
    }

    if (
      isIgnoredSelectionTarget(range.startContainer) ||
      isIgnoredSelectionTarget(range.endContainer) ||
      isIgnoredSelectionTarget(range.commonAncestorContainer)
    ) {
      clearSelectionAction();
      return;
    }

    const selectedText = selection.toString();
    const normalizedSelectedText = normalizeSelectedText(selectedText);
    if (!normalizedSelectedText) {
      clearSelectionAction();
      return;
    }

    const sourceKind = getSelectionSourceKind(startRegion);
    const sourceId = getSelectionSourceId(startRegion);
    const serializedRange = serializeRangeWithinContainer(startRegion, range);
    if (!sourceKind || !sourceId || !serializedRange) {
      clearSelectionAction();
      return;
    }

    const anchorRect = getSelectionAnchorRect(range);
    if (!anchorRect) {
      clearSelectionAction();
      return;
    }

    const nextState = {
      selectedText: normalizedSelectedText,
      sourceKind,
      sourceId,
      plainTextStart: serializedRange.plainTextStart,
      plainTextEnd: serializedRange.plainTextEnd,
      ...getSelectionActionPosition(anchorRect),
    };

    const previousState = selectionActionStateRef.current;
    if (
      previousState &&
      previousState.selectedText === nextState.selectedText &&
      Math.abs(previousState.left - nextState.left) < 0.5 &&
      Math.abs(previousState.top - nextState.top) < 0.5 &&
      previousState.sourceKind === nextState.sourceKind &&
      previousState.sourceId === nextState.sourceId &&
      previousState.plainTextStart === nextState.plainTextStart &&
      previousState.plainTextEnd === nextState.plainTextEnd
    ) {
      return;
    }

    selectionActionStateRef.current = nextState;
    setSelectionActionState(nextState);
  }, [clearSelectionAction, isFocusedPane]);

  const scheduleSelectionActionUpdate = useCallback(() => {
    if (selectionActionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionActionFrameRef.current);
    }
    selectionActionFrameRef.current = window.requestAnimationFrame(() => {
      selectionActionFrameRef.current = null;
      updateSelectionActionState();
    });
  }, [updateSelectionActionState]);

  const schedulePinnedSelectionMarkersUpdate = useCallback(() => {
    if (pinnedSelectionMarkerFrameRef.current !== null) {
      window.cancelAnimationFrame(pinnedSelectionMarkerFrameRef.current);
    }
    pinnedSelectionMarkerFrameRef.current = window.requestAnimationFrame(() => {
      pinnedSelectionMarkerFrameRef.current = null;
      updatePinnedSelectionMarkers();
    });
  }, [updatePinnedSelectionMarkers]);

  const schedulePinnedSelectionMarkersAfterScroll = useCallback(() => {
    if (pinnedSelectionMarkerScrollTimeoutRef.current !== null) {
      window.clearTimeout(pinnedSelectionMarkerScrollTimeoutRef.current);
    }
    isTimelineScrollingRef.current = true;
    hidePinnedSelectionMarkers();
    pinnedSelectionMarkerScrollTimeoutRef.current = window.setTimeout(() => {
      pinnedSelectionMarkerScrollTimeoutRef.current = null;
      isTimelineScrollingRef.current = false;
      schedulePinnedSelectionMarkersUpdate();
    }, CHAT_PIN_MARKER_SCROLL_SETTLE_MS);
  }, [hidePinnedSelectionMarkers, schedulePinnedSelectionMarkersUpdate]);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  useEffect(() => {
    const handleSelectionChange = () => {
      scheduleSelectionActionUpdate();
    };
    const handlePointerUp = () => {
      scheduleSelectionActionUpdate();
    };
    const handleResize = () => {
      scheduleSelectionActionUpdate();
      schedulePinnedSelectionMarkersUpdate();
    };
    const handleScroll = () => {
      scheduleSelectionActionUpdate();
      schedulePinnedSelectionMarkersAfterScroll();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-chat-selection-action]")) {
        return;
      }
      selectionActionPointerDownRef.current = false;
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handlePointerUp);
    document.addEventListener("touchend", handlePointerUp);
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handlePointerUp);
      document.removeEventListener("touchend", handlePointerUp);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      if (selectionActionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionActionFrameRef.current);
        selectionActionFrameRef.current = null;
      }
      if (pinnedSelectionMarkerFrameRef.current !== null) {
        window.cancelAnimationFrame(pinnedSelectionMarkerFrameRef.current);
        pinnedSelectionMarkerFrameRef.current = null;
      }
      if (pinnedSelectionMarkerScrollTimeoutRef.current !== null) {
        window.clearTimeout(pinnedSelectionMarkerScrollTimeoutRef.current);
        pinnedSelectionMarkerScrollTimeoutRef.current = null;
      }
    };
  }, [
    schedulePinnedSelectionMarkersAfterScroll,
    schedulePinnedSelectionMarkersUpdate,
    scheduleSelectionActionUpdate,
  ]);

  useEffect(() => {
    if (!isFocusedPane) {
      clearSelectionAction();
      hidePinnedSelectionMarkers();
      return;
    }
    scheduleSelectionActionUpdate();
    schedulePinnedSelectionMarkersUpdate();
  }, [
    clearSelectionAction,
    hidePinnedSelectionMarkers,
    isFocusedPane,
    schedulePinnedSelectionMarkersUpdate,
    scheduleSelectionActionUpdate,
  ]);

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt]);

  useEffect(() => {
    scheduleSelectionActionUpdate();
    schedulePinnedSelectionMarkersUpdate();
  }, [schedulePinnedSelectionMarkersUpdate, scheduleSelectionActionUpdate, timelineEntries]);

  useEffect(() => {
    schedulePinnedSelectionMarkersUpdate();
  }, [pinnedSelections, schedulePinnedSelectionMarkersUpdate]);

  const tailRowsToKeepMounted = useMemo(() => {
    if (rows.length >= HUGE_THREAD_ROW_COUNT) return HUGE_THREAD_UNVIRTUALIZED_TAIL_ROWS;
    if (rows.length >= LARGE_THREAD_ROW_COUNT) return LARGE_THREAD_UNVIRTUALIZED_TAIL_ROWS;
    return ALWAYS_UNVIRTUALIZED_TAIL_ROWS;
  }, [rows.length]);

  const virtualizerOverscan = useMemo(() => {
    if (rows.length >= HUGE_THREAD_ROW_COUNT) return 2;
    if (rows.length >= LARGE_THREAD_ROW_COUNT) return 4;
    return 6;
  }, [rows.length]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - tailRowsToKeepMounted, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows, tailRowsToKeepMounted]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    getItemKey: (index: number) => rows[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") return 112;
      if (row.kind === "proposed-plan") return estimateTimelineProposedPlanHeight(row.proposedPlan);
      if (row.kind === "working") return 40;
      return estimateTimelineMessageHeight(row.message, { timelineWidthPx });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: virtualizerOverscan,
  });

  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);

  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    if (!pendingPinnedSelectionJumpId) {
      return;
    }
    const selection = pinnedSelections.find((entry) => entry.id === pendingPinnedSelectionJumpId);
    if (!selection) {
      onPinnedSelectionJumpHandled(pendingPinnedSelectionJumpId);
      return;
    }

    const rowIndex = rows.findIndex((row) => {
      if (row.kind === "message" && row.message.role === "assistant") {
        return selection.sourceKind === "assistant-message" && row.message.id === selection.sourceId;
      }
      if (row.kind === "proposed-plan") {
        return selection.sourceKind === "proposed-plan" && row.proposedPlan.id === selection.sourceId;
      }
      return false;
    });

    if (rowIndex >= 0) {
      if (rowIndex < virtualizedRowCount) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
      } else {
        const rowElement = timelineRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${selection.sourceId}"], [data-proposed-plan-id="${selection.sourceId}"]`,
        );
        rowElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    let attempts = 0;
    let frame: number | null = null;

    const tryScrollToSelection = () => {
      attempts += 1;
      const selector = `[${CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE}="${selection.sourceKind}"][${CHAT_SELECTION_SOURCE_ID_ATTRIBUTE}="${selection.sourceId}"]`;
      const region = document.querySelector<HTMLElement>(selector);
      const range =
        region &&
        reconstructRangeFromOffsets(region, selection.plainTextStart, selection.plainTextEnd);
      if (range && scrollContainer && scrollRangeIntoContainerView(range, scrollContainer)) {
        onPinnedSelectionJumpHandled(selection.id);
        return;
      }
      if (attempts >= 8) {
        onPinnedSelectionJumpHandled(selection.id);
        return;
      }
      frame = window.requestAnimationFrame(tryScrollToSelection);
    };

    frame = window.requestAnimationFrame(tryScrollToSelection);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [
    scrollContainer,
    onPinnedSelectionJumpHandled,
    pendingPinnedSelectionJumpId,
    pinnedSelections,
    rowVirtualizer,
    rows,
    virtualizedRowCount,
  ]);

  const onSelectionActionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      selectionActionPointerDownRef.current = true;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const clearNativeTextSelection = useCallback(() => {
    selectionActionPointerDownRef.current = false;
    clearSelectionAction();
    window.getSelection()?.removeAllRanges();
  }, [clearSelectionAction]);

  const onSelectionActionQuoteClick = useCallback(() => {
    const selectedText = selectionActionStateRef.current?.selectedText;
    clearNativeTextSelection();
    if (!selectedText) {
      return;
    }
    onAskAboutSelectedText(selectedText);
  }, [clearNativeTextSelection, onAskAboutSelectedText]);

  const onSelectionActionPinClick = useCallback(() => {
    const selection = selectionActionStateRef.current;
    clearNativeTextSelection();
    if (!selection) {
      return;
    }
    onPinSelectedText({
      sourceKind: selection.sourceKind,
      sourceId: selection.sourceId,
      selectedText: selection.selectedText,
      plainTextStart: selection.plainTextStart,
      plainTextEnd: selection.plainTextEnd,
    });
  }, [clearNativeTextSelection, onPinSelectedText]);

  const selectionActionOverlay =
    selectionActionState && typeof document !== "undefined"
      ? createPortal(
          <div className="pointer-events-none fixed inset-0 z-50">
            <div
              className="pointer-events-auto fixed flex h-9 items-center gap-1 rounded-full border border-border/80 bg-card/95 px-1.5 text-foreground shadow-lg/20 backdrop-blur-sm"
              style={{
                left: `${selectionActionState.left}px`,
                top: `${selectionActionState.top}px`,
              }}
            >
              <Button
                aria-label={CHAT_SELECTION_QUOTE_ACTION_LABEL}
                data-chat-selection-action="quote"
                variant="ghost"
                size="icon-xs"
                className="size-7 rounded-full"
                onPointerDown={onSelectionActionPointerDown}
                onClick={onSelectionActionQuoteClick}
              >
                <span aria-hidden="true" className="font-serif text-sm leading-none opacity-80">
                  "
                </span>
              </Button>
              <Button
                aria-label={CHAT_SELECTION_PIN_ACTION_LABEL}
                data-chat-selection-action="pin"
                variant="ghost"
                size="icon-xs"
                className="size-7 rounded-full"
                onPointerDown={onSelectionActionPointerDown}
                onClick={onSelectionActionPinClick}
              >
                <PinIcon className="size-3.5" />
              </Button>
            </div>
          </div>,
          document.body,
        )
      : null;

  const pinnedSelectionMarkersOverlay =
    pinnedSelectionMarkers.length > 0 && typeof document !== "undefined"
      ? createPortal(
          <div className="pointer-events-none fixed inset-0 z-40">
            {pinnedSelectionMarkers.map((marker, index) => (
              <Tooltip key={`pinned-selection-marker:${marker.id}`}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-chat-selection-ignore="true"
                      className="pointer-events-auto fixed inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-card/95 text-[10px] font-medium text-foreground shadow-md/20 backdrop-blur-sm transition-colors hover:bg-card"
                      style={{
                        left: `${marker.left}px`,
                        top: `${marker.top}px`,
                      }}
                      onClick={() => onRemovePinnedSelection(marker.id)}
                      aria-label={`Remove pinned passage ${index + 1}`}
                    >
                      <PinIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                  {marker.selectedText}
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>,
          document.body,
        )
      : null;

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow) => (
    <div
      className="pb-4"
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
      data-proposed-plan-id={row.kind === "proposed-plan" ? row.proposedPlan.id : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
          const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

          return (
            <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
              <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                  {groupLabel} ({groupedEntries.length})
                </p>
                {hasOverflow && (
                  <button
                    type="button"
                    className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                    onClick={() => onToggleWorkGroup(groupId)}
                  >
                    {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    resolvedTheme={resolvedTheme}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group flex min-w-0 max-w-[80%] flex-col items-end">
                <div
                  data-user-message-bubble="true"
                  className="relative w-full rounded-2xl rounded-br-sm border border-border bg-secondary px-3 py-2"
                >
                  {userImages.length > 0 && (
                    <div className="mb-1.5 grid max-w-[420px] grid-cols-2 gap-1.5">
                      {userImages.map(
                        (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                          <div
                            key={image.id}
                            className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(userImages, image.id);
                                  if (!preview) return;
                                  onImageExpand(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full max-h-[220px] w-full object-cover"
                                  onLoad={onTimelineImageLoad}
                                  onError={onTimelineImageLoad}
                                />
                              </button>
                            ) : (
                              <div className="flex min-h-[72px] items-center justify-center px-2 py-2.5 text-center text-[11px] text-muted-foreground/70">
                                {image.name}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {row.message.text && (
                    <UserMessageText
                      text={row.message.text}
                      cwd={markdownCwd}
                      descriptors={props.userMessageMentionDescriptors}
                      onOpenFilePath={props.onOpenFilePath}
                    />
                  )}
                </div>
                <div
                  data-user-message-footer="true"
                  className="mt-1 flex w-full items-center justify-end gap-2 px-1"
                >
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {row.message.text && <MessageCopyButton text={row.message.text} />}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[10px] text-muted-foreground/30">
                    {formatTimestamp(row.message.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {completionSummary ? `Response • ${completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="group min-w-0 px-1 py-0.5">
                <div
                  {...{
                    [CHAT_SELECTION_REGION_ATTRIBUTE]: CHAT_SELECTION_REGION_VALUE,
                    [CHAT_SELECTION_SOURCE_KIND_ATTRIBUTE]: "assistant-message",
                    [CHAT_SELECTION_SOURCE_ID_ATTRIBUTE]: row.message.id,
                  }}
                >
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                    onOpenFilePath={props.onOpenFilePath}
                  />
                </div>
                {(() => {
                  const turnSummary =
                    turnDiffSummaryByAssistantMessageId.get(row.message.id) ??
                    (row.message.turnId
                      ? turnDiffSummaryByTurnId.get(row.message.turnId)
                      : undefined);
                  if (!turnSummary) {
                    const mentionedArtifacts = collectMentionedAssistantArtifacts({
                      text: messageText,
                      existingPaths: new Set(),
                      workspaceRoot,
                      homeDirectory: props.homeDirectory,
                    });
                    return (
                      <AssistantArtifactCards
                        artifacts={mentionedArtifacts}
                        resolvedTheme={resolvedTheme}
                        onOpenFilePath={props.onOpenFilePath}
                      />
                    );
                  }
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) {
                    const mentionedArtifacts = collectMentionedAssistantArtifacts({
                      text: messageText,
                      existingPaths: new Set(),
                      workspaceRoot,
                      homeDirectory: props.homeDirectory,
                    });
                    return (
                      <AssistantArtifactCards
                        artifacts={mentionedArtifacts}
                        resolvedTheme={resolvedTheme}
                        onOpenFilePath={props.onOpenFilePath}
                      />
                    );
                  }
                  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                  const changedFileCountLabel = String(checkpointFiles.length);
                  const checkpointArtifacts = collectAssistantArtifacts(checkpointFiles);
                  const assistantArtifacts = [
                    ...checkpointArtifacts,
                    ...collectMentionedAssistantArtifacts({
                      text: messageText,
                      existingPaths: new Set(checkpointArtifacts.map((artifact) => artifact.path)),
                      workspaceRoot,
                      homeDirectory: props.homeDirectory,
                    }),
                  ];
                  const allDirectoriesExpanded =
                    allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                  return (
                    <>
                      <AssistantArtifactCards
                        artifacts={assistantArtifacts}
                        resolvedTheme={resolvedTheme}
                        onOpenFilePath={props.onOpenFilePath}
                      />
                      <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                            <span>Changed files ({changedFileCountLabel})</span>
                            {hasNonZeroStat(summaryStat) && (
                              <>
                                <span className="mx-1">•</span>
                                <DiffStatLabel
                                  additions={summaryStat.additions}
                                  deletions={summaryStat.deletions}
                                />
                              </>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                            >
                              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                              }
                            >
                              View diff
                            </Button>
                          </div>
                        </div>
                        <ChangedFilesTree
                          key={`changed-files-tree:${turnSummary.turnId}`}
                          turnId={turnSummary.turnId}
                          files={checkpointFiles}
                          allDirectoriesExpanded={allDirectoriesExpanded}
                          resolvedTheme={resolvedTheme}
                          onOpenTurnDiff={onOpenTurnDiff}
                        />
                      </div>
                    </>
                  );
                })()}
                <div
                  data-assistant-message-footer="true"
                  className="mt-1.5 flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {row.message.text && <MessageCopyButton text={row.message.text} />}
                  </div>
                  <p className="text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.message.createdAt, nowIso)
                        : formatElapsed(row.message.createdAt, row.message.completedAt),
                    )}
                  </p>
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            sourceId={row.proposedPlan.id}
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="flex items-center gap-2 py-0.5 pl-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="flex items-center pt-1">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
          </div>
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{
                  contain: "layout paint style",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`} style={{ contain: "layout paint style" }}>
          {renderRowContent(row)}
        </div>
      ))}
      {selectionActionOverlay}
      {pinnedSelectionMarkersOverlay}
    </div>
  );
});
