import { ThreadId, type ProjectId, type RuntimeMode } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, type ReactNode, useCallback, useEffect, useRef } from "react";

import AppPageShell from "../components/AppPageShell";
import ChatView from "../components/ChatView";
import IntegratedBrowserPane from "../components/IntegratedBrowserPane";
import { useBrowserPaneStore } from "../browserPaneStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
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
}) => {
  const { diffOpen, onCloseDiff, onOpenDiff } = props;
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
        <SidebarRail />
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
  const threads = useStore((store) => store.threads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const setBrowserPaneOpen = useBrowserPaneStore((state) => state.setOpen);
  const previousProjectIdRef = useRef<ProjectId | null>(null);
  const threadBrowserContext = resolveThreadBrowserContext({
    threadId,
    threads,
    draftThreadsByThreadId,
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: {},
    });
  }, [navigate, threadId]);
  const openDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: { diff: "1" },
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
    const previousProjectId = previousProjectIdRef.current;
    const nextProjectId = threadBrowserContext.projectId;
    previousProjectIdRef.current = nextProjectId;

    if (!previousProjectId || !nextProjectId || previousProjectId === nextProjectId) {
      return;
    }

    setBrowserPaneOpen(false);
    const api = readNativeApi();
    void api?.browser?.closePane().catch(() => undefined);
  }, [setBrowserPaneOpen, threadBrowserContext.projectId]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  if (!shouldUseDiffSheet) {
    return (
      <AppPageShell className="min-w-0 text-foreground isolate">
        <div
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--app-thread-surface)] md:rounded-[12px]"
          data-testid="chat-thread-shell"
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
            <ChatView key={threadId} threadId={threadId} />
          </div>
          <DiffPanelInlineSidebar
            diffOpen={diffOpen}
            onCloseDiff={closeDiff}
            onOpenDiff={openDiff}
          />
          <IntegratedBrowserPane
            activeProjectId={threadBrowserContext.projectId}
            activeThreadId={threadId}
            activeRuntimeMode={threadBrowserContext.runtimeMode}
          />
        </div>
      </AppPageShell>
    );
  }

  return (
    <>
      <AppPageShell className="min-w-0 text-foreground isolate">
        <div
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--app-thread-surface)] text-foreground md:rounded-[12px]"
          data-testid="chat-thread-shell"
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatView key={threadId} threadId={threadId} />
          </div>
          <IntegratedBrowserPane
            activeProjectId={threadBrowserContext.projectId}
            activeThreadId={threadId}
            activeRuntimeMode={threadBrowserContext.runtimeMode}
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
