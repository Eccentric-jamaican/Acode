import {
  BlocksIcon,
  BriefcaseBusinessIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  CircleUserRoundIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderPlusIcon,
  GaugeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  KanbanSquareIcon,
  LayoutGridIcon,
  LoaderCircleIcon,
  LogOutIcon,
  LucideIcon,
  ListFilterIcon,
  PinIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
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
import { cn, newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { type Project, type Thread } from "../types";
import { derivePendingApprovals } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  buildChronologicalThreadList,
  groupThreadsByProject,
  isRelevantThread,
  orderProjectsForSidebar,
  pruneMissingProjectIds,
  threadTimestamp,
} from "../sidebarModel";
import {
  reorderProjectOrder,
  useSidebarPreferences,
} from "../sidebarPreferences";
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
import { OpenAI, OpenCodeIcon } from "./Icons";
import type { ProviderKind } from "@t3tools/contracts";

function getProviderFromModel(model: string): ProviderKind {
  // OpenCode models have the format "provider/model" (e.g., "opencode-go/minimax-m2.5")
  if (model.includes("/")) {
    return "opencode";
  }
  // Default to codex for models without a slash (e.g., "gpt-5.4", "gpt-5.4-mini")
  return "codex";
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, React.FC<React.SVGProps<SVGSVGElement>>> = {
  codex: OpenAI,
  opencode: OpenCodeIcon,
};

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
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
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
    const remainingPercents = [getRemainingPercent(bucket.primary), getRemainingPercent(bucket.secondary)];
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
          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150",
          pathname === "/settings"
            ? "bg-accent text-foreground"
            : "hover:bg-accent/60 hover:text-foreground",
        )}
      >
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
                              <span>{bucket.limitName ?? bucket.limitId ?? `Rate limit ${index + 1}`}</span>
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
                      onClick={() => void openExternalLink("https://help.openai.com/en/articles/9824962-openai-codex-cli-getting-started")}
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
            <button
              type="button"
              className={rowClass}
              disabled={loggingOut}
              onClick={onLogout}
            >
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
  label: "Working" | "Connecting" | "Completed" | "Pending Approval";
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

function hasUnseenCompletion(thread: Thread): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function threadStatusPill(thread: Thread, hasPendingApprovals: boolean): ThreadStatusPill | null {
  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
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
  action: "new-thread" | "placeholder" | "orchestrate";
  testId: string;
}> = [
  {
    icon: SquarePenIcon,
    label: "New thread",
    action: "new-thread",
    testId: "sidebar-primary-new-thread",
  },
  {
    icon: Clock3Icon ?? HistoryIcon,
    label: "Automations",
    action: "placeholder",
    testId: "sidebar-primary-automations",
  },
  {
    icon: BlocksIcon ?? LayoutGridIcon,
    label: "Skills",
    action: "placeholder",
    testId: "sidebar-primary-skills",
  },
  {
    icon: LayoutGridIcon,
    label: "Plugins",
    action: "placeholder",
    testId: "sidebar-primary-plugins",
  },
  {
    icon: KanbanSquareIcon ?? BriefcaseBusinessIcon,
    label: "Orchestrate",
    action: "orchestrate",
    testId: "sidebar-primary-orchestrate",
  },
];

