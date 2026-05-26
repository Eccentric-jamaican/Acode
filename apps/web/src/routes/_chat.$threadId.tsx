import { ThreadId, type ProjectId, type RuntimeMode, type TurnId } from "@t3tools/contracts";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import ChatView from "../components/ChatView";
import ChatHomeSurface, { resolveChatHomeSurfaceVariant } from "../components/ChatHomeSurface";
import IntegratedBrowserPane from "../components/IntegratedBrowserPane";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDisposableThreadLifecycle } from "../hooks/useDisposableThreadLifecycle";
import {
  parseDiffRouteSearch,
  resolveFilesRailOpen,
  resolveRightPanelMode,
  type ResolvedRightPanelMode,
  withFilesRailOpen,
  withRightPanelMode,
  stripDiffSearchParams,
  type ChatRightPanel,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarProvider, SidebarRail, SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ArrowLeftRight, Maximize2Icon, Minimize2Icon, PanelLeftIcon } from "lucide-react";
import { WorkspaceFilesRail } from "../components/WorkspaceFilesRail";
import {
  useSplitViewStore,
  selectSplitView,
  type SplitView,
  type SplitViewId,
  type SplitViewPane,
  type SplitViewPanePanelState,
  resolveSplitViewFocusedThreadId,
} from "../splitViewStore";
import { resolveActiveSplitView, isSplitRoute } from "../splitViewRoute";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const FILES_RAIL_WIDTH = "22rem";
const FILES_RAIL_WIDTH_PX = 22 * 16;
const VIEWER_PANEL_MIN_WIDTH_PX = 24 * 16;
const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";

function resolveThreadBrowserContext(input: {
  threadId: ThreadId;
  threads: ReturnType<typeof useStore.getState>["threads"];
  projects: ReturnType<typeof useStore.getState>["projects"];
  draftThreadsByThreadId: ReturnType<
    typeof useComposerDraftStore.getState
  >["draftThreadsByThreadId"];
}): {
  projectId: ProjectId | null;
  runtimeMode: RuntimeMode | null;
  cwd: string | null;
} {
  const activeThread = input.threads.find((thread) => thread.id === input.threadId) ?? null;
  const activeDraftThread = input.draftThreadsByThreadId[input.threadId] ?? null;
  const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const activeProject = projectId
    ? (input.projects.find((project) => project.id === projectId) ?? null)
    : null;
  return {
    projectId,
    runtimeMode: activeThread?.runtimeMode ?? activeDraftThread?.runtimeMode ?? null,
    cwd: activeThread?.worktreePath ?? activeProject?.cwd ?? null,
  };
}

function resolveFallbackThreadId(input: {
  threads: ReturnType<typeof useStore.getState>["threads"];
  excludeThreadIds: ReadonlySet<ThreadId>;
}): ThreadId | null {
  let fallbackThreadId: ThreadId | null = null;
  let fallbackTimestamp = Number.NEGATIVE_INFINITY;

  for (const thread of input.threads) {
    if (input.excludeThreadIds.has(thread.id) || thread.archivedAt != null) {
      continue;
    }

    const timestamp = Date.parse(thread.updatedAt ?? thread.createdAt);
    if (timestamp > fallbackTimestamp) {
      fallbackThreadId = thread.id;
      fallbackTimestamp = timestamp;
    }
  }

  return fallbackThreadId;
}

function isThreadRouteAvailable(input: {
  threadId: ThreadId | null;
  threads: ReturnType<typeof useStore.getState>["threads"];
  draftThreadsByThreadId: ReturnType<
    typeof useComposerDraftStore.getState
  >["draftThreadsByThreadId"];
}): boolean {
  if (!input.threadId) {
    return false;
  }
  return (
    input.threads.some((thread) => thread.id === input.threadId && thread.archivedAt == null) ||
    Object.hasOwn(input.draftThreadsByThreadId, input.threadId)
  );
}

