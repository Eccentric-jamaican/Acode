import { ThreadId, type ProjectId, type RuntimeMode } from "@t3tools/contracts";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";

import AppPageShell from "../components/AppPageShell";
import ChatView from "../components/ChatView";
import IntegratedBrowserPane from "../components/IntegratedBrowserPane";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  parseDiffRouteSearch,
  resolveRightPanelMode,
  type ResolvedRightPanelMode,
  withRightPanelMode,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;

function resolveThreadBrowserContext(input: {
  threadId: ThreadId;
  threads: ReturnType<typeof useStore.getState>["threads"];
  draftThreadsByThreadId: ReturnType<typeof useComposerDraftStore.getState>["draftThreadsByThreadId"];
}): {
  projectId: ProjectId | null;
  runtimeMode: RuntimeMode | null;
} {
  const activeThread = input.threads.find((thread) => thread.id === input.threadId) ?? null;
  const activeDraftThread = input.draftThreadsByThreadId[input.threadId] ?? null;
  return {
    projectId: activeThread?.projectId ?? activeDraftThread?.projectId ?? null,
    runtimeMode: activeThread?.runtimeMode ?? activeDraftThread?.runtimeMode ?? null,
  };
}

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
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

const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  railDisabled?: boolean;
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff, railDisabled = false } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      onCloseDiff();
    },
    [onCloseDiff, onOpenDiff],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={diffOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <Suspense fallback={<DiffLoadingFallback inline />}>
          <DiffPanel mode="sidebar" />
        </Suspense>
        <SidebarRail
          aria-hidden={railDisabled}
          className={railDisabled ? "pointer-events-none opacity-0" : undefined}
          tabIndex={railDisabled ? -1 : undefined}
        />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore(
    (store) => Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const locationSearch = useRouterState({
    select: (state) => state.location.search,
  });
  const threads = useStore((store) => store.threads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const previousProjectIdRef = useRef<ProjectId | null>(null);
  const previousThreadIdRef = useRef<ThreadId | null>(null);
  const previousPanelModeRef = useRef<ResolvedRightPanelMode>("none");
  const suppressBrowserReopenRef = useRef(false);
  const threadBrowserContext = resolveThreadBrowserContext({
    threadId,
    threads,
    draftThreadsByThreadId,
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const panelMode = resolveRightPanelMode(search);
  const diffOpen = panelMode === "diff";
  const browserOpen = panelMode === "browser";
  const pageShellClassName = cn(
    "min-w-0 text-foreground isolate",
    browserOpen && "md:mr-0 md:rounded-r-none",
  );
  const threadShellClassName = cn(
    "flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--app-thread-surface)]",
    browserOpen ? "md:rounded-l-[12px] md:rounded-r-none" : "md:rounded-[12px]",
  );
  const hasExplicitPanelSearchIntent = useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    return params.has("panel") || params.has("diff");
  }, [locationSearch]);
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "none"),
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "diff"),
    });
  }, [navigate, threadId]);
  const closeBrowser = useCallback(() => {
    suppressBrowserReopenRef.current = true;
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "none"),
    });
  }, [navigate, threadId]);
  const openBrowser = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => withRightPanelMode(previous as Record<string, unknown>, "browser"),
    });
  }, [navigate, threadId]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

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
          search: (previous) =>
            withRightPanelMode(previous as Record<string, unknown>, "none"),
        });
      }
      return;
    }

    if (
      previousPanelMode === "browser" &&
      panelMode === "none" &&
      !hasExplicitPanelSearchIntent
    ) {
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
        search: (previous) =>
          withRightPanelMode(previous as Record<string, unknown>, "browser"),
      });
    }
  }, [
    hasExplicitPanelSearchIntent,
    navigate,
    panelMode,
    threadBrowserContext.projectId,
    threadId,
  ]);

  useEffect(() => {
    if (panelMode === "browser") {
      return;
    }

    const api = readNativeApi();
    void api?.browser?.closePane().catch(() => undefined);
  }, [panelMode]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <AppPageShell className={pageShellClassName}>
        <div className={threadShellClassName} data-testid="chat-thread-shell">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
            <ChatView key={threadId} threadId={threadId} />
          </div>
          <DiffPanelInlineSidebar
            diffOpen={diffOpen}
            onCloseDiff={closeDiff}
            onOpenDiff={openDiff}
            railDisabled={browserOpen}
          />
          <IntegratedBrowserPane
            activeProjectId={threadBrowserContext.projectId}
            activeThreadId={threadId}
            activeRuntimeMode={threadBrowserContext.runtimeMode}
            open={browserOpen}
            onRequestOpen={openBrowser}
            onRequestClose={closeBrowser}
          />
        </div>
      </AppPageShell>
    );
  }

  return (
    <>
      <AppPageShell className={pageShellClassName}>
        <div className={cn(threadShellClassName, "text-foreground")} data-testid="chat-thread-shell">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatView key={threadId} threadId={threadId} />
          </div>
          <IntegratedBrowserPane
            activeProjectId={threadBrowserContext.projectId}
            activeThreadId={threadId}
            activeRuntimeMode={threadBrowserContext.runtimeMode}
            open={browserOpen}
            onRequestOpen={openBrowser}
            onRequestClose={closeBrowser}
          />
        </div>
      </AppPageShell>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        <Suspense fallback={<DiffLoadingFallback inline={false} />}>
          <DiffPanel mode="sheet" />
        </Suspense>
      </DiffPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
