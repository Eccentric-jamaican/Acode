import { ThreadId, type BrowserRuntimeEvent, type ProjectId } from "@t3tools/contracts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { withRightPanelMode } from "../diffRouteSearch";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Thread } from "../types";

const RESERVED_ROUTE_SEGMENTS = new Set(["orchestrate", "plugins", "settings", "skills"]);

interface BrowserPaneRouteThread {
  id: ThreadId;
  projectId: ProjectId;
  archivedAt?: string | null | undefined;
  createdAt: string;
  updatedAt?: string | null | undefined;
}

interface BrowserPaneDraftThread {
  projectId: ProjectId;
  createdAt?: string | undefined;
}

export interface ResolveBrowserPaneRouteTargetInput {
  event: Extract<BrowserRuntimeEvent, { type: "pane.requested" }>;
  pathname: string;
  threads: ReadonlyArray<BrowserPaneRouteThread>;
  draftThreadsByThreadId: Readonly<Record<ThreadId, BrowserPaneDraftThread>>;
  projectDraftThreadIdByProjectId: Readonly<Record<ProjectId, ThreadId>>;
}

function threadTimestamp(thread: Pick<BrowserPaneRouteThread, "createdAt" | "updatedAt">): number {
  const timestamp = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function browserRouteThreadIdFromPathname(pathname: string): ThreadId | null {
  const firstSegment = pathname.split("/").find(Boolean);
  if (!firstSegment || RESERVED_ROUTE_SEGMENTS.has(firstSegment)) {
    return null;
  }
  return ThreadId.makeUnsafe(decodeURIComponent(firstSegment));
}

export function resolveBrowserPaneRouteTarget(
  input: ResolveBrowserPaneRouteTargetInput,
): ThreadId | null {
  const isAvailableThread = (threadId: ThreadId | null | undefined): boolean => {
    if (!threadId) {
      return false;
    }
    const thread = input.threads.find((entry) => entry.id === threadId) ?? null;
    if (thread) {
      return thread.projectId === input.event.projectId && thread.archivedAt == null;
    }
    const draftThread = input.draftThreadsByThreadId[threadId] ?? null;
    return draftThread?.projectId === input.event.projectId;
  };

  if (isAvailableThread(input.event.threadId)) {
    return input.event.threadId ?? null;
  }

  const activeThreadId = browserRouteThreadIdFromPathname(input.pathname);
  if (isAvailableThread(activeThreadId)) {
    return activeThreadId;
  }

  const projectDraftThreadId = input.projectDraftThreadIdByProjectId[input.event.projectId];
  if (isAvailableThread(projectDraftThreadId)) {
    return projectDraftThreadId ?? null;
  }

  let newestThread: BrowserPaneRouteThread | null = null;
  for (const thread of input.threads) {
    if (thread.projectId !== input.event.projectId || thread.archivedAt != null) {
      continue;
    }
    if (!newestThread || threadTimestamp(thread) > threadTimestamp(newestThread)) {
      newestThread = thread;
    }
  }
  if (newestThread) {
    return newestThread.id;
  }

  for (const [threadId, draftThread] of Object.entries(input.draftThreadsByThreadId) as [
    ThreadId,
    BrowserPaneDraftThread,
  ][]) {
    if (draftThread.projectId === input.event.projectId) {
      return threadId;
    }
  }

  return null;
}

export function DesktopBrowserController() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);

  pathnameRef.current = pathname;

  useEffect(() => {
    const api = readNativeApi();
    if (!api?.browser) {
      return;
    }

    return api.browser.onEvent((event) => {
      if (event.type !== "pane.requested") {
        return;
      }

      const store = useStore.getState();
      const draftStore = useComposerDraftStore.getState();
      const targetThreadId = resolveBrowserPaneRouteTarget({
        event,
        pathname: pathnameRef.current,
        threads: store.threads as Thread[],
        draftThreadsByThreadId: draftStore.draftThreadsByThreadId,
        projectDraftThreadIdByProjectId: draftStore.projectDraftThreadIdByProjectId,
      });

      if (!targetThreadId) {
        return;
      }

      store.setProjectExpanded(event.projectId, true);
      void navigate({
        to: "/$threadId",
        params: { threadId: targetThreadId },
        replace: true,
        search: (previous) =>
          withRightPanelMode(previous as Record<string, unknown>, "browser"),
      });
    });
  }, [navigate]);

  useEffect(() => {
    if (browserRouteThreadIdFromPathname(pathname) !== null) {
      return;
    }

    const api = readNativeApi();
    void api?.browser?.closePane().catch(() => undefined);
  }, [pathname]);

  return null;
}
