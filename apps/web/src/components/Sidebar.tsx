import {
  ArchiveIcon,
  BlocksIcon,
  BriefcaseBusinessIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  CircleUserRoundIcon,
  ExternalLinkIcon,
  FolderIcon,
  GaugeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  KanbanSquareIcon,
  LayoutGridIcon,
  LoaderCircleIcon,
  LogOutIcon,
  LucideIcon,
  PinIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
} from "lucide-react";
import {
  Fragment,
  type FocusEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FiGitBranch } from "react-icons/fi";
import { IoFilter } from "react-icons/io5";
import { LuMessageCircleDashed } from "react-icons/lu";
import { TbArrowsDiagonal, TbArrowsDiagonalMinimize2, TbFolderPlus } from "react-icons/tb";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ServerProviderAccountSummary,
  type ServerProviderRateLimitWindow,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { cn, isMacPlatform, newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { type Project, type Thread } from "../types";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import {
  buildSidebarThreadHierarchy,
  buildChronologicalThreadList,
  includeAncestorThreads,
  groupThreadsByProject,
  getVisibleThreadsForProject,
  isRelevantThread,
  orderProjectsForSidebar,
  pruneMissingProjectIds,
  splitPinnedThreads,
  threadTimestamp,
} from "../sidebarModel";
import { reorderProjectOrder, useSidebarPreferences } from "../sidebarPreferences";
import { SETTINGS_SECTION_IDS } from "../settingsSections";
import { toastManager } from "./ui/toast";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { OpenAI, OpenCodeIcon, ClaudeAI } from "./Icons";
import type { ProviderKind } from "@t3tools/contracts";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import {
  buildSidebarFolderRoots,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import {
  canCreateThreadHandoff,
  inferProviderFromModel,
  resolveHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import { onToggleSidebarSearchPalette } from "../lib/sidebarSearchPalette";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { CHATS_PROJECT_TITLE, isChatsProject } from "../lib/chatProject";

function getProviderFromModel(model: string): ProviderKind {
  return inferProviderFromModel(model);
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, React.FC<React.SVGProps<SVGSVGElement>>> = {
  codex: OpenAI,
  opencode: OpenCodeIcon,
  claudeAgent: ClaudeAI,
};

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;
const THREAD_DETAIL_PREFETCH_DELAY_MS = 160;

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function collectThreadTree(threads: ReadonlyArray<Thread>, rootThreadId: ThreadId): Thread[] {
  const selected = new Map<ThreadId, Thread>();
  const queue: ThreadId[] = [rootThreadId];
  while (queue.length > 0) {
    const threadId = queue.shift();
    if (!threadId || selected.has(threadId)) {
      continue;
    }
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread) {
      continue;
    }
    selected.set(thread.id, thread);
    for (const child of threads) {
      if (child.parentThreadId === thread.id) {
        queue.push(child.id);
      }
    }
  }
  return Array.from(selected.values());
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard API unavailable.");
  }
  await navigator.clipboard.writeText(text);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ProviderGlyph(props: { provider: ProviderKind; className?: string }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.provider];
  return (
    <ProviderIcon
      className={cn("size-3.5 shrink-0 text-muted-foreground/74", props.className)}
      aria-label={`${props.provider} provider`}
    />
  );
}

function SidebarHydrationSkeleton() {
  return (
    <div
      className="space-y-3 px-2.5 pt-3"
      aria-label="Loading workspace navigation"
      data-testid="sidebar-hydration-skeleton"
    >
      {Array.from({ length: 3 }, (_, groupIndex) => (
        <div className="space-y-1.5" key={groupIndex}>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="space-y-1 pl-5">
            <Skeleton className="h-7 w-full rounded-md" />
            <Skeleton className="h-7 w-[86%] rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

function HandoffProviderGlyph(props: {
  sourceProvider: ProviderKind;
  targetProvider: ProviderKind;
}) {
  return (
    <span className="relative inline-flex h-[18px] w-6 shrink-0 items-center">
      <span className="-ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full border border-background bg-background shadow-xs">
        <ProviderGlyph provider={props.sourceProvider} className="size-3" />
      </span>
      <span className="-ml-1 inline-flex size-3.5 items-center justify-center rounded-full border border-background bg-background shadow-xs">
        <ProviderGlyph provider={props.targetProvider} className="size-3" />
      </span>
    </span>
  );
}

function SidebarSubagentTitle(props: { thread: Thread }) {
  const presentation = resolveSubagentPresentationForThread({
    thread: {
      id: props.thread.id,
      title: props.thread.title,
      model: props.thread.model,
      parentThreadId: props.thread.parentThreadId ?? null,
      subagentAgentId: props.thread.subagentAgentId ?? null,
      subagentNickname: props.thread.subagentNickname ?? null,
      subagentRole: props.thread.subagentRole ?? null,
      messages: props.thread.messages,
      activities: props.thread.activities,
    },
  });

  return (
    <span className="block truncate text-[13px] text-foreground/92">
      <span style={{ color: presentation.accentColor }}>
        {presentation.nickname ?? presentation.primaryLabel}
      </span>
      {presentation.role ? (
        <span className="ml-1 text-[11px] text-muted-foreground/55">({presentation.role})</span>
      ) : null}
    </span>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getRemainingPercent(window: ServerProviderRateLimitWindow | null): number | null {
  if (!window) {
    return null;
  }
  return clampPercent(100 - window.usedPercent);
}

function formatRateLimitWindowLabel(windowDurationMins: number | null): string {
  if (!windowDurationMins || windowDurationMins <= 0) {
    return "Window";
  }
  if (windowDurationMins === 10_080) {
    return "Weekly";
  }
  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }
  return `${windowDurationMins} min`;
}

function formatRateLimitResetAt(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function getSummaryRemainingPercent(
  accountSummary: ServerProviderAccountSummary | null,
): number | null {
  if (!accountSummary) {
    return null;
  }
  let lowestRemaining: number | null = null;
  for (const bucket of accountSummary.rateLimits) {
    const remainingPercents = [
      getRemainingPercent(bucket.primary),
      getRemainingPercent(bucket.secondary),
    ];
    for (const remaining of remainingPercents) {
      if (remaining === null) {
        continue;
      }
      if (lowestRemaining === null || remaining < lowestRemaining) {
        lowestRemaining = remaining;
      }
    }
  }
  return lowestRemaining;
}

function getCodexAccountSummary(
  providerAccounts: ReadonlyArray<ServerProviderAccountSummary> | undefined,
): ServerProviderAccountSummary | null {
  return providerAccounts?.find((providerAccount) => providerAccount.provider === "codex") ?? null;
}

interface SidebarSettingsPopoverProps {
  pathname: string;
  accountSummary: ServerProviderAccountSummary | null;
  open: boolean;
  startingLogin: boolean;
  cancelingLogin: boolean;
  loggingOut: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateToSettings: () => void;
  onStartLogin: () => void;
  onContinueLogin: (authUrl: string) => void;
  onCancelLogin: (loginId: string) => void;
  onLogout: () => void;
}

function SidebarSettingsPopover({
  pathname,
  accountSummary,
  open,
  startingLogin,
  cancelingLogin,
  loggingOut,
  onOpenChange,
  onNavigateToSettings,
  onStartLogin,
  onContinueLogin,
  onCancelLogin,
  onLogout,
}: SidebarSettingsPopoverProps) {
  const [rateLimitsOpen, setRateLimitsOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setRateLimitsOpen(false);
    }
  }, [open]);

  const rowClass =
    "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-accent/55";
  const subtleRowClass =
    "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent/55 hover:text-foreground";
  const remainingPercent = getSummaryRemainingPercent(accountSummary);
  const showRateLimits = (accountSummary?.rateLimits.length ?? 0) > 0;
  const rateLimitBuckets = accountSummary?.rateLimits ?? [];
  const loginState = accountSummary?.login;
  const pendingAuthUrl = loginState?.status === "pending" ? loginState.authUrl : null;
  const pendingLoginId = loginState?.status === "pending" ? loginState.loginId : null;
  const isAuthenticated = accountSummary?.state === "authenticated";
  const isUnauthenticated = accountSummary?.state === "unauthenticated";
  const isLoading = accountSummary?.state === "loading";
  const isError = accountSummary?.state === "error";

  let title = "Not signed in";
  let subtitle = "Sign in to view account and rate limits";
  if (accountSummary?.account?.type === "chatgpt") {
    title = accountSummary.account.email;
    subtitle = "Personal account";
  } else if (accountSummary?.account?.type === "apiKey") {
    title = "API key";
    subtitle = "Provider account";
  } else if (isLoading) {
    title = "Loading account";
    subtitle = accountSummary?.message ?? "Checking your Codex account state";
  } else if (isError) {
    title = "Account unavailable";
    subtitle = accountSummary?.message ?? "Unable to load Codex account details";
  }

  async function openExternalLink(url: string): Promise<void> {
    try {
      const api = readNativeApi();
      if (api) {
        await api.shell.openExternal(url);
        return;
      }
      if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to open link",
        description: getErrorMessage(error, "An error occurred opening the external link."),
      });
    }
  }

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger
        className={cn(
          "relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors duration-150",
          pathname === "/settings"
            ? "bg-accent/62 text-foreground"
            : "hover:bg-accent/45 hover:text-foreground",
        )}
      >
        {pathname === "/settings" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground/35"
          />
        ) : null}
        <SettingsIcon className="size-4 shrink-0" />
        <span>Settings</span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-[292px] max-w-[calc(100vw-1rem)] rounded-[16px] border border-border/70 bg-popover/98 p-0 shadow-[0_14px_40px_rgba(0,0,0,0.3)] backdrop-blur-md"
      >
        <div className="-mx-4 -my-4 overflow-hidden rounded-[inherit] py-1.5">
          <div className="px-3.5 py-2">
            <div className="flex min-w-0 items-center gap-2.5 text-[13px] text-muted-foreground">
              <CircleUserRoundIcon className="size-4 shrink-0" />
              <span className="truncate">{title}</span>
            </div>
            <div className="mt-1.5 flex min-w-0 items-center gap-2.5 text-[13px] text-muted-foreground">
              <SettingsIcon className="size-4 shrink-0" />
              <span className="truncate">{subtitle}</span>
            </div>
          </div>

          <div className="mx-3.5 border-t border-border/60" />
          <button type="button" className={rowClass} onClick={onNavigateToSettings}>
            <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Settings</span>
          </button>

          {showRateLimits && (
            <>
              <div className="mx-3.5 border-t border-border/60" />
              <Collapsible onOpenChange={setRateLimitsOpen} open={rateLimitsOpen}>
                <CollapsibleTrigger
                  className={cn(
                    rowClass,
                    "items-center justify-between",
                    rateLimitsOpen && "bg-accent/55",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <GaugeIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      Rate limits remaining{" "}
                      {remainingPercent !== null && (
                        <span className="text-muted-foreground">{remainingPercent}%</span>
                      )}
                    </span>
                  </div>
                  {rateLimitsOpen ? (
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-2.5 px-3.5 pb-2.5 pt-0.5">
                    {rateLimitBuckets.map((bucket, index) => {
                      const showBucketLabel = rateLimitBuckets.length > 1;
                      const bucketKey = [
                        bucket.limitId ?? "rate-limit",
                        bucket.limitName ?? "unnamed",
                        bucket.planType ?? "unknown",
                        bucket.primary?.windowDurationMins ?? "primary",
                        bucket.secondary?.windowDurationMins ?? "secondary",
                      ].join(":");

                      return (
                        <div key={bucketKey} className={cn("space-y-1.5", index > 0 && "pt-0.5")}>
                          {showBucketLabel && (
                            <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                              <span>
                                {bucket.limitName ?? bucket.limitId ?? `Rate limit ${index + 1}`}
                              </span>
                              {bucket.planType && <span>{bucket.planType}</span>}
                            </div>
                          )}

                          {[
                            { slot: "primary", window: bucket.primary },
                            { slot: "secondary", window: bucket.secondary },
                          ].map(({ slot, window }) => {
                            if (!window) {
                              return null;
                            }
                            const resetLabel = formatRateLimitResetAt(window.resetsAt);
                            const label = formatRateLimitWindowLabel(window.windowDurationMins);
                            const percent = getRemainingPercent(window);
                            return (
                              <div
                                key={[
                                  bucketKey,
                                  slot,
                                  window.windowDurationMins ?? "window",
                                  window.resetsAt ?? "no-reset",
                                ].join(":")}
                                className="flex items-baseline justify-between gap-2 text-[13px]"
                              >
                                <span className="font-semibold text-foreground">{label}</span>
                                <div className="flex items-baseline gap-2 text-muted-foreground">
                                  <span>{percent !== null ? `${percent}%` : "--"}</span>
                                  {resetLabel && <span>{resetLabel}</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      className={cn(subtleRowClass, "px-2.5 py-1.5 font-medium text-foreground")}
                      onClick={() => void openExternalLink("https://chatgpt.com/#pricing")}
                    >
                      <span className="flex-1">Upgrade to Pro</span>
                      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      className={cn(subtleRowClass, "px-2.5 py-1.5 font-medium text-foreground")}
                      onClick={() =>
                        void openExternalLink(
                          "https://help.openai.com/en/articles/9824962-openai-codex-cli-getting-started",
                        )
                      }
                    >
                      <span className="flex-1">Learn more</span>
                      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          <div className="mx-3.5 border-t border-border/60" />

          {isUnauthenticated && loginState?.status !== "pending" && (
            <button
              type="button"
              className={rowClass}
              disabled={startingLogin}
              onClick={onStartLogin}
            >
              {startingLogin ? (
                <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <CircleUserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span>{loginState?.status === "failed" ? "Try again" : "Sign in"}</span>
            </button>
          )}

          {pendingAuthUrl && (
            <>
              <button
                type="button"
                className={rowClass}
                onClick={() => onContinueLogin(pendingAuthUrl)}
              >
                <CircleUserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">Continue sign in</span>
                <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
              {pendingLoginId && (
                <button
                  type="button"
                  className={subtleRowClass}
                  disabled={cancelingLogin}
                  onClick={() => onCancelLogin(pendingLoginId)}
                >
                  {cancelingLogin ? (
                    <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <CircleUserRoundIcon className="size-4 shrink-0" />
                  )}
                  <span>Cancel sign in</span>
                </button>
              )}
            </>
          )}

          {loginState?.status === "failed" && loginState.error && (
            <div className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              {loginState.error}
            </div>
          )}

          {isAuthenticated && (
            <button type="button" className={rowClass} disabled={loggingOut} onClick={onLogout}>
              {loggingOut ? (
                <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <LogOutIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span>Log out</span>
            </button>
          )}

          {!isAuthenticated && !isUnauthenticated && !showRateLimits && (
            <div className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              {accountSummary?.message ?? "Account details are not available yet."}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

interface ThreadStatusPill {
  label: "Working" | "Connecting" | "Completed" | "Pending Approval" | "Awaiting Input";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  Completed: 1,
};

function hasUnseenCompletion(thread: Thread): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function threadStatusPill(
  thread: Thread,
  hasPendingApprovals: boolean,
  hasPendingUserInput: boolean,
): ThreadStatusPill | null {
  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

const PRIMARY_NAV_ITEMS: Array<{
  icon: LucideIcon;
  label: string;
  action: "new-thread" | "placeholder" | "orchestrate" | "plugins" | "skills";
  testId: string;
}> = [
  {
    icon: SquarePenIcon,
    label: "New chat",
    action: "new-thread",
    testId: "sidebar-primary-new-thread",
  },
  {
    icon: BlocksIcon ?? LayoutGridIcon,
    label: "Skills",
    action: "skills",
    testId: "sidebar-primary-skills",
  },
  {
    icon: LayoutGridIcon,
    label: "Plugins",
    action: "plugins",
    testId: "sidebar-primary-plugins",
  },
  {
    icon: KanbanSquareIcon ?? BriefcaseBusinessIcon,
    label: "Orchestrate",
    action: "orchestrate",
    testId: "sidebar-primary-orchestrate",
  },
];

const SIDEBAR_HEADER_ACTION_CLASS =
  "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/58 transition-colors duration-150 hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const SIDEBAR_SECTION_TOGGLE_CLASS =
  "flex min-w-0 items-center gap-1.5 rounded-md text-left transition-colors hover:text-foreground";

const SIDEBAR_SUBSECTION_HEADING_CLASS =
  "px-2.5 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/54";

const PROJECT_THREAD_RAIL_TOP_PX = 4;
const PROJECT_THREAD_RAIL_ROW_STEP_PX = 34;
const PROJECT_THREAD_RAIL_SELECTED_ROW_CENTER_PX = 16;

function SidebarSectionHeading({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 pb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/58">
      <span className="flex-1">{children}</span>
      {actions ? (
        <div className="-mr-1 flex items-center gap-0.5 rounded-lg bg-background/25 p-0.5 ring-1 ring-border/30">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function buildOrchestrateSearch(input: { projectId?: string | null; taskId?: string | null }) {
  return {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  };
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const hydrationError = useStore((store) => store.hydrationError);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setAllProjectsExpanded = useStore((store) => store.setAllProjectsExpanded);
  const collapseProjectsExcept = useStore((store) => store.collapseProjectsExcept);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const navigate = useNavigate();
  const { createThreadHandoff } = useThreadHandoff();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { settings: appSettings } = useAppSettings();
  const { preferences: sidebarPreferences, updatePreferences: updateSidebarPreferences } =
    useSidebarPreferences();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfig?.keybindings ?? EMPTY_KEYBINDINGS;
  const homeDirectory = serverConfig?.homeDirectory ?? null;
  const chatWorkspaceRoot = serverConfig?.chatWorkspaceRoot ?? null;
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [projectsSectionExpanded, setProjectsSectionExpanded] = useState(true);
  const [chatsSectionExpanded, setChatsSectionExpanded] = useState(true);
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [archiveConfirmThreadId, setArchiveConfirmThreadId] = useState<ThreadId | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [draggedProjectId, setDraggedProjectId] = useState<ProjectId | null>(null);
  const [dropTargetProjectId, setDropTargetProjectId] = useState<ProjectId | null>(null);
  const [dropTargetPosition, setDropTargetPosition] = useState<"before" | "after" | null>(null);
  const threadDetailPrefetchTimeoutsRef = useRef(new Map<ThreadId, number>());
  const threadDetailPrefetchInFlightRef = useRef(new Set<ThreadId>());
  const threadDetailPrefetchKeyByThreadIdRef = useRef(new Map<ThreadId, string>());

  const cancelThreadDetailPrefetch = useCallback((threadId: ThreadId) => {
    const timeoutId = threadDetailPrefetchTimeoutsRef.current.get(threadId);
    if (timeoutId === undefined) {
      return;
    }
    window.clearTimeout(timeoutId);
    threadDetailPrefetchTimeoutsRef.current.delete(threadId);
  }, []);

  const scheduleThreadDetailPrefetch = useCallback(
    (thread: Thread) => {
      if (
        thread.id === routeThreadId ||
        thread.archivedAt !== null ||
        thread.latestTurn === null ||
        thread.messages.length > 0
      ) {
        return;
      }

      const prefetchKey = [
        thread.id,
        thread.updatedAt,
        thread.latestTurn.turnId,
        thread.latestTurn.completedAt ?? "",
      ].join("\u0000");
      if (threadDetailPrefetchKeyByThreadIdRef.current.get(thread.id) === prefetchKey) {
        return;
      }
      if (threadDetailPrefetchInFlightRef.current.has(thread.id)) {
        return;
      }
      if (threadDetailPrefetchTimeoutsRef.current.has(thread.id)) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        threadDetailPrefetchTimeoutsRef.current.delete(thread.id);
        const currentThread = useStore
          .getState()
          .threads.find((candidate) => candidate.id === thread.id);
        if (
          currentThread === undefined ||
          currentThread.archivedAt !== null ||
          currentThread.latestTurn === null ||
          currentThread.messages.length > 0
        ) {
          return;
        }

        const api = readNativeApi();
        if (!api) {
          return;
        }

        threadDetailPrefetchInFlightRef.current.add(thread.id);
        void api.orchestration
          .getSnapshot({
            mode: "focused",
            threadId: thread.id,
            threadIds: [thread.id],
          })
          .then((snapshot) => {
            syncServerReadModel(snapshot, {
              authoritativeThreadDetailIds: new Set([thread.id]),
              preserveThreadDetails: true,
            });
            threadDetailPrefetchKeyByThreadIdRef.current.set(thread.id, prefetchKey);
          })
          .catch(() => undefined)
          .finally(() => {
            threadDetailPrefetchInFlightRef.current.delete(thread.id);
          });
      }, THREAD_DETAIL_PREFETCH_DELAY_MS);

      threadDetailPrefetchTimeoutsRef.current.set(thread.id, timeoutId);
    },
    [routeThreadId, syncServerReadModel],
  );

  useEffect(
    () => () => {
      for (const timeoutId of threadDetailPrefetchTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      threadDetailPrefetchTimeoutsRef.current.clear();
    },
    [],
  );

  const openSearchPalette = useCallback((mode: SidebarSearchPaletteMode = "search") => {
    setSearchPaletteMode(mode);
    setSearchPaletteOpen(true);
  }, []);

  const handleSearchPaletteOpenChange = useCallback((open: boolean) => {
    setSearchPaletteOpen(open);
    if (!open) {
      setSearchPaletteMode("search");
    }
  }, []);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const codexAccountSummary = useMemo(
    () => getCodexAccountSummary(serverConfig?.providerAccounts),
    [serverConfig?.providerAccounts],
  );
  const startProviderLoginMutation = useMutation({
    mutationFn: async () => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }
      const result = await api.server.startProviderLogin({
        provider: "codex",
        type: "chatgpt",
      });
      await api.shell.openExternal(result.authUrl);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to start sign in",
        description: getErrorMessage(error, "An error occurred starting the sign-in flow."),
      });
    },
  });
  const cancelProviderLoginMutation = useMutation({
    mutationFn: async (loginId: string) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }
      return api.server.cancelProviderLogin({
        provider: "codex",
        loginId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to cancel sign in",
        description: getErrorMessage(error, "An error occurred canceling the sign-in flow."),
      });
    },
  });
  const logoutProviderMutation = useMutation({
    mutationFn: async () => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }
      return api.server.logoutProvider({ provider: "codex" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to log out",
        description: getErrorMessage(error, "An error occurred logging out."),
      });
    },
  });
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const pendingUserInputByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingUserInputs(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
  const homeProject = useMemo(
    () =>
      projects.find((project) => isChatsProject(project, chatWorkspaceRoot ?? homeDirectory)) ??
      null,
    [chatWorkspaceRoot, homeDirectory, projects],
  );
  const workspaceProjects = useMemo(
    () =>
      projects.filter((project) => !isChatsProject(project, chatWorkspaceRoot ?? homeDirectory)),
    [chatWorkspaceRoot, homeDirectory, projects],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const activeThread = useMemo(
    () => (routeThreadId ? (threads.find((thread) => thread.id === routeThreadId) ?? null) : null),
    [routeThreadId, threads],
  );
  const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
  const focusedProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const allProjectsExpanded = useMemo(
    () => workspaceProjects.length > 0 && workspaceProjects.every((project) => project.expanded),
    [workspaceProjects],
  );
  const orderedProjects = useMemo(
    () => orderProjectsForSidebar(workspaceProjects, sidebarPreferences.projectOrder),
    [sidebarPreferences.projectOrder, workspaceProjects],
  );
  const filteredThreads = useMemo(() => {
    const activeThreads = threads.filter((thread) => thread.archivedAt == null);
    if (sidebarPreferences.threadShow === "all") {
      return activeThreads;
    }

    const relevantThreads = activeThreads.filter((thread) =>
      isRelevantThread(thread, {
        hasPendingApproval: pendingApprovalByThreadId.get(thread.id) === true,
        isActive: routeThreadId === thread.id,
      }),
    );
    return includeAncestorThreads(activeThreads, relevantThreads);
  }, [pendingApprovalByThreadId, routeThreadId, sidebarPreferences.threadShow, threads]);
  const { pinnedThreads, unpinnedThreads: unpinnedFilteredThreads } = useMemo(
    () => splitPinnedThreads(filteredThreads),
    [filteredThreads],
  );
  const homeProjectId = homeProject?.id ?? null;
  const homeThreads = useMemo(
    () =>
      homeProjectId
        ? unpinnedFilteredThreads.filter((thread) => thread.projectId === homeProjectId)
        : [],
    [homeProjectId, unpinnedFilteredThreads],
  );
  const projectThreads = useMemo(
    () =>
      homeProjectId
        ? unpinnedFilteredThreads.filter((thread) => thread.projectId !== homeProjectId)
        : unpinnedFilteredThreads,
    [homeProjectId, unpinnedFilteredThreads],
  );
  const visibleProjectIds = useMemo(
    () => new Set(projectThreads.map((thread) => thread.projectId)),
    [projectThreads],
  );
  const groupedProjects = useMemo(() => {
    const groups = groupThreadsByProject(orderedProjects, projectThreads, {
      threadSort: sidebarPreferences.threadSort,
    });
    if (sidebarPreferences.threadShow === "relevant") {
      return groups.filter((group) => group.threads.length > 0);
    }
    return groups;
  }, [
    orderedProjects,
    projectThreads,
    sidebarPreferences.threadShow,
    sidebarPreferences.threadSort,
  ]);
  const chronologicalThreads = useMemo(
    () =>
      buildChronologicalThreadList(unpinnedFilteredThreads, {
        threadSort: sidebarPreferences.threadSort,
      }),
    [unpinnedFilteredThreads, sidebarPreferences.threadSort],
  );
  const chronologicalThreadChildren = useMemo(
    () => buildSidebarThreadHierarchy(chronologicalThreads),
    [chronologicalThreads],
  );
  const pinnedThreadHierarchy = useMemo(
    () => buildSidebarThreadHierarchy(pinnedThreads),
    [pinnedThreads],
  );
  const homeThreadHierarchy = useMemo(
    () => buildSidebarThreadHierarchy(homeThreads),
    [homeThreads],
  );
  const firstVisibleProjectId = useMemo(
    () =>
      orderedProjects.find(
        (project) => sidebarPreferences.threadShow === "all" || visibleProjectIds.has(project.id),
      )?.id ??
      orderedProjects[0]?.id ??
      null,
    [orderedProjects, sidebarPreferences.threadShow, visibleProjectIds],
  );

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    const prunedProjectOrder = pruneMissingProjectIds(
      sidebarPreferences.projectOrder,
      workspaceProjects,
    );
    if (prunedProjectOrder.length === sidebarPreferences.projectOrder.length) {
      return;
    }
    updateSidebarPreferences((currentPreferences) => ({
      ...currentPreferences,
      projectOrder: prunedProjectOrder,
    }));
  }, [
    sidebarPreferences.projectOrder,
    threadsHydrated,
    updateSidebarPreferences,
    workspaceProjects,
  ]);

  useEffect(() => {
    const projectIds = new Set(workspaceProjects.map((project) => project.id));
    setExpandedThreadListsByProject((existing) => {
      const next = new Set([...existing].filter((projectId) => projectIds.has(projectId)));
      if (next.size === existing.size) {
        return existing;
      }
      return next;
    });
  }, [workspaceProjects]);

  useEffect(() => {
    if (!routeThreadId) {
      return;
    }
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    let currentParentId = threadById.get(routeThreadId)?.parentThreadId ?? null;
    if (!currentParentId) {
      return;
    }
    setExpandedSubagentParentIds((existing) => {
      const next = new Set(existing);
      let changed = false;
      while (currentParentId) {
        if (!next.has(currentParentId)) {
          next.add(currentParentId);
          changed = true;
        }
        currentParentId = threadById.get(currentParentId)?.parentThreadId ?? null;
      }
      return changed ? next : existing;
    });
  }, [routeThreadId, threads]);

  useEffect(() => {
    return onToggleSidebarSearchPalette(() => {
      setSearchPaletteOpen((existing) => {
        const nextOpen = !existing;
        if (nextOpen) {
          setSearchPaletteMode("search");
        }
        return nextOpen;
      });
    });
  }, []);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);
  const handleNavigateToSettings = useCallback(() => {
    setSettingsPopoverOpen(false);
    void navigate({
      to: "/settings",
      search: { section: SETTINGS_SECTION_IDS.appearance },
    });
  }, [navigate]);
  const handleContinueProviderLogin = useCallback((authUrl: string) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Sign in is unavailable.",
      });
      return;
    }
    void api.shell.openExternal(authUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to continue sign in",
        description: getErrorMessage(error, "An error occurred reopening the sign-in flow."),
      });
    });
  }, []);
  const handleStartProviderLogin = useCallback(() => {
    startProviderLoginMutation.mutate();
  }, [startProviderLoginMutation]);
  const handleCancelProviderLogin = useCallback(
    (loginId: string) => {
      cancelProviderLoginMutation.mutate(loginId);
    },
    [cancelProviderLoginMutation],
  );
  const handleLogoutProvider = useCallback(() => {
    logoutProviderMutation.mutate();
  }, [logoutProviderMutation]);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        temporary?: boolean;
      },
    ): Promise<void> => {
      const wantsTemporaryThread = options?.temporary === true;
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThreadCandidate = getDraftThreadByProjectId(projectId);
      const storedDraftThread =
        !wantsTemporaryThread && storedDraftThreadCandidate?.isTemporary !== true
          ? storedDraftThreadCandidate
          : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }
      clearProjectDraftThreadId(projectId);

      const activeDraftThreadCandidate = routeThreadId ? getDraftThread(routeThreadId) : null;
      const activeDraftThread =
        !wantsTemporaryThread && activeDraftThreadCandidate?.isTemporary !== true
          ? activeDraftThreadCandidate
          : null;
      if (activeDraftThread && routeThreadId && activeDraftThread.projectId === projectId) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        let worktreePath = options?.worktreePath ?? null;
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          ...(wantsTemporaryThread ? { isTemporary: true } : {}),
        });
        if (wantsTemporaryThread) {
          markTemporaryThread(threadId);
        }

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      navigate,
      getDraftThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
      markTemporaryThread,
    ],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return false;
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description: "Native API is unavailable.",
        });
        return false;
      }

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return true;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
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
        try {
          await handleNewThread(projectId);
        } catch (error) {
          toastManager.add({
            type: "warning",
            title: "Project added, but thread creation failed",
            description: getErrorMessage(error, "Failed to create the initial thread."),
          });
        }
        finishAddingProject();
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description: getErrorMessage(
            error,
            "The project could not be created. Check that the app is connected and try again.",
          ),
        });
        finishAddingProject();
        return false;
      }
    },
    [focusMostRecentThreadForProject, handleNewThread, isAddingProject, projects],
  );

  const getOrCreateHomeProjectId = useCallback(async (): Promise<ProjectId | null> => {
    const workspaceRoot = chatWorkspaceRoot ?? homeDirectory;
    if (!workspaceRoot) {
      return null;
    }
    const existingHomeProject =
      homeProject ?? projects.find((project) => project.cwd === workspaceRoot);
    if (existingHomeProject) {
      return existingHomeProject.id;
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Unable to create chat",
        description: "Native API is unavailable.",
      });
      return null;
    }

    const projectId = newProjectId();
    const createdAt = new Date().toISOString();
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      title: CHATS_PROJECT_TITLE,
      workspaceRoot,
      defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
      createdAt,
    });
    return projectId;
  }, [chatWorkspaceRoot, homeDirectory, homeProject, projects]);

  const handlePrimaryNewThread = useCallback(() => {
    void (async () => {
      const projectId = await getOrCreateHomeProjectId();
      if (projectId) {
        await handleNewThread(projectId);
        return;
      }

      const fallbackProjectId =
        activeThread?.projectId ?? activeDraftThread?.projectId ?? firstVisibleProjectId;
      if (!fallbackProjectId) {
        openSearchPalette("folder");
        return;
      }

      await handleNewThread(fallbackProjectId);
    })().catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to create chat",
        description: getErrorMessage(error, "The chat could not be created."),
      });
    });
  }, [
    activeDraftThread,
    activeThread,
    firstVisibleProjectId,
    getOrCreateHomeProjectId,
    handleNewThread,
    openSearchPalette,
  ]);

  const handleOpenOrchestrate = useCallback(() => {
    const projectId =
      activeThread?.projectId ?? activeDraftThread?.projectId ?? firstVisibleProjectId;
    void navigate({
      to: "/orchestrate",
      search: buildOrchestrateSearch({
        projectId,
      }),
    });
  }, [activeDraftThread, activeThread, firstVisibleProjectId, navigate]);

  const handlePlaceholderNavClick = useCallback((label: string) => {
    toastManager.add({
      type: "info",
      title: `${label} is coming soon`,
    });
  }, []);

  const handleThreadOrganizationChange = useCallback(
    (value: string) => {
      updateSidebarPreferences((currentPreferences) => ({
        ...currentPreferences,
        threadOrganization: value === "chronological" ? "chronological" : "by-project",
      }));
    },
    [updateSidebarPreferences],
  );

  const handleThreadSortChange = useCallback(
    (value: string) => {
      updateSidebarPreferences((currentPreferences) => ({
        ...currentPreferences,
        threadSort: value === "created" ? "created" : "updated",
      }));
    },
    [updateSidebarPreferences],
  );

  const handleThreadShowChange = useCallback(
    (value: string) => {
      updateSidebarPreferences((currentPreferences) => ({
        ...currentPreferences,
        threadShow: value === "relevant" ? "relevant" : "all",
      }));
    },
    [updateSidebarPreferences],
  );

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((existing) => {
      if (existing.has(projectId)) {
        return existing;
      }
      return new Set([...existing, projectId]);
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((existing) => {
      if (!existing.has(projectId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(projectId);
      return next;
    });
  }, []);

  const toggleSubagentParent = useCallback((threadId: ThreadId) => {
    setExpandedSubagentParentIds((existing) => {
      const next = new Set(existing);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const handleToggleProjects = useCallback(() => {
    if (allProjectsExpanded) {
      collapseProjectsExcept(focusedProjectId);
      return;
    }
    setAllProjectsExpanded(true);
  }, [allProjectsExpanded, collapseProjectsExcept, focusedProjectId, setAllProjectsExpanded]);

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const clearArchiveConfirm = useCallback((threadId?: ThreadId) => {
    setArchiveConfirmThreadId((current) => {
      if (threadId === undefined) {
        return null;
      }
      return current === threadId ? null : current;
    });
  }, []);

  useEffect(() => {
    if (archiveConfirmThreadId === null) {
      return;
    }
    if (
      threads.some((thread) => thread.id === archiveConfirmThreadId && thread.archivedAt == null)
    ) {
      return;
    }
    setArchiveConfirmThreadId(null);
  }, [archiveConfirmThreadId, threads]);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const handleSetThreadPinned = useCallback(async (threadId: ThreadId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        isPinned,
        pinnedAt: isPinned ? new Date().toISOString() : null,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: isPinned ? "Failed to pin thread" : "Failed to unpin thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, []);

  const handoffThread = useCallback(
    async (thread: Thread, targetProvider?: ProviderKind) => {
      try {
        await createThreadHandoff(thread, targetProvider ? { targetProvider } : undefined);
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
    },
    [createThreadHandoff],
  );

  const archiveThread = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const affectedThreads = collectThreadTree(threads, threadId).filter(
        (entry) => entry.archivedAt == null,
      );
      const affectedThreadIds = new Set(affectedThreads.map((entry) => entry.id));

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
        includeChildren: true,
      });

      if (routeThreadId && affectedThreadIds.has(routeThreadId)) {
        const fallbackThreadId =
          threads.find((entry) => !affectedThreadIds.has(entry.id) && entry.archivedAt == null)
            ?.id ?? null;
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }
    },
    [navigate, routeThreadId, threads],
  );

  const handleInlineArchiveConfirm = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } finally {
        setArchiveConfirmThreadId((current) => (current === threadId ? null : current));
      }
    },
    [archiveThread],
  );

  const confirmAndArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;

      if (appSettings.confirmThreadArchive) {
        const confirmed = await api.dialogs.confirm(
          [
            `Archive thread "${thread.title}"?`,
            "Archived threads are hidden from the sidebar but can be restored later.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await archiveThread(threadId);
    },
    [appSettings.confirmThreadArchive, archiveThread, threads],
  );

  const archiveAllThreadsInProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter(
        (thread) => thread.projectId === projectId && thread.archivedAt == null,
      );
      if (projectThreads.length === 0) {
        toastManager.add({
          type: "info",
          title: "Nothing to archive",
          description: `"${project.name}" has no threads to archive.`,
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [
          `Archive ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} in "${project.name}"?`,
          "Archived threads are hidden from the sidebar but can be restored later.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      const affectedThreadIds = new Set(projectThreads.map((thread) => thread.id));

      try {
        await api.orchestration.dispatchCommand({
          type: "project.archive",
          commandId: newCommandId(),
          projectId,
        });
        if (routeThreadId && affectedThreadIds.has(routeThreadId)) {
          const fallbackThreadId =
            threads.find((thread) => !affectedThreadIds.has(thread.id) && thread.archivedAt == null)
              ?.id ?? null;
          if (fallbackThreadId) {
            void navigate({
              to: "/$threadId",
              params: { threadId: fallbackThreadId },
              replace: true,
            });
          } else {
            void navigate({ to: "/", replace: true });
          }
        }
        toastManager.add({
          type: "success",
          title:
            projectThreads.length === 1
              ? "Thread archived"
              : `Archived ${projectThreads.length} threads`,
          description: `"${project.name}" archived.`,
        });
      } catch (error) {
        console.error("Failed to archive threads during bulk archive", { projectId, error });
        toastManager.add({
          type: "error",
          title: "Failed to archive threads",
          description: getErrorMessage(error, `Could not archive threads in "${project.name}".`),
        });
      }
    },
    [navigate, projects, routeThreadId, threads],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const isDisposableThread =
        temporaryThreadIds[thread.id] === true ||
        draftThreadsByThreadId[thread.id]?.isTemporary === true;
      const hasPendingApprovals = derivePendingApprovals(thread.activities).length > 0;
      const hasPendingUserInput = derivePendingUserInputs(thread.activities).length > 0;
      const canHandoff =
        !isDisposableThread &&
        canCreateThreadHandoff({
          thread,
          hasPendingApprovals,
          hasPendingUserInput,
        });
      const sourceProvider = inferProviderFromModel(thread.model);
      const handoffTargetProviders = canHandoff
        ? resolveHandoffTargetProviders(sourceProvider)
        : [];
      const handoffMenuItems = handoffTargetProviders.map((provider) => ({
        id: `handoff:${provider}`,
        label: `Handoff to ${PROVIDER_DISPLAY_NAMES[provider]}`,
      }));
      const clicked = await api.contextMenu.show(
        [
          ...(thread.taskId ? [{ id: "open-task", label: "Open task" }] : []),
          { id: "rename", label: "Rename thread" },
          {
            id: thread.isPinned ? "unpin" : "pin",
            label: thread.isPinned ? "Unpin thread" : "Pin thread",
          },
          { id: "archive", label: "Archive" },
          { id: "mark-unread", label: "Mark unread" },
          ...handoffMenuItems,
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "open-task" && thread.taskId) {
        void navigate({
          to: "/orchestrate",
          search: buildOrchestrateSearch({
            projectId: thread.projectId,
            taskId: thread.taskId,
          }),
        });
        return;
      }

      if (clicked === "pin") {
        await handleSetThreadPinned(threadId, true);
        return;
      }

      if (clicked === "unpin") {
        await handleSetThreadPinned(threadId, false);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "archive") {
        await confirmAndArchiveThread(threadId);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff:")) {
        const selectedTargetProvider = clicked.slice("handoff:".length);
        if (
          selectedTargetProvider === "codex" ||
          selectedTargetProvider === "opencode" ||
          selectedTargetProvider === "claudeAgent"
        ) {
          await handoffThread(thread, selectedTargetProvider);
        }
        return;
      }
      if (clicked === "copy-thread-id") {
        try {
          await copyTextToClipboard(threadId);
          toastManager.add({
            type: "success",
            title: "Thread ID copied",
            description: threadId,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy thread ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const affectedThreads = collectThreadTree(threads, threadId);
        const childCount = Math.max(affectedThreads.length - 1, 0);
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            ...(childCount > 0
              ? [`This will also delete ${childCount} child thread${childCount === 1 ? "" : "s"}.`]
              : []),
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      const affectedThreads = collectThreadTree(threads, threadId);
      const affectedThreadIds = new Set(affectedThreads.map((entry) => entry.id));
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(threads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({
          threadId,
          deleteHistory: true,
        });
      } catch {
        // Terminal may already be closed
      }

      const shouldNavigateToFallback = routeThreadId ? affectedThreadIds.has(routeThreadId) : false;
      const fallbackThreadId =
        threads.find((entry) => !affectedThreadIds.has(entry.id) && entry.archivedAt == null)?.id ??
        null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
        includeChildren: true,
      });
      for (const affectedThread of affectedThreads) {
        clearComposerDraftForThread(affectedThread.id);
        clearProjectDraftThreadById(affectedThread.projectId, affectedThread.id);
        clearTerminalState(affectedThread.id);
        clearTemporaryThread(affectedThread.id);
      }
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      appSettings.confirmThreadDelete,
      confirmAndArchiveThread,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTemporaryThread,
      clearTerminalState,
      draftThreadsByThreadId,
      handleSetThreadPinned,
      handoffThread,
      markThreadUnread,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      temporaryThreadIds,
      threads,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "archive-threads", label: "Archive project" },
          { id: "delete", label: "Delete project", destructive: true },
        ],
        position,
      );
      if (clicked === "archive-threads") {
        await archiveAllThreadsInProject(projectId);
        return;
      }
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      const confirmed = await api.dialogs.confirm(
        [
          `Delete project "${project.name}"?`,
          ...(projectThreads.length > 0
            ? [
                `This will first delete ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} in the project.`,
              ]
            : []),
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      try {
        const affectedThreadIds = new Set(projectThreads.map((thread) => thread.id));
        const shouldNavigateToFallback =
          routeThreadId !== undefined &&
          routeThreadId !== null &&
          affectedThreadIds.has(routeThreadId);
        const fallbackThreadId =
          threads.find((thread) => !affectedThreadIds.has(thread.id) && thread.archivedAt == null)
            ?.id ?? null;
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
          clearTemporaryThread(projectDraftThread.threadId);
        }
        for (const thread of projectThreads) {
          clearComposerDraftForThread(thread.id);
          clearProjectDraftThreadById(thread.projectId, thread.id);
          clearTerminalState(thread.id);
          clearTemporaryThread(thread.id);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
          deleteThreads: true,
        });
        await api.browser.kill({ projectId }).catch(() => undefined);
        if (shouldNavigateToFallback) {
          if (fallbackThreadId) {
            void navigate({
              to: "/$threadId",
              params: { threadId: fallbackThreadId },
              replace: true,
            });
          } else {
            void navigate({ to: "/", replace: true });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error deleting project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to delete "${project.name}"`,
          description: message,
        });
      }
    },
    [
      archiveAllThreadsInProject,
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      clearProjectDraftThreadById,
      clearTemporaryThread,
      clearTerminalState,
      getDraftThreadByProjectId,
      navigate,
      projects,
      routeThreadId,
      threads,
    ],
  );

  const handleProjectDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>, projectId: ProjectId) => {
      if (sidebarPreferences.threadOrganization !== "by-project") {
        event.preventDefault();
        return;
      }

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", projectId);
      setDraggedProjectId(projectId);
      setDropTargetProjectId(null);
      setDropTargetPosition(null);
    },
    [sidebarPreferences.threadOrganization],
  );

  const handleProjectDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>, projectId: ProjectId) => {
      if (!draggedProjectId || draggedProjectId === projectId) {
        return;
      }

      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = event.clientY - bounds.top > bounds.height / 2 ? "after" : "before";
      if (dropTargetProjectId === projectId && dropTargetPosition === position) {
        return;
      }
      setDropTargetProjectId(projectId);
      setDropTargetPosition(position);
    },
    [draggedProjectId, dropTargetPosition, dropTargetProjectId],
  );

  const handleProjectDrop = useCallback(
    (projectId: ProjectId) => {
      if (!draggedProjectId || !dropTargetPosition || draggedProjectId === projectId) {
        setDraggedProjectId(null);
        setDropTargetProjectId(null);
        setDropTargetPosition(null);
        return;
      }

      const nextProjectOrder = reorderProjectOrder(
        sidebarPreferences.projectOrder,
        draggedProjectId,
        projectId,
        dropTargetPosition,
        orderedProjects.map((project) => project.id),
      );

      updateSidebarPreferences((currentPreferences) => ({
        ...currentPreferences,
        projectOrder: nextProjectOrder,
      }));
      setDraggedProjectId(null);
      setDropTargetProjectId(null);
      setDropTargetPosition(null);
    },
    [
      draggedProjectId,
      dropTargetPosition,
      orderedProjects,
      sidebarPreferences.projectOrder,
      updateSidebarPreferences,
    ],
  );

  const clearProjectDragState = useCallback(() => {
    setDraggedProjectId(null);
    setDropTargetProjectId(null);
    setDropTargetPosition(null);
  }, []);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        void handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [activeDraftThread, activeThread, handleNewThread, keybindings, projects]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse"
          : "text-amber-500 animate-pulse";
  const newThreadShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.newLocal") ??
      shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const searchShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "sidebar.search") ??
      (isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K"),
    [keybindings],
  );
  const searchPaletteProjects = useMemo<SidebarSearchProject[]>(
    () =>
      workspaceProjects.map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
      })),
    [workspaceProjects],
  );
  const searchPaletteFolderRoots = useMemo(
    () =>
      buildSidebarFolderRoots({
        homeDirectory,
        projects: searchPaletteProjects,
      }),
    [homeDirectory, searchPaletteProjects],
  );
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    if (!searchPaletteOpen) {
      return [];
    }
    return threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      projectName:
        thread.projectId === homeProjectId
          ? "Chats"
          : (projectById.get(thread.projectId)?.name ?? "Unknown project"),
      provider: getProviderFromModel(thread.model),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages.map((message) => ({
        text: message.text,
      })),
    }));
  }, [homeProjectId, projectById, searchPaletteOpen, threads]);
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "new-thread",
        label: "New chat",
        description: "Start a fresh standalone chat.",
        keywords: ["chat", "new"],
        shortcutLabel: newThreadShortcutLabel,
      },
      {
        id: "add-project",
        label: "Open folder",
        description: "Open a repository or folder in the sidebar.",
        keywords: ["folder", "repo", "repository", "open"],
      },
      {
        id: "clone-repository",
        label: "Clone git Repository",
        description: "Clone a Git repository into a new local folder.",
        keywords: ["clone", "git", "repo", "repository", "remote"],
      },
      {
        id: "settings",
        label: "Settings",
        description: "Open app settings.",
        keywords: ["preferences", "config"],
      },
    ],
    [newThreadShortcutLabel],
  );
  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      focusMostRecentThreadForProject(ProjectId.makeUnsafe(projectId));
    },
    [focusMostRecentThreadForProject],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const shouldShowProjectGroups = sidebarPreferences.threadOrganization === "by-project";

  const renderThreadRow = useCallback(
    (
      thread: Thread,
      options?: {
        projectLabel?: string | null;
        variant?: "flat" | "grouped";
        depth?: number;
        childThreadsByParentId?: ReadonlyMap<ThreadId, Thread[]>;
      },
    ) => {
      const depth = options?.depth ?? 0;
      const childThreads = options?.childThreadsByParentId?.get(thread.id) ?? [];
      const hasChildThreads = childThreads.length > 0;
      const isSubagentThread = Boolean(thread.parentThreadId);
      const isSubagentsExpanded = expandedSubagentParentIds.has(thread.id);
      const isActive = routeThreadId === thread.id;
      const isArchiveConfirmVisible = archiveConfirmThreadId === thread.id;
      const threadStatus = threadStatusPill(
        thread,
        pendingApprovalByThreadId.get(thread.id) === true,
        pendingUserInputByThreadId.get(thread.id) === true,
      );
      const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
      const terminalStatus = terminalStatusFromRunningIds(
        selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
      );
      const provider = getProviderFromModel(thread.model);
      const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(thread);
      const isDisposableThread =
        temporaryThreadIds[thread.id] === true ||
        draftThreadsByThreadId[thread.id]?.isTemporary === true;
      const timeLabel = formatRelativeTime(threadTimestamp(thread, sidebarPreferences.threadSort));
      const secondaryMetaClass = isActive ? "text-foreground/65" : "text-muted-foreground/45";
      const RowWrapper =
        options?.variant === "flat" && depth === 0 ? SidebarMenuItem : SidebarMenuSubItem;
      const leftPaddingPx = 48 + depth * 14;

      return (
        <Fragment key={thread.id}>
          <RowWrapper
            className="group/thread-row relative w-full"
            data-thread-item
            onMouseEnter={() => scheduleThreadDetailPrefetch(thread)}
            onMouseLeave={() => {
              cancelThreadDetailPrefetch(thread.id);
              clearArchiveConfirm(thread.id);
            }}
            onFocusCapture={() => {
              scheduleThreadDetailPrefetch(thread);
            }}
            onBlurCapture={(event: FocusEvent<HTMLElement>) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                return;
              }
              cancelThreadDetailPrefetch(thread.id);
              clearArchiveConfirm(thread.id);
            }}
          >
            <ThreadPinToggleButton
              pinned={thread.isPinned}
              presentation="overlay"
              toneClassName={secondaryMetaClass}
              onToggle={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearArchiveConfirm();
                void handleSetThreadPinned(thread.id, !thread.isPinned);
              }}
            />
            {threadStatus ? (
              <span
                className={cn(
                  "pointer-events-none absolute left-[9px] top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-opacity",
                  threadStatus.dotClass,
                  threadStatus.pulse ? "animate-pulse" : "",
                  thread.isPinned
                    ? "opacity-0"
                    : "opacity-100 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0",
                )}
              />
            ) : null}
            <SidebarMenuSubButton
              render={<div role="button" tabIndex={0} aria-label={thread.title} />}
              size="sm"
              isActive={isActive}
              data-testid={`sidebar-thread-${thread.id}`}
              className={cn(
                "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-lg pr-2 text-left text-[13px] transition-colors duration-150 hover:bg-accent/42 hover:text-foreground",
                isActive
                  ? "bg-accent/58 text-foreground/92 hover:bg-accent/68"
                  : "text-foreground/76",
              )}
              style={{ paddingLeft: `${leftPaddingPx}px` }}
              onClick={() => {
                clearArchiveConfirm();
                void navigate({
                  to: "/$threadId",
                  params: { threadId: thread.id },
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                clearArchiveConfirm();
                void navigate({
                  to: "/$threadId",
                  params: { threadId: thread.id },
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                clearArchiveConfirm();
                void handleThreadContextMenu(thread.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {hasChildThreads ? (
                  <button
                    type="button"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/65 transition-colors hover:text-foreground/85"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleSubagentParent(thread.id);
                    }}
                    aria-label={isSubagentsExpanded ? "Collapse subagents" : "Expand subagents"}
                  >
                    {isSubagentsExpanded ? (
                      <ChevronDownIcon className="size-3" />
                    ) : (
                      <ChevronRightIcon className="size-3" />
                    )}
                  </button>
                ) : null}
                {prStatus && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={prStatus.tooltip}
                          className={cn(
                            "inline-flex items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                            prStatus.colorClass,
                          )}
                          onClick={(event) => {
                            openPrLink(event, prStatus.url);
                          }}
                        >
                          <GitPullRequestIcon className="size-3" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                  </Tooltip>
                )}
                {thread.origin === "task" && !isSubagentThread ? (
                  <KanbanSquareIcon className="size-3 shrink-0 text-muted-foreground/60" />
                ) : null}
                {!isDisposableThread && handoffBadgeLabel && thread.handoff ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex shrink-0 items-center">
                          <HandoffProviderGlyph
                            sourceProvider={thread.handoff.sourceProvider}
                            targetProvider={provider}
                          />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{handoffBadgeLabel}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <ProviderGlyph provider={provider} />
                )}
                <div className="min-w-0 flex-1">
                  {renamingThreadId === thread.id ? (
                    <input
                      ref={(element) => {
                        if (element && renamingInputRef.current !== element) {
                          renamingInputRef.current = element;
                          element.focus();
                          element.select();
                        }
                      }}
                      className="min-w-0 w-full truncate rounded border border-ring bg-transparent px-1 py-0.5 text-xs outline-none"
                      value={renamingTitle}
                      onChange={(event) => setRenamingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          renamingCommittedRef.current = true;
                          void commitRename(thread.id, renamingTitle, thread.title);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          renamingCommittedRef.current = true;
                          cancelRename();
                        }
                      }}
                      onBlur={() => {
                        if (!renamingCommittedRef.current) {
                          void commitRename(thread.id, renamingTitle, thread.title);
                        }
                      }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : isSubagentThread ? (
                    <SidebarSubagentTitle thread={thread} />
                  ) : (
                    <span className="block truncate text-[13px] text-foreground/92">
                      {thread.title}
                    </span>
                  )}
                  {(options?.projectLabel || thread.origin === "task") && !isSubagentThread ? (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/65">
                      {[options?.projectLabel, thread.origin === "task" ? "From Orchestrate" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
                {!isDisposableThread && handoffBadgeLabel ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                          <FiGitBranch className="size-3" />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">{handoffBadgeLabel}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
              <div className="ml-2 flex shrink-0 items-center gap-2">
                {terminalStatus && (
                  <span
                    role="img"
                    aria-label={terminalStatus.label}
                    title={terminalStatus.label}
                    className={cn(
                      "inline-flex items-center justify-center",
                      terminalStatus.colorClass,
                    )}
                  >
                    <TerminalIcon
                      className={cn("size-3", terminalStatus.pulse ? "animate-pulse" : "")}
                    />
                  </span>
                )}
                {isDisposableThread ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                          <LuMessageCircleDashed className="size-3" />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">Disposable chat</TooltipPopup>
                  </Tooltip>
                ) : null}
                <span
                  className={cn(
                    "text-[12px] transition-all duration-150",
                    isArchiveConfirmVisible
                      ? "w-0 overflow-hidden opacity-0"
                      : "opacity-100 group-hover/thread-row:w-0 group-hover/thread-row:overflow-hidden group-hover/thread-row:opacity-0 group-focus-within/thread-row:w-0 group-focus-within/thread-row:overflow-hidden group-focus-within/thread-row:opacity-0",
                    secondaryMetaClass,
                  )}
                >
                  {timeLabel}
                </span>
                {isArchiveConfirmVisible ? (
                  <button
                    type="button"
                    data-testid={`sidebar-thread-archive-confirm-${thread.id}`}
                    aria-label={`Confirm archive ${thread.title}`}
                    title="Confirm archive"
                    className="inline-flex h-6 shrink-0 items-center rounded-full bg-destructive/14 px-2.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleInlineArchiveConfirm(thread.id);
                    }}
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`sidebar-thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    title="Archive chat"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-all duration-150 hover:bg-accent/70 hover:text-foreground group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setArchiveConfirmThreadId(thread.id);
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                )}
              </div>
            </SidebarMenuSubButton>
          </RowWrapper>
          {hasChildThreads && isSubagentsExpanded ? (
            <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0">
              {childThreads.map((childThread) =>
                renderThreadRow(childThread, {
                  ...options,
                  projectLabel: null,
                  depth: depth + 1,
                  ...(options?.childThreadsByParentId
                    ? { childThreadsByParentId: options.childThreadsByParentId }
                    : {}),
                }),
              )}
            </SidebarMenuSub>
          ) : null}
        </Fragment>
      );
    },
    [
      archiveConfirmThreadId,
      cancelRename,
      cancelThreadDetailPrefetch,
      clearArchiveConfirm,
      commitRename,
      handleInlineArchiveConfirm,
      handleThreadContextMenu,
      navigate,
      openPrLink,
      handleSetThreadPinned,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      prByThreadId,
      renamingThreadId,
      renamingTitle,
      routeThreadId,
      scheduleThreadDetailPrefetch,
      sidebarPreferences.threadSort,
      expandedSubagentParentIds,
      draftThreadsByThreadId,
      terminalStateByThreadId,
      temporaryThreadIds,
      toggleSubagentParent,
    ],
  );

  const renderProjectGroup = useCallback(
    (project: Project, projectThreads: readonly Thread[]) => {
      const showDropIndicatorBefore =
        dropTargetProjectId === project.id && dropTargetPosition === "before";
      const showDropIndicatorAfter =
        dropTargetProjectId === project.id && dropTargetPosition === "after";
      const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
      const { hasHiddenThreads, visibleThreads } = getVisibleThreadsForProject({
        threads: projectThreads,
        activeThreadId: routeThreadId ?? undefined,
        isThreadListExpanded,
        previewLimit: THREAD_PREVIEW_LIMIT,
      });
      const activeProjectThread = routeThreadId
        ? (projectThreads.find((thread) => thread.id === routeThreadId) ?? null)
        : null;
      const isActiveProject = activeProjectThread !== null;
      const childThreadsByParentId = new Map<ThreadId, Thread[]>();
      const topLevelThreads: Thread[] = [];
      const visibleThreadIds = new Set(visibleThreads.map((thread) => thread.id));
      for (const thread of visibleThreads) {
        if (thread.parentThreadId && visibleThreadIds.has(thread.parentThreadId)) {
          const existingChildren = childThreadsByParentId.get(thread.parentThreadId) ?? [];
          existingChildren.push(thread);
          childThreadsByParentId.set(thread.parentThreadId, existingChildren);
        } else {
          topLevelThreads.push(thread);
        }
      }
      const renderedThreads =
        !project.expanded && activeProjectThread ? [activeProjectThread] : topLevelThreads;
      const projectStatus = resolveProjectStatusIndicator(
        projectThreads.map((thread) =>
          threadStatusPill(
            thread,
            pendingApprovalByThreadId.get(thread.id) === true,
            pendingUserInputByThreadId.get(thread.id) === true,
          ),
        ),
      );
      const shouldShowProjectThreadRail = renderedThreads.length > 0 || hasHiddenThreads;
      const renderedThreadRowsForRail: Thread[] = [];
      const appendRenderedThreadRowsForRail = (rows: readonly Thread[]) => {
        for (const row of rows) {
          renderedThreadRowsForRail.push(row);
          if (!expandedSubagentParentIds.has(row.id)) {
            continue;
          }
          appendRenderedThreadRowsForRail(childThreadsByParentId.get(row.id) ?? []);
        }
      };
      appendRenderedThreadRowsForRail(renderedThreads);
      const selectedThreadRailIndex = routeThreadId
        ? renderedThreadRowsForRail.findIndex((thread) => thread.id === routeThreadId)
        : -1;
      const selectedThreadRailHeight =
        selectedThreadRailIndex >= 0
          ? PROJECT_THREAD_RAIL_TOP_PX +
            selectedThreadRailIndex * PROJECT_THREAD_RAIL_ROW_STEP_PX +
            PROJECT_THREAD_RAIL_SELECTED_ROW_CENTER_PX
          : 0;

      return (
        <Collapsible
          key={project.id}
          className="group/collapsible"
          open={project.expanded}
          onOpenChange={(open) => {
            if (open === project.expanded) return;
            toggleProject(project.id);
          }}
        >
          <SidebarMenuItem className="w-full">
            <div
              className={cn(
                "relative rounded-lg",
                draggedProjectId === project.id && "bg-accent/55 opacity-70",
              )}
            >
              {showDropIndicatorBefore ? (
                <div className="absolute inset-x-1 top-0 h-px bg-foreground/30" />
              ) : null}
              {showDropIndicatorAfter ? (
                <div className="absolute inset-x-1 bottom-0 h-px bg-foreground/30" />
              ) : null}
              <CollapsibleTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActiveProject}
                    className={cn(
                      "h-8 cursor-pointer gap-2 rounded-lg px-2.5 py-0.5 text-left text-[13px] font-normal transition-colors duration-150 hover:bg-accent/45",
                      isActiveProject
                        ? "relative bg-accent/54 text-foreground hover:bg-accent/64"
                        : project.expanded
                          ? "bg-background/35 text-foreground/88"
                          : "text-foreground/76",
                    )}
                    data-testid={`sidebar-project-${project.id}`}
                    draggable={shouldShowProjectGroups}
                    aria-label={project.name}
                  />
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleProjectContextMenu(project.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onDragStart={(event) => {
                  handleProjectDragStart(event, project.id);
                }}
                onDragOver={(event) => {
                  handleProjectDragOver(event, project.id);
                }}
                onDragEnd={clearProjectDragState}
                onDrop={(event) => {
                  event.preventDefault();
                  handleProjectDrop(project.id);
                }}
              >
                {isActiveProject ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground/35"
                  />
                ) : null}
                <span
                  className={cn(
                    "relative inline-flex size-4 shrink-0 items-center justify-center",
                    isActiveProject ? "text-foreground/78" : "text-muted-foreground/68",
                  )}
                >
                  <ProjectSidebarIcon cwd={project.cwd} expanded={project.expanded} />
                  {projectStatus ? (
                    <span
                      aria-hidden="true"
                      title={projectStatus.label}
                      className={cn(
                        "absolute -right-0.5 top-0.5 size-1.5 rounded-full",
                        projectStatus.dotClass,
                        projectStatus.pulse ? "animate-pulse" : "",
                      )}
                    />
                  ) : null}
                </span>
                <span className="flex-1 truncate font-system-ui text-[13px] font-normal text-current">
                  {project.name}
                </span>
              </CollapsibleTrigger>
              <SidebarMenuAction
                showOnHover
                aria-label={`New disposable thread in ${project.name}`}
                title={`New disposable thread in ${project.name}`}
                className="right-7.5 top-1.5 size-5 rounded-md p-0 text-muted-foreground/58 hover:bg-accent/60 hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleNewThread(project.id, { temporary: true });
                }}
              >
                <LuMessageCircleDashed className="size-3.5" />
              </SidebarMenuAction>
              <SidebarMenuAction
                showOnHover
                aria-label={`New thread in ${project.name}`}
                title={`New thread in ${project.name}`}
                data-testid={`sidebar-project-new-thread-${project.id}`}
                className="right-1.5 top-1.5 size-5 rounded-md p-0 text-muted-foreground/58 hover:bg-accent/60 hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleNewThread(project.id);
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            </div>
            <CollapsibleContent>
              <div className="relative">
                {shouldShowProjectThreadRail ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-1 left-[6px] top-1 z-10 w-0.5 rounded-full bg-muted-foreground/26"
                  />
                ) : null}
                {selectedThreadRailHeight > 0 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-[6px] top-1 z-10 w-0.5 rounded-full bg-foreground/48"
                    style={{ height: `${selectedThreadRailHeight}px` }}
                  />
                ) : null}
                <SidebarMenuSub className="relative mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0">
                  {renderedThreads.length > 0 ? (
                    renderedThreads.map((thread) =>
                      renderThreadRow(thread, { childThreadsByParentId }),
                    )
                  ) : (
                    <SidebarMenuSubItem className="w-full">
                      <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground/55">
                        No threads yet.
                      </div>
                    </SidebarMenuSubItem>
                  )}
                  {hasHiddenThreads && !isThreadListExpanded ? (
                    <SidebarMenuSubItem className="w-full">
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        size="sm"
                        data-thread-selection-safe
                        className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-12 text-left text-[13px] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                        onClick={() => {
                          expandThreadListForProject(project.id);
                        }}
                      >
                        <span>Show more</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : null}
                  {hasHiddenThreads && isThreadListExpanded ? (
                    <SidebarMenuSubItem className="w-full">
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        size="sm"
                        data-thread-selection-safe
                        className="h-7 w-full translate-x-0 justify-start rounded-lg pr-2 pl-12 text-left text-[13px] text-muted-foreground/72 hover:bg-accent/55 hover:text-foreground"
                        onClick={() => {
                          collapseThreadListForProject(project.id);
                        }}
                      >
                        <span>Show less</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : null}
                </SidebarMenuSub>
              </div>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      );
    },
    [
      clearProjectDragState,
      collapseThreadListForProject,
      draggedProjectId,
      dropTargetPosition,
      dropTargetProjectId,
      expandedSubagentParentIds,
      expandedThreadListsByProject,
      expandThreadListForProject,
      handleProjectContextMenu,
      handleProjectDragOver,
      handleProjectDragStart,
      handleProjectDrop,
      handleNewThread,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      renderThreadRow,
      routeThreadId,
      shouldShowProjectGroups,
      toggleProject,
    ],
  );

  const renderPinnedThreadRow = useCallback(
    (
      thread: Thread,
      options?: {
        depth?: number;
        childThreadsByParentId?: ReadonlyMap<ThreadId, Thread[]>;
      },
    ) => {
      const depth = options?.depth ?? 0;
      const childThreads = options?.childThreadsByParentId?.get(thread.id) ?? [];
      const hasChildThreads = childThreads.length > 0;
      const isSubagentThread = Boolean(thread.parentThreadId);
      const isSubagentsExpanded = expandedSubagentParentIds.has(thread.id);
      const isActive = routeThreadId === thread.id;
      const isArchiveConfirmVisible = archiveConfirmThreadId === thread.id;
      const provider = getProviderFromModel(thread.model);
      const timeLabel = formatRelativeTime(thread.pinnedAt ?? thread.updatedAt);
      const threadStatus = threadStatusPill(
        thread,
        pendingApprovalByThreadId.get(thread.id) === true,
        pendingUserInputByThreadId.get(thread.id) === true,
      );
      const statusDotClass = threadStatus?.dotClass ?? "bg-transparent";
      const leftPaddingPx = 48 + depth * 14;

      return (
        <Fragment key={`pinned:${thread.id}`}>
          <SidebarMenuItem
            className="group/pinned-thread relative w-full"
            data-thread-item
            onMouseEnter={() => scheduleThreadDetailPrefetch(thread)}
            onMouseLeave={() => {
              cancelThreadDetailPrefetch(thread.id);
              clearArchiveConfirm(thread.id);
            }}
            onFocusCapture={() => {
              scheduleThreadDetailPrefetch(thread);
            }}
            onBlurCapture={(event: FocusEvent<HTMLElement>) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                return;
              }
              cancelThreadDetailPrefetch(thread.id);
              clearArchiveConfirm(thread.id);
            }}
          >
            <ThreadPinToggleButton
              pinned={thread.isPinned}
              presentation="overlay"
              toneClassName={isActive ? "text-foreground/65" : "text-muted-foreground/45"}
              onToggle={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearArchiveConfirm();
                void handleSetThreadPinned(thread.id, false);
              }}
            />
            {threadStatus ? (
              <span
                className={cn(
                  "pointer-events-none absolute left-[9px] top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full transition-opacity",
                  statusDotClass,
                  threadStatus.pulse ? "animate-pulse" : "",
                  "opacity-100 group-hover/pinned-thread:opacity-0 group-focus-within/pinned-thread:opacity-0",
                )}
              />
            ) : null}
            <SidebarMenuButton
              render={<div role="button" tabIndex={0} aria-label={thread.title} />}
              size="sm"
              isActive={isActive}
              data-testid={`sidebar-pinned-thread-${thread.id}`}
              className={cn(
                "h-8 cursor-pointer gap-2 rounded-lg pr-2 text-left text-[13px] transition-colors duration-150 hover:bg-accent/42 hover:text-foreground",
                isActive
                  ? "bg-accent/58 text-foreground/92 hover:bg-accent/68"
                  : "text-foreground/76",
              )}
              style={{ paddingLeft: `${leftPaddingPx}px` }}
              onClick={() => {
                clearArchiveConfirm();
                void navigate({ to: "/$threadId", params: { threadId: thread.id } });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                clearArchiveConfirm();
                void navigate({ to: "/$threadId", params: { threadId: thread.id } });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                clearArchiveConfirm();
                void handleThreadContextMenu(thread.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {hasChildThreads ? (
                  <button
                    type="button"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/65 transition-colors hover:text-foreground/85"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleSubagentParent(thread.id);
                    }}
                    aria-label={isSubagentsExpanded ? "Collapse subagents" : "Expand subagents"}
                  >
                    {isSubagentsExpanded ? (
                      <ChevronDownIcon className="size-3" />
                    ) : (
                      <ChevronRightIcon className="size-3" />
                    )}
                  </button>
                ) : null}
                <ProviderGlyph provider={provider} />
                <div className="min-w-0 flex-1">
                  {isSubagentThread ? (
                    <SidebarSubagentTitle thread={thread} />
                  ) : (
                    <span className="block truncate text-[13px] text-foreground/92">
                      {thread.title}
                    </span>
                  )}
                </div>
              </div>
              <div className="ml-2 flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    "shrink-0 text-[12px] transition-all duration-150",
                    isActive ? "text-foreground/65" : "text-muted-foreground/45",
                    isArchiveConfirmVisible
                      ? "w-0 overflow-hidden opacity-0"
                      : "opacity-100 group-hover/pinned-thread:w-0 group-hover/pinned-thread:overflow-hidden group-hover/pinned-thread:opacity-0 group-focus-within/pinned-thread:w-0 group-focus-within/pinned-thread:overflow-hidden group-focus-within/pinned-thread:opacity-0",
                  )}
                >
                  {timeLabel}
                </span>
                {isArchiveConfirmVisible ? (
                  <button
                    type="button"
                    data-testid={`sidebar-thread-archive-confirm-${thread.id}`}
                    aria-label={`Confirm archive ${thread.title}`}
                    title="Confirm archive"
                    className="inline-flex h-6 shrink-0 items-center rounded-full bg-destructive/14 px-2.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleInlineArchiveConfirm(thread.id);
                    }}
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`sidebar-thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    title="Archive chat"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-all duration-150 hover:bg-accent/70 hover:text-foreground group-hover/pinned-thread:opacity-100 group-focus-within/pinned-thread:opacity-100"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setArchiveConfirmThreadId(thread.id);
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                )}
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {hasChildThreads && isSubagentsExpanded ? (
            <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0">
              {childThreads.map((childThread) =>
                renderPinnedThreadRow(childThread, {
                  depth: depth + 1,
                  ...(options?.childThreadsByParentId
                    ? { childThreadsByParentId: options.childThreadsByParentId }
                    : {}),
                }),
              )}
            </SidebarMenuSub>
          ) : null}
        </Fragment>
      );
    },
    [
      archiveConfirmThreadId,
      cancelThreadDetailPrefetch,
      clearArchiveConfirm,
      handleInlineArchiveConfirm,
      expandedSubagentParentIds,
      handleSetThreadPinned,
      handleThreadContextMenu,
      navigate,
      pendingApprovalByThreadId,
      pendingUserInputByThreadId,
      routeThreadId,
      scheduleThreadDetailPrefetch,
      toggleSubagentParent,
    ],
  );

  const shouldShowNoProjectsState =
    threadsHydrated && orderedProjects.length === 0 && !hydrationError;
  const shouldShowNoRelevantThreadsState =
    (orderedProjects.length > 0 || homeProject !== null) &&
    filteredThreads.length === 0 &&
    sidebarPreferences.threadShow === "relevant";
  const threadsSectionTitle =
    sidebarPreferences.threadShow === "relevant"
      ? shouldShowProjectGroups
        ? "Projects"
        : "Relevant threads"
      : shouldShowProjectGroups
        ? "Projects"
        : "Threads";
  const sidebarTopHeaderClassName = cn(
    "px-4 py-0",
    showDesktopUpdateButton ? "h-[var(--app-desktop-content-header-height)]" : "h-0",
  );

  return (
    <>
      {isElectron ? (
        <SidebarHeader className={sidebarTopHeaderClassName} data-testid="sidebar-top-header">
          <div className="flex h-full items-center justify-end gap-2">
            {showDesktopUpdateButton ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={cn(
                        "ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors [-webkit-app-region:no-drag]",
                        desktopUpdateButtonInteractivityClasses,
                        desktopUpdateButtonClasses,
                      )}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </SidebarHeader>
      ) : (
        <SidebarHeader className={sidebarTopHeaderClassName} data-testid="sidebar-top-header" />
      )}

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-sidebar="content"
        data-slot="sidebar-content"
      >
        <SidebarGroup className="shrink-0 px-3 pb-2 pt-2">
          <SidebarMenu className="gap-1.5">
            {PRIMARY_NAV_ITEMS.map(({ icon: Icon, label, action, testId }) => {
              const isNewThreadAction = action === "new-thread";
              const isActive =
                (action === "orchestrate" && pathname === "/orchestrate") ||
                (action === "plugins" && pathname === "/plugins") ||
                (action === "skills" && pathname === "/skills");

              return (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton
                    render={<button type="button" data-testid={testId} />}
                    size="default"
                    isActive={isActive}
                    className={cn(
                      "h-9 cursor-pointer gap-2.5 rounded-lg px-3 text-[14px] font-normal transition-colors duration-150",
                      isNewThreadAction
                        ? "border border-border/35 bg-foreground/[0.055] text-foreground hover:bg-foreground/[0.085]"
                        : isActive
                          ? "bg-accent/62 text-foreground hover:bg-accent/72"
                          : "text-muted-foreground/82 hover:bg-accent/45 hover:text-foreground",
                    )}
                    onClick={() => {
                      if (action === "placeholder") {
                        handlePlaceholderNavClick(label);
                        return;
                      }
                      if (action === "orchestrate") {
                        handleOpenOrchestrate();
                        return;
                      }
                      if (action === "plugins" || action === "skills") {
                        void navigate({ to: action === "plugins" ? "/plugins" : "/skills" });
                        return;
                      }
                      handlePrimaryNewThread();
                    }}
                    title={
                      label === "New chat" && newThreadShortcutLabel
                        ? `New chat (${newThreadShortcutLabel})`
                        : label
                    }
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        isNewThreadAction || isActive
                          ? "text-foreground/78"
                          : "text-muted-foreground/62",
                      )}
                    />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-4">
          <SidebarSectionHeading
            actions={
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className={SIDEBAR_HEADER_ACTION_CLASS}
                        aria-label="Search chats"
                        data-testid="sidebar-search-chats"
                        onClick={() => {
                          openSearchPalette("search");
                        }}
                      >
                        <SearchIcon className="size-4" />
                      </button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {searchShortcutLabel ? `Search chats (${searchShortcutLabel})` : "Search chats"}
                  </TooltipPopup>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className={SIDEBAR_HEADER_ACTION_CLASS}
                        aria-label="Add project"
                        data-testid="sidebar-add-project"
                        onClick={() => {
                          openSearchPalette("folder");
                        }}
                      >
                        <TbFolderPlus className="size-4" />
                      </button>
                    }
                  />
                  <TooltipPopup side="bottom">Add project</TooltipPopup>
                </Tooltip>

                {shouldShowProjectGroups && workspaceProjects.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={
                            allProjectsExpanded
                              ? focusedProjectId
                                ? "Collapse all projects except the active project"
                                : "Collapse all projects"
                              : "Expand all projects"
                          }
                          className={cn(
                            SIDEBAR_HEADER_ACTION_CLASS,
                            "disabled:cursor-default disabled:opacity-45",
                          )}
                          onClick={handleToggleProjects}
                        >
                          {allProjectsExpanded ? (
                            <TbArrowsDiagonalMinimize2 className="size-4" />
                          ) : (
                            <TbArrowsDiagonal className="size-4" />
                          )}
                        </button>
                      }
                    >
                      {allProjectsExpanded ? (
                        <TbArrowsDiagonalMinimize2 className="size-4" />
                      ) : (
                        <TbArrowsDiagonal className="size-4" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">
                      {allProjectsExpanded
                        ? focusedProjectId
                          ? "Collapse all projects except the active thread's project"
                          : "Collapse all projects"
                        : "Expand all projects"}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}

                <Menu>
                  <MenuTrigger
                    className={SIDEBAR_HEADER_ACTION_CLASS}
                    aria-label="Filter threads"
                    data-testid="sidebar-filter-threads"
                  >
                    <IoFilter className="size-4" />
                  </MenuTrigger>
                  <MenuPopup
                    side="bottom"
                    align="end"
                    sideOffset={8}
                    className="w-[198px] rounded-[16px] border border-border/70 bg-popover/98 shadow-[0_16px_40px_rgba(0,0,0,0.14)]"
                  >
                    <MenuGroup>
                      <MenuGroupLabel className="px-3 py-2 text-[12px] font-medium text-muted-foreground/75">
                        Organize
                      </MenuGroupLabel>
                      <MenuRadioGroup
                        value={sidebarPreferences.threadOrganization}
                        onValueChange={handleThreadOrganizationChange}
                      >
                        <MenuRadioItem
                          value="by-project"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <FolderIcon className="size-4 text-muted-foreground/75" />
                          <span>By project</span>
                        </MenuRadioItem>
                        <MenuRadioItem
                          value="chronological"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <Clock3Icon className="size-4 text-muted-foreground/75" />
                          <span>Chronological list</span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator className="mx-3 my-1.5" />
                    <MenuGroup>
                      <MenuGroupLabel className="px-3 py-2 text-[12px] font-medium text-muted-foreground/75">
                        Sort by
                      </MenuGroupLabel>
                      <MenuRadioGroup
                        value={sidebarPreferences.threadSort}
                        onValueChange={handleThreadSortChange}
                      >
                        <MenuRadioItem
                          value="created"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <SquarePenIcon className="size-4 text-muted-foreground/75" />
                          <span>Created</span>
                        </MenuRadioItem>
                        <MenuRadioItem
                          value="updated"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <ExternalLinkIcon className="size-4 text-muted-foreground/75" />
                          <span>Updated</span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator className="mx-3 my-1.5" />
                    <MenuGroup>
                      <MenuGroupLabel className="px-3 py-2 text-[12px] font-medium text-muted-foreground/75">
                        Show
                      </MenuGroupLabel>
                      <MenuRadioGroup
                        value={sidebarPreferences.threadShow}
                        onValueChange={handleThreadShowChange}
                      >
                        <MenuRadioItem
                          value="all"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <HistoryIcon className="size-4 text-muted-foreground/75" />
                          <span>All threads</span>
                        </MenuRadioItem>
                        <MenuRadioItem
                          value="relevant"
                          indicatorPlacement="end"
                          className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                        >
                          <PinIcon className="size-4 text-muted-foreground/75" />
                          <span>Relevant</span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
              </>
            }
          >
            <button
              type="button"
              className={SIDEBAR_SECTION_TOGGLE_CLASS}
              aria-expanded={projectsSectionExpanded}
              aria-label={projectsSectionExpanded ? "Collapse projects" : "Expand projects"}
              onClick={() => {
                setProjectsSectionExpanded((expanded) => !expanded);
              }}
            >
              <span>Projects</span>
              {projectsSectionExpanded ? (
                <ChevronDownIcon className="size-3.5 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-3.5 shrink-0" />
              )}
            </button>
          </SidebarSectionHeading>

          <ScrollArea
            className="min-h-0 flex-1 **:data-[slot=scroll-area-scrollbar]:hidden"
            scrollFade
          >
            <div className="flex min-h-full flex-col pb-1">
              {pinnedThreadHierarchy.topLevelThreads.length > 0 ? (
                <>
                  <div className={SIDEBAR_SUBSECTION_HEADING_CLASS}>Pinned</div>
                  <SidebarMenu className="gap-1 pb-4">
                    {pinnedThreadHierarchy.topLevelThreads.map((thread) =>
                      renderPinnedThreadRow(thread, {
                        childThreadsByParentId: pinnedThreadHierarchy.childThreadsByParentId,
                      }),
                    )}
                  </SidebarMenu>
                </>
              ) : null}

              {shouldShowProjectGroups ? (
                <>
                  {projectsSectionExpanded ? (
                    <SidebarMenu className="gap-1">
                      {groupedProjects.map((group) =>
                        renderProjectGroup(group.project, group.threads),
                      )}
                    </SidebarMenu>
                  ) : null}
                  <div
                    className={cn(SIDEBAR_SUBSECTION_HEADING_CLASS, "flex items-center gap-2 pt-5")}
                  >
                    <button
                      type="button"
                      className={SIDEBAR_SECTION_TOGGLE_CLASS}
                      aria-expanded={chatsSectionExpanded}
                      aria-label={chatsSectionExpanded ? "Collapse chats" : "Expand chats"}
                      onClick={() => {
                        setChatsSectionExpanded((expanded) => !expanded);
                      }}
                    >
                      <span>Chats</span>
                      {chatsSectionExpanded ? (
                        <ChevronDownIcon className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronRightIcon className="size-3.5 shrink-0" />
                      )}
                    </button>
                    <div className="-mr-1 flex items-center gap-0.5 rounded-lg bg-background/25 p-0.5 ring-1 ring-border/30">
                      <Menu>
                        <MenuTrigger
                          className={SIDEBAR_HEADER_ACTION_CLASS}
                          aria-label="Sort chats"
                          data-testid="sidebar-sort-chats"
                        >
                          <IoFilter className="size-4" />
                        </MenuTrigger>
                        <MenuPopup
                          side="bottom"
                          align="end"
                          sideOffset={8}
                          className="w-[178px] rounded-[16px] border border-border/70 bg-popover/98 shadow-[0_16px_40px_rgba(0,0,0,0.14)]"
                        >
                          <MenuGroup>
                            <MenuGroupLabel className="px-3 py-2 text-[12px] font-medium text-muted-foreground/75">
                              Sort by
                            </MenuGroupLabel>
                            <MenuRadioGroup
                              value={sidebarPreferences.threadSort}
                              onValueChange={handleThreadSortChange}
                            >
                              <MenuRadioItem
                                value="created"
                                indicatorPlacement="end"
                                className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                              >
                                <SquarePenIcon className="size-4 text-muted-foreground/75" />
                                <span>Created</span>
                              </MenuRadioItem>
                              <MenuRadioItem
                                value="updated"
                                indicatorPlacement="end"
                                className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                              >
                                <ExternalLinkIcon className="size-4 text-muted-foreground/75" />
                                <span>Updated</span>
                              </MenuRadioItem>
                            </MenuRadioGroup>
                          </MenuGroup>
                          <MenuSeparator className="mx-3 my-1.5" />
                          <MenuGroup>
                            <MenuGroupLabel className="px-3 py-2 text-[12px] font-medium text-muted-foreground/75">
                              Show
                            </MenuGroupLabel>
                            <MenuRadioGroup
                              value={sidebarPreferences.threadShow}
                              onValueChange={handleThreadShowChange}
                            >
                              <MenuRadioItem
                                value="all"
                                indicatorPlacement="end"
                                className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                              >
                                <HistoryIcon className="size-4 text-muted-foreground/75" />
                                <span>All chats</span>
                              </MenuRadioItem>
                              <MenuRadioItem
                                value="relevant"
                                indicatorPlacement="end"
                                className="min-h-9 gap-2.5 rounded-md px-3 py-1.5 text-[13px]"
                              >
                                <PinIcon className="size-4 text-muted-foreground/75" />
                                <span>Relevant</span>
                              </MenuRadioItem>
                            </MenuRadioGroup>
                          </MenuGroup>
                        </MenuPopup>
                      </Menu>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className={SIDEBAR_HEADER_ACTION_CLASS}
                              aria-label="New chat"
                              data-testid="sidebar-chats-new-chat"
                              onClick={handlePrimaryNewThread}
                            >
                              <SquarePenIcon className="size-4" />
                            </button>
                          }
                        />
                        <TooltipPopup side="bottom">
                          {newThreadShortcutLabel
                            ? `New chat (${newThreadShortcutLabel})`
                            : "New chat"}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  </div>
                  {chatsSectionExpanded ? (
                    <SidebarMenu className="gap-1">
                      {homeProject && homeThreadHierarchy.topLevelThreads.length > 0 ? (
                        homeThreadHierarchy.topLevelThreads.map((thread) =>
                          renderThreadRow(thread, {
                            variant: "flat",
                            childThreadsByParentId: homeThreadHierarchy.childThreadsByParentId,
                          }),
                        )
                      ) : (
                        <SidebarMenuItem className="w-full">
                          <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground/55">
                            No chats yet.
                          </div>
                        </SidebarMenuItem>
                      )}
                    </SidebarMenu>
                  ) : null}
                </>
              ) : (
                <SidebarMenu className="gap-1">
                  {chronologicalThreadChildren.topLevelThreads.map((thread) =>
                    renderThreadRow(thread, {
                      projectLabel:
                        thread.projectId === homeProjectId
                          ? "Chats"
                          : (projectById.get(thread.projectId)?.name ?? null),
                      variant: "flat",
                      childThreadsByParentId: chronologicalThreadChildren.childThreadsByParentId,
                    }),
                  )}
                </SidebarMenu>
              )}

              {shouldShowNoProjectsState && projectsSectionExpanded ? (
                <div className="px-2.5 pt-3 text-sm text-muted-foreground/60">
                  No projects yet. Add one to get started.
                </div>
              ) : null}

              {!threadsHydrated && hydrationError ? (
                <div className="px-2.5 pt-3 text-sm text-rose-500/75">
                  Workspace restore failed. Restart the app or check the server logs.
                </div>
              ) : null}

              {!threadsHydrated && !hydrationError ? <SidebarHydrationSkeleton /> : null}

              {shouldShowNoRelevantThreadsState ? (
                <div className="px-2.5 pt-3 text-sm text-muted-foreground/60">
                  No relevant threads to show.
                </div>
              ) : null}
            </div>
          </ScrollArea>

          <div className="sr-only" aria-live="polite">
            {threadsSectionTitle}
          </div>
        </SidebarGroup>
      </div>

      <SidebarFooter className="gap-2 border-t border-border/35 bg-background/20 p-3">
        <SidebarSettingsPopover
          pathname={pathname}
          accountSummary={codexAccountSummary}
          open={settingsPopoverOpen}
          startingLogin={startProviderLoginMutation.isPending}
          cancelingLogin={cancelProviderLoginMutation.isPending}
          loggingOut={logoutProviderMutation.isPending}
          onOpenChange={setSettingsPopoverOpen}
          onNavigateToSettings={handleNavigateToSettings}
          onStartLogin={handleStartProviderLogin}
          onContinueLogin={handleContinueProviderLogin}
          onCancelLogin={handleCancelProviderLogin}
          onLogout={handleLogoutProvider}
        />
      </SidebarFooter>

      <SidebarSearchPalette
        open={searchPaletteOpen}
        onOpenChange={handleSearchPaletteOpenChange}
        mode={searchPaletteMode}
        onModeChange={setSearchPaletteMode}
        actions={searchPaletteActions}
        projects={searchPaletteProjects}
        threads={searchPaletteThreads}
        folderRoots={searchPaletteFolderRoots}
        onCreateThread={handlePrimaryNewThread}
        onAddProject={() => {
          openSearchPalette("folder");
        }}
        onCloneRepository={async ({ repositoryUrl, directoryName, parentDirectory }) => {
          const api = readNativeApi();
          if (!api) {
            throw new Error("Native API is unavailable.");
          }

          return api.git.clone({
            repositoryUrl,
            parentDirectory,
            directoryName,
          });
        }}
        onAddProjectFromPath={addProjectFromPath}
        onListDirectory={async (cwd) => {
          const api = readNativeApi();
          if (!api) {
            throw new Error("Native API is unavailable.");
          }
          return api.projects.listDirectory({
            cwd,
            relativePath: null,
          });
        }}
        onOpenSettings={() => {
          void navigate({
            to: "/settings",
            search: { section: SETTINGS_SECTION_IDS.appearance },
          });
        }}
        onOpenProject={handleOpenProjectFromSearch}
        onOpenThread={(threadId) => {
          void navigate({
            to: "/$threadId",
            params: { threadId: ThreadId.makeUnsafe(threadId) },
          });
        }}
      />
    </>
  );
}