const RightPanelSheet = (props: {
  children: ReactNode;
  panelOpen: boolean;
  onClosePanel: () => void;
}) => {
  return (
    <Sheet
      open={props.panelOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onClosePanel();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { inline: boolean }) => {
  if (props.inline) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
        Loading diff viewer...
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
      Loading diff viewer...
    </aside>
  );
};

function ViewerPanelSurface(props: {
  panelMode: ChatRightPanel | null;
  threadId: ThreadId;
  cwd: string | null;
  threadBrowserContext: {
    projectId: ProjectId | null;
    runtimeMode: RuntimeMode | null;
    cwd: string | null;
  };
  filesOpen: boolean;
  railOverlay?: boolean;
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  onClosePanel: () => void;
  onRevealFile?: (path: string) => void;
}) {
  if (props.panelMode === null) {
    if (!props.filesOpen) {
      return null;
    }
    return props.railOverlay ? (
      <div className="absolute inset-y-0 right-0 z-30 w-[min(82vw,22rem)] border-l border-border/50 shadow-xl">
        <WorkspaceFilesRail
          threadId={props.threadId}
          cwd={props.cwd}
          onRevealFile={props.onRevealFile}
        />
      </div>
    ) : (
      <WorkspaceFilesRail
        threadId={props.threadId}
        cwd={props.cwd}
        onRevealFile={props.onRevealFile}
      />
    );
  }

  if (props.panelMode === "browser") {
    return (
      <IntegratedBrowserPane
        activeProjectId={props.threadBrowserContext?.projectId ?? null}
        activeThreadId={props.threadId}
        activeRuntimeMode={props.threadBrowserContext?.runtimeMode ?? null}
        open={true}
        layout="panel"
        {...(props.expanded !== undefined ? { expanded: props.expanded } : {})}
        {...(props.onToggleExpanded ? { onToggleExpanded: props.onToggleExpanded } : {})}
        onRequestOpen={() => {}}
        onRequestClose={props.onClosePanel}
      />
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      {props.panelMode === "diff" ? (
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
          {props.onToggleExpanded ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="rounded-full bg-background/80 shadow-sm backdrop-blur hover:bg-accent"
              aria-label={props.expanded ? "Collapse panel" : "Expand panel"}
              title={props.expanded ? "Collapse panel" : "Expand panel"}
              onClick={props.onToggleExpanded}
            >
              {props.expanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="rounded-full bg-background/80 shadow-sm backdrop-blur hover:bg-accent"
            aria-label="Toggle diff panel"
            title="Toggle diff panel"
            onClick={props.onClosePanel}
          >
            <PanelLeftIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div
        className="flex-1 overflow-hidden"
        style={{ minWidth: `${VIEWER_PANEL_MIN_WIDTH_PX}px` }}
      >
        <Suspense fallback={<DiffLoadingFallback inline />}>
          <DiffPanel mode={props.railOverlay ? "sheet" : "sidebar"} />
        </Suspense>
      </div>
      {props.filesOpen ? (
        props.railOverlay ? (
          <div className="absolute inset-y-0 right-0 z-30 w-[min(82vw,22rem)] border-l border-border/50 shadow-xl">
            <WorkspaceFilesRail
              threadId={props.threadId}
              cwd={props.cwd}
              onRevealFile={props.onRevealFile}
            />
          </div>
        ) : (
          <WorkspaceFilesRail
            threadId={props.threadId}
            cwd={props.cwd}
            onRevealFile={props.onRevealFile}
          />
        )
      ) : null}
    </div>
  );
}

function canComposerHandlePanelWidth(input: {
  nextWidth: number;
  paneScopeId?: string;
  applyWidth: (width: number) => void;
  resetWidth: () => void;
}) {
  const scopeSelector = input.paneScopeId
    ? `[data-chat-composer-form='true'][data-chat-pane-scope='${input.paneScopeId}']`
    : "[data-chat-composer-form='true']";
  const composerForm = document.querySelector<HTMLElement>(scopeSelector);
  if (!composerForm) return true;

  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;

  input.applyWidth(input.nextWidth);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  input.resetWidth();

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

const PanePanelInlineSidebar = (props: {
  panelOpen: boolean;
  filesOpen: boolean;
  onClosePanel: () => void;
  onOpenPanel: () => void;
  onRevealFile: (path: string) => void;
  onToggleExpanded?: (() => void) | undefined;
  expanded?: boolean | undefined;
  renderPanelContent: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadId | null;
  threadBrowserContext: {
    projectId: ProjectId | null;
    runtimeMode: RuntimeMode | null;
    cwd: string | null;
  };
  paneScopeId?: string;
}) => {
  const {
    panelOpen,
    filesOpen,
    onClosePanel,
    onOpenPanel,
    onRevealFile,
    onToggleExpanded,
    expanded,
    renderPanelContent,
    panel,
    threadId,
    threadBrowserContext,
    paneScopeId,
  } = props;
  const filesOnly = panel === null && filesOpen;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenPanel();
        return;
      }
      onClosePanel();
    },
    [onClosePanel, onOpenPanel],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const minimumWidth =
        panel === "diff" && filesOpen
          ? VIEWER_PANEL_MIN_WIDTH_PX + FILES_RAIL_WIDTH_PX
          : SINGLE_PANEL_MIN_WIDTH;
      if (nextWidth < minimumWidth) {
        return false;
      }
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      return canComposerHandlePanelWidth({
        nextWidth,
        ...(paneScopeId ? { paneScopeId } : {}),
        applyWidth: (width) => {
          wrapper.style.setProperty("--sidebar-width", `${width}px`);
        },
        resetWidth: () => {
          if (previousSidebarWidth.length > 0) {
            wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
          } else {
            wrapper.style.removeProperty("--sidebar-width");
          }
        },
      });
    },
    [filesOpen, paneScopeId, panel],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={panelOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={
        {
          "--sidebar-width": filesOnly ? FILES_RAIL_WIDTH : DIFF_INLINE_DEFAULT_WIDTH,
        } as React.CSSProperties
      }
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border/50 bg-card text-foreground"
        resizable={
          filesOnly
            ? false
            : {
                minWidth:
                  panel === "diff" && filesOpen
                    ? VIEWER_PANEL_MIN_WIDTH_PX + FILES_RAIL_WIDTH_PX
                    : SINGLE_PANEL_MIN_WIDTH,
                shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
                storageKey: RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY,
              }
        }
      >
        {renderPanelContent && threadId ? (
          <ViewerPanelSurface
            panelMode={panel ?? null}
            threadId={threadId}
            cwd={threadBrowserContext?.cwd ?? null}
            threadBrowserContext={threadBrowserContext}
            filesOpen={filesOpen}
            {...(expanded !== undefined ? { expanded } : {})}
            {...(onToggleExpanded ? { onToggleExpanded } : {})}
            onClosePanel={onClosePanel}
            onRevealFile={onRevealFile}
          />
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

// Split panes cannot reuse the desktop Sidebar primitive because it positions the panel
// against the viewport. This embedded shell keeps browser/diff content anchored to the pane.
function SplitPaneEmbeddedPanel(props: {
  splitViewId: SplitViewId;
  pane: SplitViewPane;
  paneScopeId: string;
  panelOpen: boolean;
  filesOpen: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadId | null;
  onClosePanel: () => void;
  onRevealFile: (path: string) => void;
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState: (
    patch: Partial<
      Pick<SplitViewPanePanelState, "panel" | "filesOpen" | "diffTurnId" | "diffFilePath">
    >,
  ) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const storageKey = `${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:${props.splitViewId}:${props.pane}`;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? Number.parseInt(stored, 10) : SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX;
  });
  const threadBrowserContext = useMemo(
    () =>
      props.threadId
        ? resolveThreadBrowserContext({
            threadId: props.threadId,
            threads,
            projects,
            draftThreadsByThreadId,
          })
        : { projectId: null, runtimeMode: null, cwd: null },
    [draftThreadsByThreadId, projects, props.threadId, threads],
  );

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    setPanelWidth(stored ? Number.parseInt(stored, 10) : SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX);
  }, [storageKey]);

  const shouldAcceptEmbeddedWidth = useCallback(
    (nextWidth: number) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return true;
      const minimumWidth =
        props.panel === "diff" && props.filesOpen
          ? VIEWER_PANEL_MIN_WIDTH_PX + FILES_RAIL_WIDTH_PX
          : SINGLE_PANEL_MIN_WIDTH;
      if (nextWidth < minimumWidth) {
        return false;
      }
      return canComposerHandlePanelWidth({
        nextWidth,
        paneScopeId: props.paneScopeId,
        applyWidth: (width) => {
          wrapper.style.width = `${width}px`;
        },
        resetWidth: () => {
          wrapper.style.width = `${panelWidth}px`;
        },
      });
    },
    [panelWidth, props.filesOpen, props.paneScopeId, props.panel],
  );

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;
      if (!wrapper || !parent) return;

      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const minimumWidth =
        props.panel === "diff" && props.filesOpen
          ? VIEWER_PANEL_MIN_WIDTH_PX + FILES_RAIL_WIDTH_PX
          : SINGLE_PANEL_MIN_WIDTH;
      const maxWidth = Math.max(minimumWidth, parent.clientWidth - SPLIT_PANE_CHAT_MIN_WIDTH);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        const nextWidth = Math.max(minimumWidth, Math.min(maxWidth, startWidth + delta));
        if (!shouldAcceptEmbeddedWidth(nextWidth)) {
          return;
        }
        setPanelWidth(nextWidth);
        localStorage.setItem(storageKey, String(nextWidth));
      };

      const onPointerUp = () => {
        document.body.style.removeProperty("user-select");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [panelWidth, props.filesOpen, props.panel, shouldAcceptEmbeddedWidth, storageKey],
  );

  if (!props.panelOpen || !props.threadId) {
    return null;
  }

  const filesOnly = props.panel === null && props.filesOpen;
  const minimumPanelWidth =
    props.panel === "diff" && props.filesOpen
      ? VIEWER_PANEL_MIN_WIDTH_PX + FILES_RAIL_WIDTH_PX
      : SINGLE_PANEL_MIN_WIDTH;
  const effectivePanelWidth = filesOnly
    ? FILES_RAIL_WIDTH_PX
    : Math.max(panelWidth, minimumPanelWidth);

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-border/50 bg-card text-foreground"
      style={{ width: `${effectivePanelWidth}px` } as React.CSSProperties}
    >
      {!filesOnly ? (
        <div
          className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/65"
          onPointerDown={startResize}
        />
      ) : null}
      {props.panel === "browser" ? (
        <ViewerPanelSurface
          panelMode="browser"
          threadId={props.threadId}
          cwd={threadBrowserContext.cwd}
          threadBrowserContext={threadBrowserContext}
          filesOpen={false}
          onClosePanel={props.onClosePanel}
          onRevealFile={props.onRevealFile}
        />
      ) : (
        <ViewerPanelSurface
          panelMode={props.panel ?? null}
          threadId={props.threadId}
          cwd={threadBrowserContext.cwd}
          threadBrowserContext={threadBrowserContext}
          filesOpen={props.filesOpen}
          onClosePanel={props.onClosePanel}
          onRevealFile={props.onRevealFile}
        />
      )}
    </div>
  );
}

function SplitPaneEmptyState(props: {
  isFocused: boolean;
  onFocus: () => void;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  otherPaneThreadId: ThreadId | null;
  onSelectThread: (threadId: ThreadId) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center bg-background px-6 pt-16",
        props.isFocused ? "ring-1 ring-inset ring-primary/25" : "",
      )}
      onMouseDown={props.onFocus}
    >
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-sm font-medium text-foreground/70">Select a chat</p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {props.threads.map((thread) => {
            const isUsed = thread.id === props.otherPaneThreadId;
            const projectName =
              props.projects.find((p) => p.id === thread.projectId)?.name ?? "Project";
            return (
              <button
                key={thread.id}
                type="button"
                disabled={isUsed}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  isUsed
                    ? "cursor-default border-border/30 opacity-35"
                    : "border-border/55 hover:bg-accent/40",
                )}
                onClick={() => {
                  if (!isUsed) props.onSelectThread(thread.id);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {thread.title || "New chat"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SplitPaneSurface(props: {
  splitView: SplitView;
  pane: SplitViewPane;
  threadId: ThreadId | null;
  isFocused: boolean;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  onFocus: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onToggleFiles: () => void;
  onOpenFileViewer: (path: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onClosePanel: () => void;
  onUpdatePanelState: (
    patch: Partial<
      Pick<SplitViewPanePanelState, "panel" | "filesOpen" | "diffTurnId" | "diffFilePath">
    >,
  ) => void;
  onMaximize: () => void;
  onChooseThread: () => void;
  onSelectThread: (threadId: ThreadId) => void;
}) {
  const paneScopeId = `${props.splitView.id}:${props.pane}`;
  const panelState = props.pane === "left" ? props.splitView.leftPanel : props.splitView.rightPanel;
  const panelOpen = panelState.panel !== null || panelState.filesOpen;
  const shouldRenderPanelContent = panelOpen || panelState.hasOpenedPanel;
  const otherPaneThreadId =
    props.pane === "left" ? props.splitView.rightThreadId : props.splitView.leftThreadId;

  return (
    <div className="group relative flex min-h-0 min-w-0 flex-1 bg-background">
      {props.threadId ? (
        <div className="pointer-events-none absolute right-3 top-[3.75rem] z-20 sm:right-5 sm:top-[4.25rem]">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={`Choose chat for the ${props.pane} split pane`}
            title="Choose chat"
            className={cn(
              "pointer-events-auto transition-opacity",
              !props.isFocused ? "opacity-0 group-hover:opacity-100" : "",
            )}
            onClick={(event) => {
              event.stopPropagation();
              props.onChooseThread();
            }}
          >
            <ArrowLeftRight className="size-4" />
          </Button>
        </div>
      ) : null}
      <SidebarInset
        className={cn(
          "min-h-0 min-w-0 overflow-hidden overscroll-y-none rounded-none bg-background text-foreground transition-shadow",
          props.isFocused ? "ring-1 ring-inset ring-primary/25" : "",
        )}
        onMouseDown={props.onFocus}
      >
        {props.threadId ? (
          <ChatView
            key={`${props.splitView.id}:${props.pane}:${props.threadId}`}
            threadId={props.threadId}
            paneScopeId={paneScopeId}
            surfaceMode="split"
            isFocusedPane={props.isFocused}
            panelState={panelState}
            onToggleDiffPanel={props.onToggleDiff}
            onToggleBrowserPanel={props.onToggleBrowser}
            onToggleFilesPanel={props.onToggleFiles}
            onOpenFileViewerPanel={props.onOpenFileViewer}
            onOpenTurnDiffPanel={props.onOpenTurnDiff}
            onMaximizeSurface={props.onMaximize}
          />
        ) : (
          <SplitPaneEmptyState
            isFocused={props.isFocused}
            onFocus={props.onFocus}
            threads={props.threads}
            projects={props.projects}
            otherPaneThreadId={otherPaneThreadId}
            onSelectThread={props.onSelectThread}
          />
        )}
      </SidebarInset>
      <SplitPaneEmbeddedPanel
        splitViewId={props.splitView.id}
        pane={props.pane}
        paneScopeId={paneScopeId}
        panelOpen={panelOpen && shouldRenderPanelContent}
        filesOpen={panelState.filesOpen}
        panel={panelState.panel}
        threadId={props.threadId}
        onClosePanel={props.onClosePanel}
        onRevealFile={props.onOpenFileViewer}
        panelState={panelState}
        onUpdatePanelState={props.onUpdatePanelState}
      />
    </div>
  );
}

function SplitChatSurface(props: { splitViewId: SplitViewId; routeThreadId: ThreadId }) {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const splitView = useSplitViewStore(selectSplitView(props.splitViewId));
  const setFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const setRatio = useSplitViewStore((store) => store.setRatio);
  const setPanePanelState = useSplitViewStore((store) => store.setPanePanelState);
  const replacePaneThread = useSplitViewStore((store) => store.replacePaneThread);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const rootRef = useRef<HTMLDivElement>(null);
  const [threadPickerPane, setThreadPickerPane] = useState<SplitViewPane | null>(null);
  const {
    splitView: activeSplitView,
    focusedThreadId,
    routePane,
  } = resolveActiveSplitView({
    splitView,
    routeThreadId: props.routeThreadId,
  });

  useEffect(() => {
    if (!activeSplitView) {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.routeThreadId },
        replace: true,
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          const { splitViewId: _, ...withoutSplitView } = rest as Record<string, unknown>;
          return withoutSplitView;
        },
      });
      return;
    }

    if (
      activeSplitView.leftThreadId &&
      activeSplitView.rightThreadId &&
      activeSplitView.leftThreadId === activeSplitView.rightThreadId
    ) {
      replacePaneThread(activeSplitView.id, "right", null);
      setFocusedPane(activeSplitView.id, "left");
      return;
    }

    const focusedPaneThreadId =
      activeSplitView.focusedPane === "left"
        ? activeSplitView.leftThreadId
        : activeSplitView.rightThreadId;
    const normalizedFocusedThreadId = resolveSplitViewFocusedThreadId(activeSplitView);
    if (routePane && routePane !== activeSplitView.focusedPane && focusedPaneThreadId !== null) {
      setFocusedPane(activeSplitView.id, routePane);
      return;
    }

    if (normalizedFocusedThreadId && props.routeThreadId !== normalizedFocusedThreadId) {
      void navigate({
        to: "/$threadId",
        params: { threadId: normalizedFocusedThreadId },
        replace: true,
        search: () => ({
          splitViewId: activeSplitView.id,
        }),
      });
    }
  }, [
    activeSplitView,
    navigate,
    props.routeThreadId,
    replacePaneThread,
    routePane,
    setFocusedPane,
  ]);

  const setPaneFocus = useCallback(
    (pane: SplitViewPane) => {
      if (!activeSplitView) return;
      setFocusedPane(activeSplitView.id, pane);
      const nextThreadId =
        pane === "left"
          ? (activeSplitView.leftThreadId ?? activeSplitView.rightThreadId)
          : (activeSplitView.rightThreadId ?? activeSplitView.leftThreadId);
      if (!nextThreadId || nextThreadId === props.routeThreadId) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: activeSplitView.id,
        }),
      });
    },
    [activeSplitView, navigate, props.routeThreadId, setFocusedPane],
  );

  const updatePanePanelState = useCallback(
    (
      pane: SplitViewPane,
      patch: Partial<
        Pick<SplitViewPanePanelState, "panel" | "filesOpen" | "diffTurnId" | "diffFilePath">
      >,
    ) => {
      if (!activeSplitView) return;
      const previousState =
        pane === "left" ? activeSplitView.leftPanel : activeSplitView.rightPanel;
      setPanePanelState(activeSplitView.id, pane, {
        ...patch,
        hasOpenedPanel:
          previousState.hasOpenedPanel || (patch.panel ?? previousState.panel) !== null,
        lastOpenPanel:
          patch.panel === "browser" || patch.panel === "diff"
            ? patch.panel
            : previousState.lastOpenPanel,
      });
    },
    [activeSplitView, setPanePanelState],
  );

  const togglePanePanel = useCallback(
    (pane: SplitViewPane, panel: ChatRightPanel) => {
      if (!activeSplitView) return;
      const paneThreadId =
        pane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;
      if (!paneThreadId) {
        return;
      }
      const previousState =
        pane === "left" ? activeSplitView.leftPanel : activeSplitView.rightPanel;
      updatePanePanelState(pane, {
        panel: previousState.panel === panel ? null : panel,
        filesOpen: panel === "browser" ? false : previousState.filesOpen,
        diffTurnId: panel === "diff" ? previousState.diffTurnId : null,
        diffFilePath: panel === "diff" ? previousState.diffFilePath : null,
      });
    },
    [activeSplitView, updatePanePanelState],
  );

  const togglePaneFiles = useCallback(
    (pane: SplitViewPane) => {
      if (!activeSplitView) return;
      const previousState =
        pane === "left" ? activeSplitView.leftPanel : activeSplitView.rightPanel;
      updatePanePanelState(pane, {
        filesOpen: !previousState.filesOpen,
      });
    },
    [activeSplitView, updatePanePanelState],
  );

  const closePanePanel = useCallback(
    (pane: SplitViewPane) => {
      updatePanePanelState(pane, {
        panel: null,
        filesOpen: false,
      });
    },
    [updatePanePanelState],
  );

  const openPaneTurnDiff = useCallback(
    (pane: SplitViewPane, turnId: TurnId, filePath?: string) => {
      updatePanePanelState(pane, {
        panel: "diff",
        diffTurnId: turnId,
        diffFilePath: filePath ?? null,
      });
    },
    [updatePanePanelState],
  );

  const openPaneFileViewer = useCallback(
    (pane: SplitViewPane, _path: string) => {
      updatePanePanelState(pane, {
        panel: "diff",
      });
    },
    [updatePanePanelState],
  );

  const maximizeFocusedPane = useCallback(() => {
    if (!activeSplitView) return;
    const nextThreadId = focusedThreadId;
    const focusedPanelState =
      activeSplitView.focusedPane === "left"
        ? activeSplitView.leftPanel
        : activeSplitView.rightPanel;
    removeSplitView(activeSplitView.id);
    if (!nextThreadId) {
      void navigate({ to: "/", replace: true });
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: () => {
        if (focusedPanelState.lastOpenPanel) {
          return { panel: focusedPanelState.lastOpenPanel };
        }
        return {};
      },
    });
  }, [activeSplitView, focusedThreadId, navigate, removeSplitView]);

  const activeSplitViewIdRef = useRef<SplitViewId | null>(null);
  activeSplitViewIdRef.current = activeSplitView?.id ?? null;

  useEffect(() => {
    const root = rootRef.current;
    const splitViewId = activeSplitViewIdRef.current;
    if (!root || !splitViewId) return;

    const divider = root.querySelector<HTMLElement>("[data-split-divider='true']");
    if (!divider) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const id = activeSplitViewIdRef.current;
      if (!id) return;
      setRatio(id, (event.clientX - rect.left) / rect.width);
    };

    const handlePointerUp = () => {
      document.body.style.removeProperty("user-select");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    };

    divider.addEventListener("pointerdown", onPointerDown);
    return () => {
      divider.removeEventListener("pointerdown", onPointerDown);
      handlePointerUp();
    };
  }, [activeSplitView?.id, setRatio]);

  if (!activeSplitView) {
    return null;
  }

  const leftBasis = `${activeSplitView.ratio * 100}%`;
  const rightBasis = `${(1 - activeSplitView.ratio) * 100}%`;
  const selectableThreads = threads.toSorted(
    (left, right) =>
      Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt),
  );
  const chooseThreadForPane = (threadId: ThreadId, paneOverride?: SplitViewPane) => {
    const pane = paneOverride ?? threadPickerPane;
    if (!pane) {
      return;
    }
    const otherPane: SplitViewPane = pane === "left" ? "right" : "left";
    const currentPaneThreadId =
      pane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;
    const otherPaneThreadId =
      otherPane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;

    setThreadPickerPane(null);

    if (threadId === otherPaneThreadId) {
      setPaneFocus(otherPane);
      return;
    }

    setFocusedPane(activeSplitView.id, pane);
    if (threadId !== currentPaneThreadId) {
      replacePaneThread(activeSplitView.id, pane, threadId);
      setPanePanelState(activeSplitView.id, pane, {
        diffTurnId: null,
        diffFilePath: null,
      });
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  return (
    <>
      <div
        ref={rootRef}
        className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      >
        <div
          className="flex min-h-0 min-w-0"
          style={{ flexBasis: leftBasis, flexGrow: 0, flexShrink: 1 }}
        >
          <SplitPaneSurface
            splitView={activeSplitView}
            pane="left"
            threadId={activeSplitView.leftThreadId}
            isFocused={activeSplitView.focusedPane === "left"}
            threads={selectableThreads}
            projects={projects}
            onFocus={() => setPaneFocus("left")}
            onToggleDiff={() => togglePanePanel("left", "diff")}
            onToggleBrowser={() => togglePanePanel("left", "browser")}
            onToggleFiles={() => togglePaneFiles("left")}
            onOpenFileViewer={(path) => openPaneFileViewer("left", path)}
            onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff("left", turnId, filePath)}
            onClosePanel={() => closePanePanel("left")}
            onUpdatePanelState={(patch) => updatePanePanelState("left", patch)}
            onMaximize={maximizeFocusedPane}
            onChooseThread={() => {
              setPaneFocus("left");
              setThreadPickerPane("left");
            }}
            onSelectThread={(threadId) => chooseThreadForPane(threadId, "left")}
          />
        </div>
        <div
          data-split-divider="true"
          className="relative z-10 w-px shrink-0 cursor-col-resize bg-border/70 before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
        />
        <div
          className="flex min-h-0 min-w-0 flex-1"
          style={{ flexBasis: rightBasis, flexGrow: 1, flexShrink: 1 }}
        >
          <SplitPaneSurface
            splitView={activeSplitView}
            pane="right"
            threadId={activeSplitView.rightThreadId}
            isFocused={activeSplitView.focusedPane === "right"}
            threads={selectableThreads}
            projects={projects}
            onFocus={() => setPaneFocus("right")}
            onToggleDiff={() => togglePanePanel("right", "diff")}
            onToggleBrowser={() => togglePanePanel("right", "browser")}
            onToggleFiles={() => togglePaneFiles("right")}
            onOpenFileViewer={(path) => openPaneFileViewer("right", path)}
            onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff("right", turnId, filePath)}
            onClosePanel={() => closePanePanel("right")}
            onUpdatePanelState={(patch) => updatePanePanelState("right", patch)}
            onMaximize={maximizeFocusedPane}
            onChooseThread={() => {
              setPaneFocus("right");
              setThreadPickerPane("right");
            }}
            onSelectThread={(threadId) => chooseThreadForPane(threadId, "right")}
          />
        </div>
      </div>
      <Dialog
        open={threadPickerPane !== null}
        onOpenChange={(open) => {
          if (!open) {
            setThreadPickerPane(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Choose Chat</DialogTitle>
            <DialogDescription className="max-w-sm text-center">
              Pick which chat should appear in the {threadPickerPane ?? "focused"} split pane.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="max-h-[56vh] space-y-1 overflow-y-auto">
              {selectableThreads.map((thread) => {
                const projectName =
                  projects.find((project) => project.id === thread.projectId)?.name ?? "Project";
                const isSelected =
                  threadPickerPane === "left"
                    ? activeSplitView.leftThreadId === thread.id
                    : activeSplitView.rightThreadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-primary/35 bg-accent/55"
                        : "border-border/55 hover:bg-accent/40",
                    )}
                    onClick={() => chooseThreadForPane(thread.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {thread.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" onClick={() => setThreadPickerPane(null)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function SingleChatSurface(props: {
  threadId: ThreadId;
  projectId: ProjectId | null;
  panelMode: ResolvedRightPanelMode;
  filesOpen: boolean;
  threadBrowserContext: {
    projectId: ProjectId | null;
    runtimeMode: RuntimeMode | null;
    cwd: string | null;
  };
  onSplitSurface?: () => void;
}) {
  const navigate = useNavigate();
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const createSplitView = useSplitViewStore((store) => store.createFromThread);
  const activePanel = props.panelMode === "none" ? null : props.panelMode;
  const panelOpen = activePanel !== null || props.filesOpen;
  const [hasOpenedPanel, setHasOpenedPanel] = useState(panelOpen);
  const [lastOpenPanel, setLastOpenPanel] = useState<ChatRightPanel>(activePanel ?? "browser");
  const [viewerExpanded, setViewerExpanded] = useState(false);

  const closePanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        const { panel: _, ...withoutPanel } = rest as Record<string, unknown>;
        return withoutPanel;
      },
    });
  }, [navigate, props.threadId]);

  const openPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return lastOpenPanel === "browser"
          ? { ...rest, panel: "browser" }
          : { ...rest, panel: "diff", diff: "1", ...(props.filesOpen ? { files: "1" } : {}) };
      },
    });
  }, [lastOpenPanel, navigate, props.filesOpen, props.threadId]);

  const openFileViewer = useCallback(
    (_path: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: (previous) => {
          const next = withRightPanelMode(previous as Record<string, unknown>, "diff");
          return props.filesOpen ? withFilesRailOpen(next, true) : next;
        },
      });
    },
    [navigate, props.filesOpen, props.threadId],
  );

  const toggleFiles = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => {
        const currentlyOpen = resolveFilesRailOpen(
          parseDiffRouteSearch(previous as Record<string, unknown>),
        );
        return withFilesRailOpen(previous as Record<string, unknown>, !currentlyOpen);
      },
    });
  }, [navigate, props.threadId]);

  const handleSplitSurface = useCallback(() => {
    if (!props.projectId) return;
    const splitViewId = createSplitView({
      sourceThreadId: props.threadId,
      ownerProjectId: props.projectId,
    });
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      replace: true,
      search: () => ({ splitViewId }),
    });
  }, [createSplitView, navigate, props.projectId, props.threadId]);

  useEffect(() => {
    if (panelOpen || props.filesOpen) {
      setHasOpenedPanel(true);
    }
  }, [panelOpen, props.filesOpen]);

  useEffect(() => {
    if (activePanel) {
      setLastOpenPanel(activePanel);
    }
  }, [activePanel]);

  useEffect(() => {
    if (activePanel === null) {
      setViewerExpanded(false);
    }
  }, [activePanel]);

  const shouldRenderPanelContent =
    (activePanel !== null || props.filesOpen) && (panelOpen || hasOpenedPanel);

  if (!shouldUseDiffSheet) {
    return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none rounded-none bg-background text-foreground">
          <ChatView
            key={props.threadId}
            threadId={props.threadId}
            onSplitSurface={handleSplitSurface}
            onToggleFilesPanel={toggleFiles}
            floatingComposer={viewerExpanded && activePanel === "diff"}
          />
        </SidebarInset>
        <PanePanelInlineSidebar
          panelOpen={panelOpen}
          filesOpen={props.filesOpen}
          onClosePanel={closePanel}
          onOpenPanel={openPanel}
          onRevealFile={openFileViewer}
          renderPanelContent={
            shouldRenderPanelContent && !(viewerExpanded && activePanel !== null)
          }
          panel={activePanel}
          threadId={props.threadId}
          threadBrowserContext={props.threadBrowserContext}
          {...(activePanel !== null
            ? {
                onToggleExpanded: () => setViewerExpanded((expanded) => !expanded),
                expanded: viewerExpanded,
              }
            : {})}
        />
        {viewerExpanded && activePanel !== null && shouldRenderPanelContent ? (
          <div className="absolute inset-0 z-40 flex min-h-0 min-w-0 bg-background">
            <ViewerPanelSurface
              panelMode={activePanel}
              threadId={props.threadId}
              cwd={props.threadBrowserContext.cwd}
              threadBrowserContext={props.threadBrowserContext}
              filesOpen={props.filesOpen}
              expanded
              onToggleExpanded={() => setViewerExpanded(false)}
              onClosePanel={closePanel}
              onRevealFile={openFileViewer}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none rounded-none bg-background text-foreground">
        <ChatView
          key={props.threadId}
          threadId={props.threadId}
          onSplitSurface={handleSplitSurface}
          onToggleFilesPanel={toggleFiles}
        />
      </SidebarInset>
      <RightPanelSheet panelOpen={panelOpen} onClosePanel={closePanel}>
        {shouldRenderPanelContent ? (
          activePanel === "browser" ? (
            <IntegratedBrowserPane
              activeProjectId={props.threadBrowserContext.projectId}
              activeThreadId={props.threadId}
              activeRuntimeMode={props.threadBrowserContext.runtimeMode}
              open={true}
              layout="panel"
              onRequestOpen={openPanel}
              onRequestClose={closePanel}
            />
          ) : (
            <ViewerPanelSurface
              panelMode="diff"
              threadId={props.threadId}
              cwd={props.threadBrowserContext.cwd}
              threadBrowserContext={props.threadBrowserContext}
              filesOpen={props.filesOpen}
              railOverlay
              onClosePanel={closePanel}
              onRevealFile={openFileViewer}
            />
          )
        ) : null}
      </RightPanelSheet>
    </>
  );
}

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const hydrationError = useStore((store) => store.hydrationError);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  useDisposableThreadLifecycle(threadId);
  const search = Route.useSearch();
  const threadExists = useStore((store) =>
    store.threads.some((thread) => thread.id === threadId && thread.archivedAt == null),
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const locationSearch = useRouterState({
    select: (state) => state.location.search,
  });
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const previousProjectIdRef = useRef<ProjectId | null>(null);
  const previousThreadIdRef = useRef<ThreadId | null>(null);
  const previousPanelModeRef = useRef<ResolvedRightPanelMode>("none");
  const suppressBrowserReopenRef = useRef(false);
  const threadBrowserContext = resolveThreadBrowserContext({
    threadId,
    threads,
    projects,
    draftThreadsByThreadId,
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const homeVariant = resolveChatHomeSurfaceVariant({
    projectsCount: projects.length,
    threadsCount: threads.length,
  });
  const panelMode = resolveRightPanelMode(search);
  const filesOpen = resolveFilesRailOpen(search);
  const splitView = useSplitViewStore(selectSplitView(search.splitViewId ?? null));
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const activeProjectId = threadBrowserContext.projectId;

  const hasExplicitPanelSearchIntent = useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    return params.has("panel") || params.has("diff");
  }, [locationSearch]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    const fallbackThreadId = resolveFallbackThreadId({
      threads,
      excludeThreadIds: new Set([threadId]),
    });

    if (isSplitRoute(search)) {
      if (!splitView) {
        if (routeThreadExists) {
          void navigate({
            to: "/$threadId",
            params: { threadId },
            replace: true,
            search: (previous) => {
              const rest = stripDiffSearchParams(previous);
              const { splitViewId: _, ...withoutSplitView } = rest as Record<string, unknown>;
              return withoutSplitView;
            },
          });
        } else if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
        return;
      }

      const splitThreadIds = [splitView.leftThreadId, splitView.rightThreadId].filter(
        (candidate): candidate is ThreadId => candidate !== null,
      );
      const availableSplitThreadIds = splitThreadIds.filter((candidate) =>
        isThreadRouteAvailable({
          threadId: candidate,
          threads,
          draftThreadsByThreadId,
        }),
      );
      for (const staleThreadId of splitThreadIds) {
        if (!availableSplitThreadIds.includes(staleThreadId)) {
          removeThreadFromSplitViews(staleThreadId);
        }
      }

      if (!routeThreadExists) {
        const nextThreadId =
          availableSplitThreadIds.find((candidate) => candidate !== threadId) ?? fallbackThreadId;
        if (nextThreadId) {
          const keepSplitView = availableSplitThreadIds.some(
            (candidate) => candidate === nextThreadId,
          );
          if (keepSplitView) {
            void navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
              search: () => ({ splitViewId: splitView.id }),
            });
          } else {
            void navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
            });
          }
        } else {
          void navigate({ to: "/", replace: true });
        }
      }
      return;
    }

    if (!routeThreadExists) {
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
  }, [
    draftThreadsByThreadId,
    navigate,
    removeThreadFromSplitViews,
    routeThreadExists,
    search,
    splitView,
    threadId,
    threads,
    threadsHydrated,
  ]);

  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    previousThreadIdRef.current = threadId;
    const previousProjectId = previousProjectIdRef.current;
    const previousPanelMode = previousPanelModeRef.current;
    const nextProjectId = threadBrowserContext.projectId;
    previousProjectIdRef.current = nextProjectId;
    previousPanelModeRef.current = panelMode;

    if (!previousProjectId || !nextProjectId) {
      return;
    }

    if (previousProjectId !== nextProjectId) {
      const api = readNativeApi();
      void api?.browser?.closePane().catch(() => undefined);
      if (panelMode === "browser") {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "none"),
        });
      }
      return;
    }

    if (previousPanelMode === "browser" && panelMode === "none" && !hasExplicitPanelSearchIntent) {
      // Preserve browser panel across same-project thread switches only.
      if (!previousThreadId || previousThreadId === threadId) {
        return;
      }
      if (suppressBrowserReopenRef.current) {
        suppressBrowserReopenRef.current = false;
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "browser"),
      });
    }
  }, [hasExplicitPanelSearchIntent, navigate, panelMode, threadBrowserContext.projectId, threadId]);

  useEffect(() => {
    if (panelMode === "browser") {
      return;
    }

    const api = readNativeApi();
    void api?.browser?.closePane().catch(() => undefined);
  }, [panelMode]);

  if (!threadsHydrated) {
    return <ChatHomeSurface variant={hydrationError ? "error" : "hydrating"} />;
  }

  if (!routeThreadExists) {
    return <ChatHomeSurface variant={homeVariant} />;
  }

  if (splitView && search.splitViewId) {
    return <SplitChatSurface splitViewId={search.splitViewId} routeThreadId={threadId} />;
  }

  return (
    <SingleChatSurface
      threadId={threadId}
      projectId={activeProjectId}
      panelMode={panelMode}
      filesOpen={filesOpen}
      threadBrowserContext={threadBrowserContext}
    />
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
