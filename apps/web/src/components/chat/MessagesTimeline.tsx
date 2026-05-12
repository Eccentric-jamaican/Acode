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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parsePatchFiles } from "@pierre/diffs";
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
import { type TurnDiffFileChange, type TurnDiffSummary } from "../../types";
import { buildPatchCacheKey, resolveDiffThemeName } from "../../lib/diffRendering";
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
  buildProposedPlanWorkspacePath,
  findWorkspacePlansDirectories,
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
import { projectQueryKeys, projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { OpenAI } from "../Icons";
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
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
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
const INLINE_EDIT_DIFF_MAX_CHANGED_LINES = 300;
const INLINE_EDIT_DIFF_MAX_CONTENT_CHARS = 120_000;
const LEADING_PROVIDER_MENTION_PATTERN = /^([$/])([^\s]+)(?=\s|$)/;

type AssistantArtifactKind = "document" | "image" | "markdown" | "slides" | "spreadsheet" | "pdf";

const ASSISTANT_ARTIFACT_EXTENSIONS: ReadonlyMap<string, AssistantArtifactKind> = new Map([
  ["avif", "image"],
  ["bmp", "image"],
  ["docx", "document"],
  ["gif", "image"],
  ["heic", "image"],
  ["jpeg", "image"],
  ["jpg", "image"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mdown", "markdown"],
  ["mdx", "markdown"],
  ["mkd", "markdown"],
  ["png", "image"],
  ["pptx", "slides"],
  ["webp", "image"],
  ["xls", "spreadsheet"],
  ["xlsx", "spreadsheet"],
  ["pdf", "pdf"],
]);

export interface MessagesTimelineProps {
  isFocusedPane?: boolean;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  threadId: ThreadId;
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
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  homeDirectory: string | undefined;
  pinnedSelections: readonly PinnedSelectionDraft[];
  onAskAboutSelectedText: (selectedText: string) => void;
  onPinSelectedText: (selection: Omit<PinnedSelectionDraft, "id" | "createdAt">) => void;
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
  return model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
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
  | {
      type: "shortcut";
      key: string;
      command: "browser" | "review" | "subagents" | "inspect";
      args: string;
    }
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
    const descriptor = descriptorsByName.get(rawName.toLowerCase()) ?? {
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
          <UserMessageMentionChip key={segment.key} descriptor={segment.descriptor} />
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

function getSelectionSourceKind(element: HTMLElement): PinnedSelectionDraft["sourceKind"] | null {
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

function humanizeToolName(value: string): string {
  const compact = value.trim();
  if (!compact) return "Tool";
  return compact
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => capitalizePhrase(part.toLowerCase()))
    .join(" ");
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (isCommandWorkEntry(workEntry)) {
    return isActiveWorkEntry(workEntry) ? "Running" : "Ran command";
  }
  if (isFileReadWorkEntry(workEntry)) {
    return "Read";
  }
  const toolName = workEntryToolName(workEntry);
  if (toolName) {
    return humanizeToolName(toolName);
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function workEntryKindLabel(workEntry: TimelineWorkEntry): string | null {
  if (workEntry.requestKind === "command") return "Approval";
  if (workEntry.requestKind === "file-read") return null;
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
      return null;
    case "collab_agent_tool_call":
      return "Agent";
    default:
      return workEntry.tone === "tool" ? "Tool" : null;
  }
}

function isCommandWorkEntry(workEntry: WorkLogEntry): boolean {
  return workEntry.itemType === "command_execution" || Boolean(workEntry.command);
}

function isEditWorkEntry(workEntry: WorkLogEntry): boolean {
  return (
    workEntry.itemType === "file_change" ||
    (workEntry.changedFiles?.length ?? 0) > 0 ||
    (workEntry.invocationDiffFiles?.length ?? 0) > 0
  );
}

function isWebSearchWorkEntry(workEntry: WorkLogEntry): boolean {
  return workEntry.itemType === "web_search";
}

function isActiveWorkEntry(workEntry: WorkLogEntry): boolean {
  const payload =
    workEntry.payload && typeof workEntry.payload === "object"
      ? (workEntry.payload as Record<string, unknown>)
      : null;
  if (payload?.status === "inProgress" || payload?.status === "running") {
    return true;
  }
  const text = `${workEntry.label} ${workEntry.toolTitle ?? ""}`.toLowerCase();
  return (
    text.includes("started") ||
    text.includes("starting") ||
    text.includes("running") ||
    text.includes("editing") ||
    text.includes("in progress")
  );
}

function truncateWorkLabel(value: string, maxLength = 72): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function basenameOfWorkPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) return segment;
  }
  return normalized;
}

function workLogRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function workLogString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function workEntryDataRecord(workEntry: WorkLogEntry): Record<string, unknown> | null {
  return workLogRecord(workLogRecord(workEntry.payload)?.data);
}

function workEntryInputRecord(workEntry: WorkLogEntry): Record<string, unknown> | null {
  const payload = workLogRecord(workEntry.payload);
  const data = workEntryDataRecord(workEntry);
  return workLogRecord(data?.input) ?? workLogRecord(payload?.args);
}

function workEntryToolName(workEntry: WorkLogEntry): string | null {
  const payload = workLogRecord(workEntry.payload);
  const data = workEntryDataRecord(workEntry);
  return (
    workLogString(data?.toolName) ??
    workLogString(data?.name) ??
    workLogString(payload?.toolName)
  );
}

function inputStringForKeys(
  input: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = workLogString(input[key]);
    if (value) return value;
  }
  return null;
}

function isFileReadWorkEntry(workEntry: WorkLogEntry): boolean {
  return workEntry.requestKind === "file-read";
}

function workEntryInputPath(workEntry: WorkLogEntry): string | null {
  return inputStringForKeys(workEntryInputRecord(workEntry), [
    "filePath",
    "path",
    "relativePath",
    "filename",
  ]);
}

function workEntryStatusLabel(workEntry: WorkLogEntry): string {
  if (isActiveWorkEntry(workEntry) && isWebSearchWorkEntry(workEntry)) return "Searching";
  if (isActiveWorkEntry(workEntry)) return isEditWorkEntry(workEntry) ? "Editing" : "Running";
  return workEntry.tone === "error" ? "Failed" : "Success";
}

function workEntryStatusClass(workEntry: WorkLogEntry): string {
  if (isActiveWorkEntry(workEntry)) return "text-info-foreground";
  return workEntry.tone === "error" ? "text-destructive/90" : "text-muted-foreground/80";
}

function unwrapShellLauncherCommand(command: string): string {
  const trimmed = command.trim();
  const commandMatch =
    trimmed.match(/\s-(?:Command|c)\s+'([\s\S]*)'$/i) ??
    trimmed.match(/\s-(?:Command|c)\s+"([\s\S]*)"$/i);
  const unwrapped = commandMatch?.[1]?.trim();
  return unwrapped && unwrapped.length > 0 ? unwrapped : trimmed;
}

function commandPreview(command: string): string {
  const trimmed = unwrapShellLauncherCommand(command);
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 177).trimEnd()}...`;
}

function workEntryPreview(workEntry: WorkLogEntry): string | null {
  if (isWebSearchWorkEntry(workEntry)) {
    return (
      workEntry.webSearchQueries?.[0] ??
      workEntry.webSearchUrls?.[0] ??
      workEntry.detail?.split(/\r?\n/, 1)[0]?.trim() ??
      null
    );
  }
  if (workEntry.command) {
    return commandPreview(workEntry.command);
  }
  if (isFileReadWorkEntry(workEntry)) {
    return workEntryInputPath(workEntry) ?? workEntry.label;
  }
  const file = workEntry.invocationDiffFiles?.[0]?.path ?? workEntry.changedFiles?.[0] ?? null;
  if (file) {
    return file;
  }
  const toolInputPreview = inputStringForKeys(workEntryInputRecord(workEntry), [
    "description",
    "pattern",
    "query",
    "path",
    "filePath",
    "prompt",
  ]);
  if (toolInputPreview) {
    return toolInputPreview;
  }
  if (workEntry.detail) {
    return workEntry.detail.split(/\r?\n/, 1)[0]?.trim() ?? null;
  }
  return null;
}

function primaryEditPath(workEntry: WorkLogEntry): string | null {
  return workEntry.invocationDiffFiles?.[0]?.path ?? workEntry.changedFiles?.[0] ?? null;
}

function normalizeWorkPathForCompare(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function normalizeFileDiffPathForWorkLog(fileDiff: { name?: string; prevName?: string }): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

function editStatForEntry(
  workEntry: WorkLogEntry,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
): { additions: number; deletions: number } | null {
  if (workEntry.invocationDiffStat && hasNonZeroStat(workEntry.invocationDiffStat)) {
    return workEntry.invocationDiffStat;
  }
  const path = primaryEditPath(workEntry);
  if (!path || !workEntry.turnId) {
    return null;
  }
  const summary = turnDiffSummaryByTurnId.get(workEntry.turnId);
  const file = findTurnDiffFileForPath(summary, path);
  if (!file) {
    return null;
  }
  return {
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };
}

function invocationDiffContentCharCount(workEntry: WorkLogEntry): number {
  let count = 0;
  for (const file of workEntry.invocationDiffFiles ?? []) {
    count += file.patch?.length ?? 0;
    count += file.before?.length ?? 0;
    count += file.after?.length ?? 0;
  }
  return count;
}

function inlineEditDiffBlockReason(
  workEntry: WorkLogEntry,
  editStat: { additions: number; deletions: number } | null,
): string | null {
  const changedLineCount = editStat ? editStat.additions + editStat.deletions : 0;
  if (changedLineCount > INLINE_EDIT_DIFF_MAX_CHANGED_LINES) {
    return `This diff has ${changedLineCount.toLocaleString()} changed lines.`;
  }
  const contentCharCount = invocationDiffContentCharCount(workEntry);
  if (contentCharCount > INLINE_EDIT_DIFF_MAX_CONTENT_CHARS) {
    return "This diff is too large to render inline.";
  }
  return null;
}

function findTurnDiffFileForPath(
  summary: TurnDiffSummary | undefined,
  path: string,
): TurnDiffFileChange | null {
  const normalizedPath = normalizeWorkPathForCompare(path);
  const basename = basenameOfWorkPath(path).toLowerCase();
  return (
    summary?.files.find((candidate) => {
      const candidatePath = normalizeWorkPathForCompare(candidate.path);
      return (
        candidatePath === normalizedPath ||
        basenameOfWorkPath(candidate.path).toLowerCase() === basename
      );
    }) ?? null
  );
}

type WebSearchDisplayItem = {
  id: string;
  text: string;
  kind: "query" | "url" | "detail";
};

function webSearchDisplayItemsForEntry(workEntry: WorkLogEntry): WebSearchDisplayItem[] {
  const items: WebSearchDisplayItem[] = [];
  const seen = new Set<string>();
  const pushItem = (kind: WebSearchDisplayItem["kind"], text: string | null | undefined) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const key = `${kind}:${trimmed.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id: `${workEntry.id}:${kind}:${items.length}`, kind, text: trimmed });
  };

  for (const query of workEntry.webSearchQueries ?? []) {
    pushItem("query", query);
  }
  for (const url of workEntry.webSearchUrls ?? []) {
    pushItem("url", url);
  }
  if (items.length === 0) {
    pushItem("detail", workEntry.detail ?? workEntry.label);
  }
  return items;
}