function SidebarSectionHeading({
  children,
  actions,
}: {
  children: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 pb-3 text-[13px] text-muted-foreground/80">
      <span className="flex-1">{children}</span>
      {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
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
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
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
  const navigate = useNavigate();
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
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<ProjectId | null>(null);
  const [dropTargetProjectId, setDropTargetProjectId] = useState<ProjectId | null>(null);
  const [dropTargetPosition, setDropTargetPosition] = useState<"before" | "after" | null>(null);
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
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const activeThread = useMemo(
    () => (routeThreadId ? threads.find((thread) => thread.id === routeThreadId) ?? null : null),
    [routeThreadId, threads],
  );
  const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
  const orderedProjects = useMemo(
    () => orderProjectsForSidebar(projects, sidebarPreferences.projectOrder),
    [projects, sidebarPreferences.projectOrder],
  );
  const filteredThreads = useMemo(() => {
    if (sidebarPreferences.threadShow === "all") {
      return threads;
    }

    return threads.filter((thread) =>
      isRelevantThread(thread, {
        hasPendingApproval: pendingApprovalByThreadId.get(thread.id) === true,
        isActive: routeThreadId === thread.id,
      }),
    );
  }, [pendingApprovalByThreadId, routeThreadId, sidebarPreferences.threadShow, threads]);
  const visibleProjectIds = useMemo(
    () => new Set(filteredThreads.map((thread) => thread.projectId)),
    [filteredThreads],
  );
  const groupedProjects = useMemo(() => {
    const groups = groupThreadsByProject(orderedProjects, filteredThreads, {
      threadSort: sidebarPreferences.threadSort,
    });
    if (sidebarPreferences.threadShow === "relevant") {
      return groups.filter((group) => group.threads.length > 0);
    }
    return groups;
  }, [
    filteredThreads,
    orderedProjects,
    sidebarPreferences.threadShow,
    sidebarPreferences.threadSort,
  ]);
  const chronologicalThreads = useMemo(
    () =>
      buildChronologicalThreadList(filteredThreads, {
        threadSort: sidebarPreferences.threadSort,
      }),
    [filteredThreads, sidebarPreferences.threadSort],
  );
  const firstVisibleProjectId = useMemo(
    () =>
      orderedProjects.find(
        (project) =>
          sidebarPreferences.threadShow === "all" || visibleProjectIds.has(project.id),
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
      projects,
    );
    if (prunedProjectOrder.length === sidebarPreferences.projectOrder.length) {
      return;
    }
    updateSidebarPreferences((currentPreferences) => ({
      ...currentPreferences,
      projectOrder: prunedProjectOrder,
    }));
  }, [projects, sidebarPreferences.projectOrder, threadsHydrated, updateSidebarPreferences]);

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
    void navigate({ to: "/settings" });
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
      },
    ): Promise<void> => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
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

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
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
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });

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
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description: "Native API is unavailable.",
        });
        return;
      }

      setIsAddingProject(true);
      const finishAddingProject = (options?: { closeComposer?: boolean }) => {
        setIsAddingProject(false);
        if (options?.closeComposer ?? true) {
          setNewCwd("");
          setAddingProject(false);
        }
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
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
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description: getErrorMessage(
            error,
            "The project could not be created. Check that the app is connected and try again.",
          ),
        });
        finishAddingProject({ closeComposer: false });
      }
    },
    [focusMostRecentThreadForProject, handleNewThread, isAddingProject, projects],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    }
    setIsPickingFolder(false);
  }, [addProjectFromPath, isPickingFolder]);

  const handlePrimaryNewThread = useCallback(() => {
    const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? firstVisibleProjectId;
    if (!projectId) {
      setAddingProject(true);
      return;
    }

    void handleNewThread(projectId);
  }, [activeDraftThread, activeThread, firstVisibleProjectId, handleNewThread]);

  const handleOpenOrchestrate = useCallback(() => {
    const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? firstVisibleProjectId;
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

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

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
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: isPinned ? "Failed to pin thread" : "Failed to unpin thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, []);

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      const clicked = await api.contextMenu.show(
        [
          ...(thread.taskId ? [{ id: "open-task", label: "Open task" }] : []),
          { id: "rename", label: "Rename thread" },
          {
            id: thread.isPinned ? "unpin" : "pin",
            label: thread.isPinned ? "Unpin thread" : "Pin thread",
          },
          { id: "mark-unread", label: "Mark unread" },
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
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
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

      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = threads.find((entry) => entry.id !== threadId)?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
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
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      handleSetThreadPinned,
      markThreadUnread,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Delete", destructive: true }],
        position,
      );
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before deleting it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      try {
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
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
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      projects,
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
      },
    ) => {
      const isActive = routeThreadId === thread.id;
      const threadStatus = threadStatusPill(
        thread,
        pendingApprovalByThreadId.get(thread.id) === true,
      );
      const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
      const terminalStatus = terminalStatusFromRunningIds(
        selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
      );
      const timeLabel = formatRelativeTime(threadTimestamp(thread, sidebarPreferences.threadSort));
      const RowWrapper = options?.variant === "flat" ? SidebarMenuItem : SidebarMenuSubItem;

      return (
        <RowWrapper key={thread.id} className="w-full">
          <SidebarMenuSubButton
            render={<div role="button" tabIndex={0} aria-label={thread.title} />}
            size="sm"
            isActive={isActive}
            data-testid={`sidebar-thread-${thread.id}`}
            className={cn(
              "min-h-8 w-full translate-x-0 cursor-default justify-start rounded-md px-2.5 py-1.5 text-left hover:bg-accent/75 hover:text-foreground",
              isActive
                ? "bg-accent/85 text-foreground font-medium ring-1 ring-border/70"
                : "text-muted-foreground",
            )}
            onClick={() => {
              void navigate({
                to: "/$threadId",
                params: { threadId: thread.id },
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void navigate({
                to: "/$threadId",
                params: { threadId: thread.id },
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleThreadContextMenu(thread.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
              {threadStatus && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[10px]",
                    threadStatus.colorClass,
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      threadStatus.dotClass,
                      threadStatus.pulse ? "animate-pulse" : "",
                    )}
                  />
                  <span className="hidden md:inline">{threadStatus.label}</span>
                </span>
              )}
              {thread.origin === "task" ? (
                <KanbanSquareIcon className="size-3 shrink-0 text-muted-foreground/60" />
              ) : null}
              {thread.isPinned && <PinIcon className="size-3 shrink-0 text-muted-foreground/60" />}
              {(() => {
                const provider = getProviderFromModel(thread.model);
                const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];
                return (
                  <ProviderIcon
                    className="size-3 shrink-0 text-muted-foreground/70"
                    aria-label={`${provider} provider`}
                  />
                );
              })()}
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
                ) : (
                  <span className="block truncate text-[13px] text-foreground/92">{thread.title}</span>
                )}
                {options?.projectLabel || thread.origin === "task" ? (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/65">
                    {[options?.projectLabel, thread.origin === "task" ? "From Orchestrate" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
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
              <span
                className={cn(
                  "text-[10px]",
                  isActive ? "text-foreground/65" : "text-muted-foreground/45",
                )}
              >
                {timeLabel}
              </span>
            </div>
          </SidebarMenuSubButton>
        </RowWrapper>
      );
    },
    [
      cancelRename,
      commitRename,
      handleThreadContextMenu,
      navigate,
      openPrLink,
      pendingApprovalByThreadId,
      prByThreadId,
      renamingThreadId,
      renamingTitle,
      routeThreadId,
      sidebarPreferences.threadSort,
      terminalStateByThreadId,
    ],
  );

  const renderProjectGroup = useCallback(
    (project: Project, projectThreads: readonly Thread[]) => {
      const showDropIndicatorBefore =
        dropTargetProjectId === project.id && dropTargetPosition === "before";
      const showDropIndicatorAfter =
        dropTargetProjectId === project.id && dropTargetPosition === "after";

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
                "relative rounded-md",
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
                    className="h-8 gap-2 rounded-md px-2.5 text-left text-[13px] text-foreground/88 hover:bg-accent/70"
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
                <ChevronRightIcon
                  className={cn(
                    "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
                    project.expanded ? "rotate-90" : "",
                  )}
                />
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <span className="flex-1 truncate">{project.name}</span>
              </CollapsibleTrigger>
              <SidebarMenuAction
                showOnHover
                aria-label={`New thread in ${project.name}`}
                title={`New thread in ${project.name}`}
                data-testid={`sidebar-project-new-thread-${project.id}`}
                className="right-1.5 top-1.5 text-muted-foreground/70 hover:bg-accent/80 hover:text-foreground"
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
              <SidebarMenuSub className="mx-0 mt-1 border-l border-border/60 px-0 py-0 pl-4">
                {projectThreads.length > 0 ? (
                  projectThreads.map((thread) => renderThreadRow(thread))
                ) : (
                  <SidebarMenuSubItem className="w-full">
                    <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground/55">
                      No threads yet.
                    </div>
                  </SidebarMenuSubItem>
                )}
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      );
    },
    [
      clearProjectDragState,
      draggedProjectId,
      dropTargetPosition,
      dropTargetProjectId,
      handleProjectContextMenu,
      handleProjectDragOver,
      handleProjectDragStart,
      handleProjectDrop,
      handleNewThread,
      renderThreadRow,
      shouldShowProjectGroups,
      toggleProject,
    ],
  );

  const shouldShowNoProjectsState = orderedProjects.length === 0;
  const shouldShowNoRelevantThreadsState =
    orderedProjects.length > 0 &&
    filteredThreads.length === 0 &&
    sidebarPreferences.threadShow === "relevant";
  const threadsSectionTitle =
    sidebarPreferences.threadShow === "relevant" ? "Relevant threads" : "Threads";

  return (
    <>
      {isElectron ? (
        <SidebarHeader
          className="h-[var(--app-desktop-content-header-height)] px-4 py-0"
          data-testid="sidebar-top-header"
        >
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
        <SidebarHeader
          className="h-[var(--app-desktop-content-header-height)] px-4 py-0"
          data-testid="sidebar-top-header"
        />
      )}

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-sidebar="content"
        data-slot="sidebar-content"
      >
        <SidebarGroup className="shrink-0 px-3 pb-2 pt-1">
          <SidebarMenu className="gap-1.5">
            {PRIMARY_NAV_ITEMS.map(({ icon: Icon, label, action, testId }) => (
              <SidebarMenuItem key={label}>
                <SidebarMenuButton
                  render={<button type="button" data-testid={testId} />}
                  size="default"
                  isActive={action === "orchestrate" && pathname === "/orchestrate"}
                  className="h-9 gap-3 rounded-md px-3 text-[14px] font-normal text-foreground/85 hover:bg-accent/70 data-[active=true]:bg-accent/70 data-[active=true]:text-foreground"
                  onClick={() => {
                    if (action === "placeholder") {
                      handlePlaceholderNavClick(label);
                      return;
                    }
                    if (action === "orchestrate") {
                      handleOpenOrchestrate();
                      return;
                    }
                    handlePrimaryNewThread();
                  }}
                  title={
                    label === "New thread" && newThreadShortcutLabel
                      ? `New thread (${newThreadShortcutLabel})`
                      : label
                  }
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground/80" />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-4">
          <SidebarSectionHeading
            actions={
              <>
                <Popover onOpenChange={setAddingProject} open={addingProject}>
                  <PopoverTrigger
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground"
                    aria-label="Add project"
                    data-testid="sidebar-add-project"
                  >
                    <FolderPlusIcon className="size-4" />
                  </PopoverTrigger>
                  <PopoverPopup
                    side="bottom"
                    align="end"
                    sideOffset={8}
                    className="w-[280px] rounded-[14px] border border-border/70 bg-popover/98 p-0 shadow-[0_16px_40px_rgba(0,0,0,0.14)] backdrop-blur-sm"
                  >
                    <div className="-mx-4 -my-4 px-4 py-4">
                      <p className="mb-3 text-[12px] text-muted-foreground/80">Add project</p>
                      <input
                        autoFocus
                        className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none"
                        placeholder="/path/to/project"
                        value={newCwd}
                        onChange={(event) => setNewCwd(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleAddProject();
                          if (event.key === "Escape") setAddingProject(false);
                        }}
                      />
                      {isElectron ? (
                        <button
                          type="button"
                          className="mb-2 flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void handlePickFolder()}
                          disabled={isPickingFolder || isAddingProject}
                        >
                          {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                        </button>
                      ) : null}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="flex-1 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={handleAddProject}
                          disabled={isAddingProject}
                        >
                          {isAddingProject ? "Adding..." : "Add"}
                        </button>
                        <button
                          type="button"
                          className="flex-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/60"
                          onClick={() => setAddingProject(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </PopoverPopup>
                </Popover>

                <Menu>
                  <MenuTrigger
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-150 hover:bg-accent hover:text-foreground"
                    aria-label="Filter threads"
                    data-testid="sidebar-filter-threads"
                  >
                    <ListFilterIcon className="size-4" />
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
            Threads
          </SidebarSectionHeading>

          <ScrollArea
            className="min-h-0 flex-1 **:data-[slot=scroll-area-scrollbar]:hidden"
            scrollFade
          >
            <div className="flex min-h-full flex-col pb-1">
              {shouldShowProjectGroups ? (
                <SidebarMenu className="gap-1">
                  {groupedProjects.map((group) => renderProjectGroup(group.project, group.threads))}
                </SidebarMenu>
              ) : (
                <SidebarMenu className="gap-1">
                  {chronologicalThreads.map((thread) =>
                    renderThreadRow(thread, {
                      projectLabel: projectById.get(thread.projectId)?.name ?? null,
                      variant: "flat",
                    }),
                  )}
                </SidebarMenu>
              )}

              {shouldShowNoProjectsState ? (
                <div className="px-2.5 pt-3 text-sm text-muted-foreground/60">
                  No projects yet. Add one to get started.
                </div>
              ) : null}

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

      <SidebarFooter className="gap-2 p-3">
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
    </>
  );
}
