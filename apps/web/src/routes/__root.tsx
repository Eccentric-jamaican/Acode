import { ThreadId, type OrchestrationGetSnapshotInput } from "@t3tools/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { preferredTerminalEditor } from "../terminal-links";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import {
  reportClientDiagnostic,
  setClientDiagnosticRoute,
} from "../errorInboxReporter";
import {
  onServerConfigUpdated,
  onServerErrorInboxUpdated,
  onServerProviderStateUpdated,
  onServerWelcome,
} from "../wsNativeApi";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { DesktopBrowserController } from "../components/DesktopBrowserController";
import { resolveSplitViewThreadIds, useSplitViewStore } from "../splitViewStore";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const isPairRoute =
    typeof window !== "undefined" &&
    (window.location.pathname === "/pair" || window.location.hash.startsWith("#/pair"));

  if (!isPairRoute && !readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <DesktopBrowserController />
        <DesktopProjectBootstrap />
        <TaskCompletionNotifications />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function activeThreadIdFromPathname(pathname: string): ThreadId | undefined {
  const firstSegment = pathname.split("/").find(Boolean);
  if (!firstSegment || firstSegment === "settings") {
    return undefined;
  }
  const threadIdSegment: string = firstSegment;
  return ThreadId.makeUnsafe(decodeURIComponent(threadIdSegment));
}

function snapshotInputForLocation(pathname: string): OrchestrationGetSnapshotInput {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const searchParams = new URLSearchParams(search);
  const activeThreadId = activeThreadIdFromPathname(pathname);
  const splitViewId = searchParams.get("splitViewId");
  if (splitViewId) {
    const splitView = useSplitViewStore.getState().splitViewsById[splitViewId] ?? null;
    const threadIds = splitView
      ? [
          ...new Set([
            ...resolveSplitViewThreadIds(splitView),
            ...(activeThreadId ? [activeThreadId] : []),
          ]),
        ]
      : activeThreadId
        ? [activeThreadId]
        : [];
    const primaryThreadId = activeThreadId ?? threadIds[0];
    if (primaryThreadId) {
      return {
        mode: "focused",
        threadId: primaryThreadId,
        threadIds,
      };
    }
    return { mode: "bootstrap" };
  }
  return activeThreadId ? { mode: "focused", threadId: activeThreadId } : { mode: "bootstrap" };
}

function describeSnapshotInput(input: OrchestrationGetSnapshotInput): string {
  if (input.mode === "focused") {
    return `focused:${input.threadId ?? ""}`;
  }
  return input.mode ?? "bootstrap";
}

function authoritativeThreadDetailIdsForSnapshotInput(
  input: OrchestrationGetSnapshotInput,
): ReadonlySet<ThreadId> | undefined {
  if (input.mode !== "focused") {
    return undefined;
  }

  return new Set(
    [input.threadId, ...(input.threadIds ?? [])].filter(
      (threadId): threadId is ThreadId => threadId !== undefined,
    ),
  );
}

function EventRouter() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setHydrationStatus = useStore((store) => store.setHydrationStatus);
  const setHydrationError = useStore((store) => store.setHydrationError);
  const syncErrorInbox = useStore((store) => store.syncErrorInbox);
  const upsertErrorInboxEntry = useStore((store) => store.upsertErrorInboxEntry);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const lastConfigIssuesSignatureRef = useRef<string | null>(null);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);

  pathnameRef.current = pathname;

  useEffect(() => {
    setClientDiagnosticRoute(pathname);
  }, [pathname]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    let syncing = false;
    let pending = false;

    const flushSnapshotSync = async (): Promise<void> => {
      const requestedSnapshotInput = snapshotInputForLocation(pathnameRef.current);
      const snapshotInput = useStore.getState().threadsHydrated
        ? requestedSnapshotInput
        : ({ mode: "bootstrap" } satisfies OrchestrationGetSnapshotInput);
      let preserveThreadDetails = snapshotInput.mode !== "full";
      let authoritativeThreadDetailIds = authoritativeThreadDetailIdsForSnapshotInput(snapshotInput);
      let snapshot;
      try {
        snapshot = await api.orchestration.getSnapshot(snapshotInput);
      } catch (error) {
        if (snapshotInput.mode === "bootstrap") {
          throw error;
        }

        reportClientDiagnostic({
          source: "websocket",
          category: "websocket",
          severity: "warning",
          summary: "Snapshot hydration fell back to bootstrap",
          detail:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Focused snapshot failed before bootstrap fallback.",
          context: {
            route: pathnameRef.current,
            requestedMode: describeSnapshotInput(snapshotInput),
            fallbackMode: "bootstrap",
          },
        });
        snapshot = await api.orchestration.getSnapshot({ mode: "bootstrap" });
        preserveThreadDetails = true;
        authoritativeThreadDetailIds = undefined;
      }
      if (disposed) return;
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      syncServerReadModel(snapshot, {
        ...(authoritativeThreadDetailIds ? { authoritativeThreadDetailIds } : {}),
        preserveThreadDetails,
      });
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: snapshot.threads,
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
      if (pending) {
        pending = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      pending = false;
      setHydrationStatus(useStore.getState().threadsHydrated ? "refreshing" : "loading");
      try {
        await flushSnapshotSync();
        setHydrationStatus("ready");
        setHydrationError(null);
      } catch (error) {
        const detail =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Unable to restore the orchestration snapshot from the server.";
        setHydrationError(detail);
        setHydrationStatus(useStore.getState().threadsHydrated ? "stale" : "error");
        reportClientDiagnostic({
          source: "websocket",
          category: "websocket",
          severity: "error",
          summary: "Snapshot hydration failed",
          detail,
          context: {
            route: pathnameRef.current,
          },
        });
        // Keep prior state and wait for next domain event to trigger a resync.
      }
      syncing = false;
    };

    const syncInbox = async () => {
      const entries = await api.server.getErrorInbox();
      if (disposed) {
        return;
      }
      syncErrorInbox(entries);
    };

    void syncSnapshot().catch(() => undefined);
    void syncInbox().catch(() => undefined);

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      latestSequence = event.sequence;
      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      }
      void syncSnapshot();
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        await syncSnapshot();
        if (disposed) {
          return;
        }

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      const signature = JSON.stringify(payload.issues);
      if (lastConfigIssuesSignatureRef.current === signature) {
        return;
      }
      lastConfigIssuesSignatureRef.current = signature;
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) =>
                api.shell.openInEditor(config.keybindingsConfigPath, preferredTerminalEditor()),
              )
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    const unsubServerProviderStateUpdated = onServerProviderStateUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    });
    const unsubServerErrorInboxUpdated = onServerErrorInboxUpdated((payload) => {
      upsertErrorInboxEntry(payload.entry);
    });

    const onWindowError = (event: ErrorEvent) => {
      reportClientDiagnostic({
        source: "browser-runtime",
        category: "browser",
        severity: "error",
        summary: event.message || "Unhandled browser error",
        detail: event.error instanceof Error ? event.error.message : event.message || null,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error instanceof Error ? event.error.stack : undefined,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason =
        event.reason instanceof Error
          ? event.reason.message
          : typeof event.reason === "string"
            ? event.reason
            : "Unhandled promise rejection";
      reportClientDiagnostic({
        source: "browser-promise",
        category: "browser",
        severity: "error",
        summary: "Unhandled promise rejection",
        detail: reason,
        context: {
          reason,
          stack: event.reason instanceof Error ? event.reason.stack : undefined,
        },
      });
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      disposed = true;
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubServerProviderStateUpdated();
      unsubServerErrorInboxUpdated();
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [
    navigate,
    pathname,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    syncErrorInbox,
    syncServerReadModel,
    setHydrationStatus,
    setHydrationError,
    upsertErrorInboxEntry,
  ]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