function webSearchDisplayItemsForEntries(
  entries: ReadonlyArray<WorkLogEntry>,
): WebSearchDisplayItem[] {
  const items: WebSearchDisplayItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const item of webSearchDisplayItemsForEntry(entry)) {
      const key = `${item.kind}:${item.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, id: `web-search:${items.length}:${item.id}` });
    }
  }
  return items;
}

function workGroupSummary(entries: ReadonlyArray<WorkLogEntry>, fallbackLabel: string): string {
  if (entries.length === 0) {
    return fallbackLabel;
  }
  if (entries.every(isWebSearchWorkEntry)) {
    const items = webSearchDisplayItemsForEntries(entries);
    const firstSearch = items.find((item) => item.kind === "query") ?? items[0];
    if (entries.some(isActiveWorkEntry)) {
      return `Searching the web${firstSearch ? ` for ${truncateWorkLabel(firstSearch.text, 42)}` : ""}`;
    }
    const count = Math.max(items.length, entries.length);
    return `Searched web ${count} ${count === 1 ? "time" : "times"}`;
  }
  if (entries.every(isCommandWorkEntry)) {
    return `Ran ${entries.length} ${entries.length === 1 ? "command" : "commands"}`;
  }
  if (entries.every(isFileReadWorkEntry)) {
    return `Read ${entries.length} ${entries.length === 1 ? "file" : "files"}`;
  }
  if (entries.every(isEditWorkEntry)) {
    const completedFiles = new Set<string>();
    const activeFiles = new Set<string>();
    for (const entry of entries) {
      const target = isActiveWorkEntry(entry) ? activeFiles : completedFiles;
      for (const file of entry.invocationDiffFiles ?? []) {
        target.add(file.path);
      }
      for (const file of entry.changedFiles ?? []) {
        target.add(file);
      }
    }
    const parts: string[] = [];
    if (completedFiles.size > 0) {
      parts.push(completedFiles.size === 1 ? "Edited file" : `Edited ${completedFiles.size} files`);
    }
    if (activeFiles.size > 0) {
      parts.push(activeFiles.size === 1 ? "editing file" : `editing ${activeFiles.size} files`);
    }
    if (parts.length > 0) {
      return parts.join(", ");
    }
    return `Edited ${entries.length} ${entries.length === 1 ? "file" : "files"}`;
  }
  if (fallbackLabel === "Tool calls") {
    return `Used ${entries.length} ${entries.length === 1 ? "tool" : "tools"}`;
  }
  return `${fallbackLabel} (${entries.length})`;
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
    case "image":
      return "Image";
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

function generatedImagePreviewSrc(input: {
  contentsBase64: string | undefined;
  mimeType: string | undefined;
}): string | null {
  if (!input.contentsBase64 || !input.mimeType?.startsWith("image/")) {
    return null;
  }
  return `data:${input.mimeType};base64,${input.contentsBase64}`;
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
    /(?:^|[\s`"'(])((?:[A-Za-z]:\/)?(?:[\w .@()[\]-]+\/)*[\w .@()[\]-]+\.(?:avif|bmp|gif|heic|jpe?g|png|webp|markdown|mdown|mdx?|mkd|docx|pptx|xlsx|xls|pdf))(?=$|[\s`"',).])/gi;

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
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
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
  const [plansDirectoryChoices, setPlansDirectoryChoices] = useState<ReadonlyArray<string>>([]);
  const [isPlansDirectoryDialogOpen, setIsPlansDirectoryDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [isAddingToPlansDirectory, setIsAddingToPlansDirectory] = useState(false);
  const queryClient = useQueryClient();
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadTextFile(downloadFilename, saveContents);
  };

  const invalidateWorkspaceEntries = () => {
    if (!workspaceRoot) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listTree(workspaceRoot),
    });
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listDirectory(workspaceRoot, null),
    });
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
        invalidateWorkspaceEntries();
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

  const saveToPlansDirectory = async (directoryPath: string, createDirectory: boolean) => {
    const api = readNativeApi();
    if (!api || !workspaceRoot) {
      return;
    }
    const relativePath = buildProposedPlanWorkspacePath({
      directoryPath,
      planMarkdown,
    });
    setIsAddingToPlansDirectory(true);
    try {
      if (createDirectory) {
        await api.projects.createDirectory({
          cwd: workspaceRoot,
          relativePath: directoryPath,
        });
      }
      const result = await api.projects.writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      });
      setIsPlansDirectoryDialogOpen(false);
      setPlansDirectoryChoices([]);
      invalidateWorkspaceEntries();
      toastManager.add({
        type: "success",
        title: "Plan added to plans directory",
        description: result.relativePath,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add plan",
        description: error instanceof Error ? error.message : "An error occurred while saving.",
      });
    } finally {
      setIsAddingToPlansDirectory(false);
    }
  };

  const addToPlansDirectory = () => {
    const api = readNativeApi();
    if (!api || !workspaceRoot) {
      toastManager.add({
        type: "error",
        title: "Workspace path is unavailable",
        description: "This thread does not have a workspace path to save into.",
      });
      return;
    }

    setIsAddingToPlansDirectory(true);
    void (async () => {
      try {
        const tree = await api.projects.listTree({ cwd: workspaceRoot });
        const plansDirectories = findWorkspacePlansDirectories(tree.entries);
        if (plansDirectories.length > 1) {
          setPlansDirectoryChoices(plansDirectories);
          setIsPlansDirectoryDialogOpen(true);
          return;
        }
        const [existingPlansDirectory] = plansDirectories;
        await saveToPlansDirectory(existingPlansDirectory ?? "plans", !existingPlansDirectory);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not inspect workspace",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while looking for plans directories.",
        });
      } finally {
        setIsAddingToPlansDirectory(false);
      }
    })();
  };

  return (
    <div className="rounded-[20px] border border-border/55 bg-card/55 p-4 shadow-sm shadow-black/5 sm:p-5">
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
            <MenuItem
              onClick={addToPlansDirectory}
              disabled={!workspaceRoot || isAddingToPlansDirectory}
            >
              Add to plans directory
            </MenuItem>
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
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 rounded-b-[18px] bg-linear-to-t from-card/85 via-card/55 to-transparent" />
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

      <Dialog
        open={isPlansDirectoryDialogOpen}
        onOpenChange={(open) => {
          if (!isAddingToPlansDirectory) {
            setIsPlansDirectoryDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a plans directory</DialogTitle>
            <DialogDescription>
              This workspace has more than one <code>plans</code> directory.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            {plansDirectoryChoices.map((directoryPath) => (
              <button
                key={directoryPath}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50"
                disabled={isAddingToPlansDirectory}
                onClick={() => void saveToPlansDirectory(directoryPath, false)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{directoryPath}</span>
              </button>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPlansDirectoryDialogOpen(false)}
              disabled={isAddingToPlansDirectory}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

const WorkLogGroup = memo(function WorkLogGroup(props: {
  groupId: string;
  groupedEntries: ReadonlyArray<WorkLogEntry>;
  visibleEntries: ReadonlyArray<WorkLogEntry>;
  hiddenCount: number;
  hasOverflow: boolean;
  isExpanded: boolean;
  groupLabel: string;
  resolvedTheme: "light" | "dark";
  threadId: ThreadId;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageLoad: () => void;
  homeDirectory: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [isGroupCollapsed, setIsGroupCollapsed] = useState(() =>
    props.groupedEntries.every(isEditWorkEntry),
  );
  const summary = workGroupSummary(props.groupedEntries, props.groupLabel);
  const isWebSearchGroup = props.groupedEntries.every(isWebSearchWorkEntry);
  const singleEditEntry =
    props.visibleEntries.length === 1 && isEditWorkEntry(props.visibleEntries[0] as WorkLogEntry);
  const singleEditWorkEntry = singleEditEntry ? (props.visibleEntries[0] as WorkLogEntry) : null;
  const singleEditTurnSummary = singleEditWorkEntry?.turnId
    ? props.turnDiffSummaryByTurnId.get(singleEditWorkEntry.turnId)
    : undefined;
  const singleEditCheckpointTurnCount =
    typeof singleEditTurnSummary?.checkpointTurnCount === "number"
      ? singleEditTurnSummary.checkpointTurnCount
      : null;
  const singleEditStat = singleEditWorkEntry
    ? editStatForEntry(singleEditWorkEntry, props.turnDiffSummaryByTurnId)
    : null;
  const singleEditInlineBlockReason = singleEditWorkEntry
    ? inlineEditDiffBlockReason(singleEditWorkEntry, singleEditStat)
    : null;
  useQuery(
    checkpointDiffQueryOptions({
      threadId: props.threadId,
      fromTurnCount:
        singleEditCheckpointTurnCount !== null
          ? Math.max(0, singleEditCheckpointTurnCount - 1)
          : null,
      toTurnCount: singleEditCheckpointTurnCount,
      cacheScope: singleEditWorkEntry ? `work-log:${singleEditWorkEntry.id}` : null,
      enabled:
        singleEditWorkEntry !== null &&
        singleEditInlineBlockReason === null &&
        (singleEditWorkEntry.invocationDiffFiles?.length ?? 0) === 0 &&
        singleEditCheckpointTurnCount !== null,
    }),
  );
  const SummaryIcon = props.groupedEntries.every(isEditWorkEntry)
    ? SquarePenIcon
    : isWebSearchGroup
      ? GlobeIcon
      : props.groupedEntries.every(isCommandWorkEntry)
        ? TerminalIcon
        : props.groupedEntries.every(isFileReadWorkEntry)
          ? EyeIcon
          : WrenchIcon;

  useEffect(() => {
    if (!expandedEntryId) return;
    if (!props.visibleEntries.some((entry) => entry.id === expandedEntryId)) {
      setExpandedEntryId(null);
    }
  }, [expandedEntryId, props.visibleEntries]);

  return (
    <div className="max-w-full space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground/78">
        <button
          type="button"
          className="group inline-flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/35 hover:text-foreground/88"
          onClick={() => {
            setIsGroupCollapsed((current) => !current);
            setExpandedEntryId(null);
          }}
          aria-expanded={!isGroupCollapsed}
        >
          <SummaryIcon className="size-3.5 shrink-0" />
          {singleEditWorkEntry && !isGroupCollapsed ? (
            <span className="truncate text-sm">Edited file</span>
          ) : singleEditWorkEntry ? (
            <>
              <span className="shrink-0 text-sm font-medium text-foreground/86">
                {isActiveWorkEntry(singleEditWorkEntry) ? "Editing" : "Edited"}
              </span>
              {primaryEditPath(singleEditWorkEntry) ? (
                <span
                  className="min-w-0 truncate text-sm text-info-foreground"
                  title={primaryEditPath(singleEditWorkEntry) ?? undefined}
                >
                  {basenameOfWorkPath(primaryEditPath(singleEditWorkEntry) ?? "")}
                </span>
              ) : null}
              {(() => {
                const editStat = editStatForEntry(
                  singleEditWorkEntry,
                  props.turnDiffSummaryByTurnId,
                );
                return editStat && hasNonZeroStat(editStat) ? (
                  <span className="shrink-0 font-mono text-xs transition-colors duration-300">
                    <span className="text-emerald-400">+{editStat.additions}</span>
                    <span className="ml-1 text-red-400">-{editStat.deletions}</span>
                  </span>
                ) : null;
              })()}
            </>
          ) : (
            <span className="truncate text-sm">{summary}</span>
          )}
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 transition-transform duration-150",
              !isGroupCollapsed ? "rotate-90" : "",
            )}
          />
        </button>
        {props.hasOverflow ? (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground/55 transition-colors hover:bg-accent/30 hover:text-foreground/75"
            onClick={() => props.onToggleWorkGroup(props.groupId)}
          >
            {props.isExpanded ? "Show less" : `Show ${props.hiddenCount} more`}
          </button>
        ) : null}
      </div>
      {!isGroupCollapsed ? (
        <div className="space-y-1 pl-0.5">
          {singleEditWorkEntry ? (
            <WorkLogEntryDetail
              workEntry={singleEditWorkEntry}
              resolvedTheme={props.resolvedTheme}
              threadId={props.threadId}
              turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
              onOpenThread={props.onOpenThread}
              onOpenFilePath={props.onOpenFilePath}
              onOpenTurnDiff={props.onOpenTurnDiff}
              onImageExpand={props.onImageExpand}
              onImageLoad={props.onImageLoad}
              homeDirectory={props.homeDirectory}
              workspaceRoot={props.workspaceRoot}
            />
          ) : isWebSearchGroup ? (
            <WebSearchWorkLogRows entries={props.visibleEntries} />
          ) : (
            props.visibleEntries.map((workEntry) => {
              const isEntryExpanded = workEntry.id === expandedEntryId;
              return (
                <div key={`work-line:${workEntry.id}`} className="space-y-1">
                  <WorkLogEntryLine
                    workEntry={workEntry}
                    active={isEntryExpanded}
                    turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
                    onToggle={() => {
                      setExpandedEntryId((current) =>
                        current === workEntry.id ? null : workEntry.id,
                      );
                    }}
                  />
                  {isEntryExpanded ? (
                    <WorkLogEntryDetail
                      workEntry={workEntry}
                      resolvedTheme={props.resolvedTheme}
                      threadId={props.threadId}
                      turnDiffSummaryByTurnId={props.turnDiffSummaryByTurnId}
                      onOpenThread={props.onOpenThread}
                      onOpenFilePath={props.onOpenFilePath}
                      onOpenTurnDiff={props.onOpenTurnDiff}
                      onImageExpand={props.onImageExpand}
                      onImageLoad={props.onImageLoad}
                      homeDirectory={props.homeDirectory}
                      workspaceRoot={props.workspaceRoot}
                    />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});

const WebSearchWorkLogRows = memo(function WebSearchWorkLogRows(props: {
  entries: ReadonlyArray<WorkLogEntry>;
}) {
  const items = webSearchDisplayItemsForEntries(props.entries);
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-muted-foreground/72"
        >
          <OpenAI className="size-3.5 shrink-0 text-muted-foreground/78" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm" title={item.text}>
            {item.text}
          </span>
        </div>
      ))}
    </div>
  );
});

const WorkLogEntryLine = memo(function WorkLogEntryLine(props: {
  workEntry: WorkLogEntry;
  active: boolean;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  onToggle: () => void;
}) {
  const EntryIcon = workEntryIcon(props.workEntry);
  const heading = toolWorkEntryHeading(props.workEntry);
  const preview = workEntryPreview(props.workEntry);
  const kindLabel = workEntryKindLabel(props.workEntry);
  const isEditing = isEditWorkEntry(props.workEntry) && isActiveWorkEntry(props.workEntry);
  const isEdit = isEditWorkEntry(props.workEntry);
  const editPath = isEdit ? primaryEditPath(props.workEntry) : null;
  const canExpandEdit =
    isEdit &&
    ((props.workEntry.invocationDiffFiles?.length ?? 0) > 0 ||
      Boolean(editPath && props.workEntry.turnId));
  const editStat = isEdit ? editStatForEntry(props.workEntry, props.turnDiffSummaryByTurnId) : null;
  const hasStat = isEdit
    ? Boolean(editStat && hasNonZeroStat(editStat))
    : props.workEntry.invocationDiffStat && hasNonZeroStat(props.workEntry.invocationDiffStat);

  return (
    <button
      type="button"
      disabled={isEdit && !canExpandEdit}
      className={cn(
        "group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
        props.active
          ? "bg-accent/35 text-foreground"
          : "text-muted-foreground/72 enabled:hover:bg-accent/25 enabled:hover:text-foreground/88",
        isEdit && !canExpandEdit ? "cursor-default" : "",
      )}
      onClick={props.onToggle}
    >
      <EntryIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 shrink-0 text-sm font-medium text-foreground/86">
        {isEdit && editPath ? (isEditing ? "Editing" : "Edited") : heading}
      </span>
      {kindLabel && !isEdit && !isCommandWorkEntry(props.workEntry) ? (
        <span className="shrink-0 rounded border border-border/45 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground/55">
          {kindLabel}
        </span>
      ) : null}
      {editPath ? (
        <span
          className="min-w-0 truncate text-sm text-info-foreground"
          title={editPath}
        >
          {basenameOfWorkPath(editPath)}
        </span>
      ) : preview ? (
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            isEditing ? "shrink-0 text-info-foreground" : "flex-1 text-muted-foreground/62",
          )}
          title={preview}
        >
          {isEditing ? basenameOfWorkPath(preview) : preview}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {hasStat && (isEdit ? editStat : props.workEntry.invocationDiffStat) ? (
        <span className="shrink-0 font-mono text-xs transition-colors duration-300">
          <span className="text-emerald-400">
            +{(isEdit ? editStat : props.workEntry.invocationDiffStat)?.additions ?? 0}
          </span>
          <span className="ml-1 text-red-400">
            -{(isEdit ? editStat : props.workEntry.invocationDiffStat)?.deletions ?? 0}
          </span>
        </span>
      ) : null}
      {!isEdit || canExpandEdit ? (
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-hover:text-foreground/65",
            props.active ? "rotate-90" : "",
          )}
        />
      ) : null}
    </button>
  );
});

const WorkLogEntryDetail = memo(function WorkLogEntryDetail(props: {
  workEntry: WorkLogEntry;
  resolvedTheme: "light" | "dark";
  threadId: ThreadId;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageLoad: () => void;
  homeDirectory: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const workEntry = props.workEntry;
  const invocationDiffFiles = workEntry.invocationDiffFiles ?? EMPTY_INVOCATION_DIFF_FILES;
  const turnSummary = workEntry.turnId
    ? props.turnDiffSummaryByTurnId.get(workEntry.turnId)
    : undefined;
  const checkpointTurnCount =
    typeof turnSummary?.checkpointTurnCount === "number" ? turnSummary.checkpointTurnCount : null;
  const editStat = isEditWorkEntry(workEntry)
    ? editStatForEntry(workEntry, props.turnDiffSummaryByTurnId)
    : null;
  const inlineDiffBlockReason = isEditWorkEntry(workEntry)
    ? inlineEditDiffBlockReason(workEntry, editStat)
    : null;
  const checkpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: props.threadId,
      fromTurnCount:
        checkpointTurnCount !== null ? Math.max(0, checkpointTurnCount - 1) : null,
      toTurnCount: checkpointTurnCount,
      cacheScope: `work-log:${workEntry.id}`,
      enabled:
        isEditWorkEntry(workEntry) &&
        inlineDiffBlockReason === null &&
        invocationDiffFiles.length === 0 &&
        checkpointTurnCount !== null,
    }),
  );
  const renderableDiffFiles = useMemo<RenderableInvocationDiffFile[]>(() => {
    if (inlineDiffBlockReason !== null) {
      return [];
    }
    const invocationFiles = invocationDiffFiles
      .map((file) => toRenderableInvocationDiffFile(file, `work-detail:${workEntry.id}:${file.path}`))
      .filter((file): file is RenderableInvocationDiffFile => file !== null);
    if (invocationFiles.length > 0) {
      return invocationFiles;
    }
    const patch = checkpointDiffQuery.data?.diff ?? "";
    if (!patch.trim()) {
      return [];
    }
    return parsePatchFiles(patch, buildPatchCacheKey(patch, `work-log:${workEntry.id}`))
      .flatMap((parsedPatch) => parsedPatch.files)
      .map((fileDiff) => {
        const path = normalizeFileDiffPathForWorkLog(fileDiff);
        const summaryFile = findTurnDiffFileForPath(turnSummary, path);
        return {
          path,
          additions: summaryFile?.additions ?? 0,
          deletions: summaryFile?.deletions ?? 0,
          fileDiff,
        } satisfies RenderableInvocationDiffFile;
      })
      .filter((file) => {
        const editPath = primaryEditPath(workEntry);
        if (!editPath) {
          return true;
        }
        const normalizedFilePath = normalizeWorkPathForCompare(file.path);
        const normalizedEditPath = normalizeWorkPathForCompare(editPath);
        return (
          normalizedFilePath === normalizedEditPath ||
          basenameOfWorkPath(file.path).toLowerCase() ===
            basenameOfWorkPath(editPath).toLowerCase()
        );
      });
  }, [
    checkpointDiffQuery.data?.diff,
    inlineDiffBlockReason,
    invocationDiffFiles,
    turnSummary,
    workEntry,
  ]);
  const [activeDiffPath, setActiveDiffPath] = useState<string | null>(
    invocationDiffFiles[0]?.path ?? null,
  );
  const activeDiffFile = activeDiffPath
    ? renderableDiffFiles.find((file) => file.path === activeDiffPath)
    : null;
  const activeDiff = activeDiffFile ?? null;
  const commandOutput =
    workEntry.detail &&
    workEntry.detail.trim() !== workEntry.command?.trim() &&
    workEntry.detail.trim() !== unwrapShellLauncherCommand(workEntry.command ?? "")
      ? workEntry.detail.trim()
      : null;
  const shellCommand = workEntry.command ? unwrapShellLauncherCommand(workEntry.command) : null;
  const changedFiles = [
    ...new Map(
      [
        ...renderableDiffFiles.map((file) => [file.path, file] as const),
        ...(workEntry.changedFiles ?? []).map(
          (path) =>
            [
              path,
              { path, additions: 0, deletions: 0 } satisfies InvocationDiffFile,
            ] as const,
        ),
      ].map(([path, file]) => [path, file] as const),
    ).values(),
  ];

  useEffect(() => {
    const nextPath = renderableDiffFiles[0]?.path ?? null;
    if (!activeDiffPath || !renderableDiffFiles.some((file) => file.path === activeDiffPath)) {
      setActiveDiffPath(nextPath);
    }
  }, [activeDiffPath, renderableDiffFiles]);

  if ((workEntry.subagents?.length ?? 0) > 0 || (workEntry.generatedImages?.length ?? 0) > 0) {
    return (
      <SimpleWorkEntryRow
        workEntry={workEntry}
        resolvedTheme={props.resolvedTheme}
        onOpenThread={props.onOpenThread}
        onOpenFilePath={props.onOpenFilePath}
        onImageExpand={props.onImageExpand}
        onImageLoad={props.onImageLoad}
        homeDirectory={props.homeDirectory}
        workspaceRoot={props.workspaceRoot}
      />
    );
  }

  if (isEditWorkEntry(workEntry)) {
    const editPath = activeDiffFile?.path ?? primaryEditPath(workEntry);
    if (inlineDiffBlockReason) {
      const canOpenDiff = Boolean(workEntry.turnId && editPath);
      return (
        <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground/78">
              Large diff hidden in chat. {inlineDiffBlockReason}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canOpenDiff}
              onClick={() => {
                if (workEntry.turnId) {
                  props.onOpenTurnDiff(workEntry.turnId, editPath ?? undefined);
                }
              }}
            >
              Open diff
            </Button>
          </div>
        </div>
      );
    }
    if (activeDiff) {
      return (
        <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
          <div className="flex min-w-0 items-center gap-2 border-b border-border/45 bg-card/45 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground/88">
              {editPath ? basenameOfWorkPath(editPath) : "Edited file"}
            </span>
            {editStat && hasNonZeroStat(editStat) ? (
              <span className="shrink-0 font-mono text-xs">
                <span className="text-emerald-400">+{editStat.additions}</span>
                <span className="ml-1 text-red-400">-{editStat.deletions}</span>
              </span>
            ) : null}
            <CopyIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
          </div>
          <div className="max-h-[420px] overflow-auto">
            <FileDiff
              fileDiff={activeDiff.fileDiff}
              options={{
                disableFileHeader: true,
                diffStyle: "unified",
                hunkSeparators: () => null,
                lineDiffType: "none",
                theme: resolveDiffThemeName(props.resolvedTheme),
                themeType: props.resolvedTheme,
              }}
            />
          </div>
        </div>
      );
    }
    if (checkpointDiffQuery.isLoading || checkpointDiffQuery.isFetching) {
      return (
        <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm text-muted-foreground/70">
          Loading diff...
        </div>
      );
    }
    return null;
  }

  if (!shellCommand && !commandOutput && changedFiles.length === 0 && !activeDiff) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-card/45">
      {shellCommand ? (
        <div className="px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm text-foreground/86">Shell</span>
            <span className={cn("text-sm", workEntryStatusClass(workEntry))}>
              {workEntryStatusLabel(workEntry)}
            </span>
          </div>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground/92">
            <span className="text-foreground">$ </span>
            {shellCommand}
            {commandOutput ? `\n${commandOutput}` : ""}
          </pre>
        </div>
      ) : null}
      {!shellCommand && commandOutput ? (
        <div className="px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm text-foreground/86">
              {isFileReadWorkEntry(workEntry) ? "Output" : (workEntryToolName(workEntry) ?? "Tool")}
            </span>
            <span className={cn("text-sm", workEntryStatusClass(workEntry))}>
              {workEntryStatusLabel(workEntry)}
            </span>
          </div>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground/92">
            {commandOutput}
          </pre>
        </div>
      ) : null}
      {changedFiles.length > 0 ? (
        <div
          className={cn(
            "space-y-1.5 px-3 py-2",
            shellCommand || commandOutput ? "border-t border-border/45" : "",
          )}
        >
          {changedFiles.map((file) => (
            <button
              key={`${workEntry.id}:changed-file:${file.path}`}
              type="button"
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/25",
                file.path === activeDiffPath ? "bg-accent/30" : "",
              )}
              onClick={() => setActiveDiffPath(file.path)}
            >
              <VscodeEntryIcon
                pathValue={file.path}
                kind="file"
                theme={props.resolvedTheme}
                className="size-3.5"
              />
              <span
                className="min-w-0 flex-1 truncate text-sm text-info-foreground"
                title={file.path}
              >
                {basenameOfWorkPath(file.path)}
              </span>
              {file.additions || file.deletions ? (
                <span className="shrink-0 font-mono text-xs transition-colors duration-300">
                  <span className="text-emerald-400">+{file.additions}</span>
                  <span className="ml-1 text-red-400">-{file.deletions}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {activeDiff ? (
        <div className="max-h-[420px] overflow-auto border-t border-border/45 bg-background/40">
          <FileDiff
            fileDiff={activeDiff.fileDiff}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              theme: resolveDiffThemeName(props.resolvedTheme),
              themeType: props.resolvedTheme,
            }}
          />
        </div>
      ) : null}
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: WorkLogEntry;
  resolvedTheme: "light" | "dark";
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageLoad: () => void;
  homeDirectory: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const { onOpenThread, workEntry, resolvedTheme } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const detailPreview =
    !workEntry.command && workEntry.detail
      ? (workEntry.detail.split(/\r?\n/, 1)[0]?.trim() ?? null)
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
  const [parsedByPath, setParsedByPath] = useState<
    Record<string, RenderableInvocationDiffFile | null>
  >({});

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
  const generatedImages = workEntry.generatedImages ?? [];

  if (generatedImages.length > 0 && !canExpandInvocationDiff && !hasChangedFiles) {
    return (
      <div className="flex max-w-[656px] flex-col items-start gap-2">
        {generatedImages.map((image) => (
          <GeneratedImageWorkPreview
            key={`${workEntry.id}:generated-image:${image.cwd ?? ""}:${image.path}`}
            image={image}
            fallbackCwd={props.workspaceRoot}
            homeDirectory={props.homeDirectory}
            onImageExpand={props.onImageExpand}
            onImageLoad={props.onImageLoad}
            onOpenFilePath={props.onOpenFilePath}
          />
        ))}
      </div>
    );
  }

  if ((workEntry.subagents?.length ?? 0) > 0 || workEntry.subagentAction) {
    const subagentSummary =
      workEntry.subagentAction?.summaryText ??
      ((workEntry.subagents?.length ?? 0) === 1
        ? (workEntry.subagents?.[0]?.nickname ?? workEntry.subagents?.[0]?.title ?? "Subagent")
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
          <span
            className={cn(
              "mt-0.5 flex size-4.5 shrink-0 items-center justify-center",
              iconConfig.className,
            )}
          >
            <EntryIcon className="size-3" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[11px] font-medium leading-4.5 text-foreground/85"
              title={subagentSummary}
            >
              {subagentSummary}
            </p>
            {subagentMeta ? (
              <p
                className="truncate text-[10px] leading-4 text-muted-foreground/70"
                title={subagentMeta}
              >
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
                      <div
                        className="truncate pt-0.5 text-[10px] leading-4 text-muted-foreground/56"
                        title={secondaryLabel}
                      >
                        {secondaryLabel}
                      </div>
                    ) : null}
                    {subagent.latestUpdate ? (
                      <div
                        className="flex items-baseline gap-1.5 pt-1 text-[9px] text-muted-foreground/42"
                        title={subagent.latestUpdate}
                      >
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
        <span
          className={cn(
            "mt-0.5 flex size-4.5 shrink-0 items-center justify-center",
            iconConfig.className,
          )}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className="min-w-0 truncate text-[11px] font-medium leading-4.5 text-foreground/85"
              title={displayText}
            >
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
                aria-label={
                  isInvocationDiffExpanded ? "Collapse invocation diff" : "Expand invocation diff"
                }
              >
                <ChevronRightIcon
                  className={cn(
                    "size-2.5 transition-transform duration-150",
                    isInvocationDiffExpanded ? "rotate-90" : "",
                  )}
                />
                <span>{isInvocationDiffExpanded ? "Hide diff" : "Show diff"}</span>
              </button>
            )}
          </div>
          {workEntry.command ? (
            <p
              className="truncate font-mono text-[10px] leading-4 text-muted-foreground/80"
              title={workEntry.command}
            >
              {workEntry.command}
            </p>
          ) : null}
          {!workEntry.command && detailPreview && detailPreview !== heading && (
            <p
              className={cn("truncate text-[10px] leading-4", workToneClass(workEntry.tone))}
              title={workEntry.detail}
            >
              {detailPreview}
            </p>
          )}
          {primaryInvocationPath && (
            <span
              className="block truncate font-mono text-[10px] leading-4 text-muted-foreground/75"
              title={primaryInvocationPath}
            >
              {primaryInvocationPath}
            </span>
          )}
          {changedFilesLabel && (
            <span
              className="block truncate font-mono text-[10px] leading-4 text-muted-foreground/75"
              title={changedFilesLabel}
            >
              {changedFilesLabel}
            </span>
          )}
          {generatedImages.length > 0 ? (
            <div className="mt-1.5 grid max-w-[520px] grid-cols-1 gap-1.5 sm:grid-cols-2">
              {generatedImages.map((image) => (
                <GeneratedImageWorkPreview
                  key={`${workEntry.id}:generated-image:${image.cwd ?? ""}:${image.path}`}
                  image={image}
                  fallbackCwd={props.workspaceRoot}
                  homeDirectory={props.homeDirectory}
                  onImageExpand={props.onImageExpand}
                  onImageLoad={props.onImageLoad}
                  onOpenFilePath={props.onOpenFilePath}
                />
              ))}
            </div>
          ) : null}
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
                <p className="text-[10px] text-muted-foreground/70">
                  No invocation diff available for this file.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const GeneratedImageWorkPreview = memo(function GeneratedImageWorkPreview(props: {
  image: NonNullable<WorkLogEntry["generatedImages"]>[number];
  fallbackCwd: string | undefined;
  homeDirectory: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onImageLoad: () => void;
  onOpenFilePath?:
    | ((
        path: string,
        options?: { cwd?: string | undefined; displayName?: string | undefined },
      ) => void)
    | undefined;
}) {
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const codexGeneratedImageCwd =
    props.image.providerThreadId && props.homeDirectory
      ? `${props.homeDirectory.replaceAll("\\", "/")}/.codex/generated_images/${
          props.image.providerThreadId
        }`
      : null;
  const cwd = props.image.cwd ?? codexGeneratedImageCwd ?? props.fallbackCwd ?? null;
  const previewQuery = useQuery(
    projectReadFileQueryOptions({
      cwd,
      relativePath: props.image.path,
      enabled: Boolean(cwd && props.image.path),
      staleTime: 60_000,
    }),
  );
  const previewSrc =
    props.image.previewUrl ??
    (previewQuery.data?.status === "document"
      ? generatedImagePreviewSrc({
          contentsBase64: previewQuery.data.contentsBase64,
          mimeType: previewQuery.data.mimeType,
        })
      : null);

  if (!previewSrc) {
    return (
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md border border-border/40 bg-background/45 px-2 py-1.5 text-left text-[10px] text-muted-foreground/80 transition-colors hover:text-foreground/85"
        onClick={() =>
          props.onOpenFilePath?.(props.image.path, {
            cwd: cwd ?? undefined,
            displayName: props.image.label,
          })
        }
        title={props.image.cwd ? `${props.image.cwd}/${props.image.path}` : props.image.path}
      >
        <EyeIcon className="size-3.5 shrink-0" />
        <span className="truncate">{props.image.label}</span>
      </button>
    );
  }

  const aspectRatio =
    naturalSize && naturalSize.height > 0 ? naturalSize.width / naturalSize.height : null;
  const ratioClass =
    aspectRatio === null
      ? "max-h-[440px] max-w-full"
      : aspectRatio >= 1.75
        ? "max-h-[360px] w-full max-w-[656px]"
        : aspectRatio >= 1.15
          ? "max-h-[440px] w-full max-w-[656px]"
          : aspectRatio >= 0.82
            ? "max-h-[460px] max-w-[min(100%,460px)]"
            : aspectRatio >= 0.58
              ? "max-h-[520px] max-w-[min(100%,380px)]"
              : "max-h-[560px] max-w-[min(100%,300px)]";

  return (
    <button
      type="button"
      className="group inline-block max-w-full overflow-hidden rounded-lg border border-border/45 bg-transparent text-left transition-colors hover:border-border/75"
      onClick={() =>
        props.onImageExpand({
          images: [{ src: previewSrc, name: props.image.label }],
          index: 0,
        })
      }
    >
      <img
        src={previewSrc}
        alt={props.image.label}
        className={cn("block object-contain", ratioClass)}
        loading="lazy"
        onLoad={(event) => {
          const image = event.currentTarget;
          setNaturalSize({
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
          props.onImageLoad();
        }}
      />
    </button>
  );
});

export const MessagesTimeline = memo(function MessagesTimeline(props: MessagesTimelineProps) {
  const {
  isFocusedPane = true,
  hasMessages,
  isWorking,
  activeTurnInProgress,
  threadId,
  activeTurnStartedAt,
    scrollContainer,
    timelineEntries,
    completionDividerBeforeEntryId,
    completionSummary,
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
        return (
          selection.sourceKind === "assistant-message" && row.message.id === selection.sourceId
        );
      }
      if (row.kind === "proposed-plan") {
        return (
          selection.sourceKind === "proposed-plan" && row.proposedPlan.id === selection.sourceId
        );
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
          const imageOnlyGroup = groupedEntries.every(
            (entry) => entry.itemType === "image_view" && (entry.generatedImages?.length ?? 0) > 0,
          );

          if (imageOnlyGroup) {
            return (
              <div className="space-y-2">
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    resolvedTheme={resolvedTheme}
                    onOpenThread={onOpenThread}
                    onOpenFilePath={props.onOpenFilePath}
                    onImageExpand={onImageExpand}
                    onImageLoad={onTimelineImageLoad}
                    homeDirectory={props.homeDirectory}
                    workspaceRoot={workspaceRoot}
                  />
                ))}
              </div>
            );
          }

          return (
            <WorkLogGroup
              groupId={groupId}
              groupedEntries={groupedEntries}
              visibleEntries={visibleEntries}
              hiddenCount={hiddenCount}
              hasOverflow={hasOverflow}
              isExpanded={isExpanded}
              groupLabel={groupLabel}
              resolvedTheme={resolvedTheme}
              threadId={threadId}
              turnDiffSummaryByTurnId={turnDiffSummaryByTurnId}
              onToggleWorkGroup={onToggleWorkGroup}
              onOpenTurnDiff={onOpenTurnDiff}
              onOpenThread={onOpenThread}
              onOpenFilePath={props.onOpenFilePath}
              onImageExpand={onImageExpand}
              onImageLoad={onTimelineImageLoad}
              homeDirectory={props.homeDirectory}
              workspaceRoot={workspaceRoot}
            />
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
