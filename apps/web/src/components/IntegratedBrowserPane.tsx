import type {
  BrowserPaneBounds,
  BrowserInspectCapture,
  BrowserSessionSnapshot,
  BrowserTabId,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { BROWSER_PANE_MIN_WIDTH, useBrowserPaneStore } from "~/browserPaneStore";
import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { useComposerDraftStore } from "~/composerDraftStore";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

const BOUNDS_SETTLE_DELAYS_MS = [0, 50, 150, 300] as const;
const CHAT_MIN_WIDTH_PX = 540;
const BROWSER_MIN_EFFECTIVE_WIDTH_PX = 280;

function arePaneBoundsEqual(left: BrowserPaneBounds | null, right: BrowserPaneBounds | null): boolean {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.width === right?.width &&
    left?.height === right?.height
  );
}

function resolvePaneWidthClamp(width: number, containerWidth: number): number {
  const maxWidth = Math.max(BROWSER_MIN_EFFECTIVE_WIDTH_PX, containerWidth - CHAT_MIN_WIDTH_PX);
  return Math.max(BROWSER_MIN_EFFECTIVE_WIDTH_PX, Math.min(width, maxWidth));
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error("Invalid screenshot payload.");
  }
  const mimeType = match[1];
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: mimeType });
}

function buildInspectPrompt(capture: BrowserInspectCapture): string {
  const metadata = {
    source: {
      kind: "t3_integrated_browser_inspect_capture",
      appSurface: "desktop-integrated-browser-pane",
      projectId: capture.projectId,
      sessionId: capture.sessionId,
      capturedAt: capture.capturedAt,
    },
    selector: capture.selector,
    tagName: capture.tagName,
    url: capture.url,
    ancestry: capture.ancestry,
    textSummary: capture.textSummary,
    accessibilitySummary: capture.accessibilitySummary,
    sourceUrl: capture.sourceUrl,
    sourceLocation: capture.sourceLocation,
    boundingBox: capture.boundingBox,
    computedStyle: capture.computedStyle,
  };
  return [
    "[T3_BROWSER_INSPECT_CAPTURE]",
    "Source: This element/DOM context was captured from the T3 integrated browser pane.",
    "Provenance: Do not assume this came from external Chrome MCP context.",
    "Use this inspected element as the target for the next edit.",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
  ].join("\n");
}

function createImageAttachment(dataUrl: string) {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `browser-inspect-${Date.now()}`;
  const name = `${id}.png`;
  const file = dataUrlToFile(dataUrl, name);
  return {
    type: "image" as const,
    id,
    name,
    mimeType: file.type || "image/png",
    sizeBytes: file.size,
    previewUrl: dataUrl,
    file,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isBenignBrowserError(error: unknown): boolean {
  return getErrorMessage(error).includes("ERR_ABORTED");
}

interface BrowserPaneProps {
  activeProjectId: ProjectId | null;
  activeThreadId: ThreadId | null;
  activeRuntimeMode: RuntimeMode | null;
}

export default function IntegratedBrowserPane(props: BrowserPaneProps) {
  const { activeProjectId, activeThreadId } = props;
  const { settings } = useAppSettings();
  const open = useBrowserPaneStore((state) => state.open);
  const width = useBrowserPaneStore((state) => state.width);
  const setOpen = useBrowserPaneStore((state) => state.setOpen);
  const setWidth = useBrowserPaneStore((state) => state.setWidth);
  const setPrompt = useComposerDraftStore((state) => state.setPrompt);
  const addImage = useComposerDraftStore((state) => state.addImage);
  const paneRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<BrowserSessionSnapshot | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [isSyncingBounds, setIsSyncingBounds] = useState(false);
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const activeProjectIdRef = useRef<ProjectId | null>(activeProjectId);
  const activeThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  const captureInFlightRef = useRef(false);
  const pendingCapturesRef = useRef(0);
  const lastSyncedBoundsRef = useRef<BrowserPaneBounds | null>(null);
  const pendingBoundsRef = useRef<BrowserPaneBounds | null>(null);
  const syncInFlightRef = useRef(false);
  const api = readNativeApi();
  const isDesktopBrowserAvailable =
    api && typeof window !== "undefined" && Boolean(window.desktopBridge?.browser);
  const session = snapshot?.session ?? null;
  const tabs = snapshot?.tabs ?? [];
  const activeTabId = snapshot?.activeTabId ?? null;
  const activeTab =
    (activeTabId ? tabs.find((tab) => tab.tabId === activeTabId) : null) ??
    (tabs.length > 0 ? tabs[0] : null);
  const effectivePaneWidth =
    containerWidth > 0 ? resolvePaneWidthClamp(width, containerWidth) : width;
  const maxPaneWidth =
    containerWidth > 0
      ? Math.max(BROWSER_MIN_EFFECTIVE_WIDTH_PX, containerWidth - CHAT_MIN_WIDTH_PX)
      : width;

  const handleBrowserError = useCallback((action: string, error: unknown) => {
    if (isBenignBrowserError(error)) {
      return;
    }
    toastManager.add({
      type: "error",
      title: "Browser action failed",
      description: `${action}: ${getErrorMessage(error)}`,
    });
  }, []);

  const runBrowserAction = useCallback(
    async <T,>(action: string, operation: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await operation();
      } catch (error) {
        handleBrowserError(action, error);
        return undefined;
      }
    },
    [handleBrowserError],
  );

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
    activeThreadIdRef.current = activeThreadId;
  }, [activeProjectId, activeThreadId]);

  const drainCaptureQueue = useCallback(() => {
    if (!api?.browser || captureInFlightRef.current) {
      return;
    }

    const projectId = activeProjectIdRef.current;
    const threadId = activeThreadIdRef.current;
    if (!projectId || !threadId || pendingCapturesRef.current <= 0) {
      return;
    }

    pendingCapturesRef.current -= 1;
    captureInFlightRef.current = true;
    void api.browser
      .captureInspectSelection({ projectId })
      .then(async (capture) => {
        if (!capture) {
          return;
        }

        const liveThreadId = activeThreadIdRef.current;
        const liveProjectId = activeProjectIdRef.current;
        if (!liveThreadId || !liveProjectId || liveProjectId !== projectId) {
          return;
        }

        const prompt = buildInspectPrompt(capture);
        const currentPrompt =
          useComposerDraftStore.getState().draftsByThreadId[liveThreadId]?.prompt ?? "";
        const nextPrompt = currentPrompt.trim().length > 0 ? `${currentPrompt}\n\n${prompt}` : prompt;
        setPrompt(liveThreadId, nextPrompt);
        addImage(liveThreadId, createImageAttachment(capture.screenshotDataUrl));

        if (settings.keepInspectModeAfterCapture) {
          const nextSnapshot = await runBrowserAction("restore inspect mode", () =>
            api.browser.setInspectMode({ projectId, enabled: true }),
          );
          if (nextSnapshot) {
            setSnapshot(nextSnapshot);
          }
        }
      })
      .catch((error) => {
        handleBrowserError("capture inspect selection", error);
      })
      .finally(() => {
        captureInFlightRef.current = false;
        const projectIdAfterCapture = activeProjectIdRef.current;
        if (api?.browser && projectIdAfterCapture) {
          void api.browser
            .getState({ projectId: projectIdAfterCapture })
            .then((nextSnapshot) => {
              setSnapshot(nextSnapshot);
            })
            .catch(() => undefined);
        }
        if (pendingCapturesRef.current > 0) {
          drainCaptureQueue();
        }
      });
  }, [addImage, api, handleBrowserError, runBrowserAction, setPrompt, settings.keepInspectModeAfterCapture]);

  useEffect(() => {
    if (!api?.browser) {
      return;
    }
    const unsubscribe = api.browser.onEvent((event) => {
      if (event.type === "pane.requested") {
        setOpen(true);
      }
      if (!activeProjectId || event.projectId !== activeProjectId) {
        return;
      }
      if (event.type === "state.updated") {
        setSnapshot(event.snapshot);
        return;
      }
      if (event.type === "inspect.selection.changed" && event.hasSelection && activeThreadId) {
        pendingCapturesRef.current += 1;
        drainCaptureQueue();
      }
    });
    return unsubscribe;
  }, [
    activeProjectId,
    activeThreadId,
    api,
    drainCaptureQueue,
    setOpen,
  ]);

  useEffect(() => {
    if (!api?.browser || !activeProjectId) {
      setSnapshot(null);
      setUrlInput("");
      return;
    }
    void api.browser
      .getState({ projectId: activeProjectId })
      .then(setSnapshot)
      .catch(() => {
        setSnapshot(null);
      });
  }, [activeProjectId, api]);

  useEffect(() => {
    const nextUrl = activeTab?.navigation.url ?? session?.navigation.url ?? "";
    setUrlInput(nextUrl);
  }, [activeTab?.navigation.url, session?.navigation.url]);

  useEffect(() => {
    if (!open || !activeProjectId) {
      lastSyncedBoundsRef.current = null;
      pendingBoundsRef.current = null;
      syncInFlightRef.current = false;
    }
  }, [activeProjectId, open]);

  useEffect(() => {
    pendingCapturesRef.current = 0;
    captureInFlightRef.current = false;
  }, [activeProjectId, activeThreadId]);

  useEffect(
    () => () => {
      if (!api?.browser) {
        return;
      }
      void api.browser.closePane().catch(() => undefined);
    },
    [api],
  );

  useLayoutEffect(() => {
    const parent = paneRef.current?.parentElement;
    if (!parent) {
      return;
    }

    const updateContainerWidth = () => {
      setContainerWidth(parent.clientWidth);
    };

    updateContainerWidth();
    const observer = new ResizeObserver(updateContainerWidth);
    observer.observe(parent);
    window.addEventListener("resize", updateContainerWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateContainerWidth);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !api?.browser || !activeProjectId || !viewportRef.current) {
      if (!open) {
        void api?.browser?.closePane().catch(() => undefined);
      }
      return;
    }

    let cancelled = false;
    const readBounds = (): BrowserPaneBounds | null => {
      if (!viewportRef.current) {
        return null;
      }
      const rect = viewportRef.current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };

    const flushBounds = async (): Promise<void> => {
      if (syncInFlightRef.current) {
        return;
      }
      const nextBounds = pendingBoundsRef.current;
      if (!nextBounds || arePaneBoundsEqual(lastSyncedBoundsRef.current, nextBounds)) {
        pendingBoundsRef.current = null;
        return;
      }

      syncInFlightRef.current = true;
      setIsSyncingBounds(true);
      try {
        const nextSnapshot = await runBrowserAction("open browser pane", () =>
          api.browser.open({
            projectId: activeProjectId,
            bounds: nextBounds,
          }),
        );
        if (nextSnapshot !== undefined) {
          lastSyncedBoundsRef.current = nextBounds;
          if (arePaneBoundsEqual(pendingBoundsRef.current, nextBounds)) {
            pendingBoundsRef.current = null;
          }
          if (!cancelled) {
            setSnapshot(nextSnapshot);
          }
        } else if (arePaneBoundsEqual(pendingBoundsRef.current, nextBounds)) {
          pendingBoundsRef.current = null;
        }
      } finally {
        syncInFlightRef.current = false;
        if (!cancelled) {
          setIsSyncingBounds(false);
        }
        if (
          pendingBoundsRef.current &&
          !arePaneBoundsEqual(lastSyncedBoundsRef.current, pendingBoundsRef.current)
        ) {
          void flushBounds();
        }
      }
    };

    const requestBoundsSync = () => {
      const nextBounds = readBounds();
      if (!nextBounds) {
        return;
      }
      pendingBoundsRef.current = nextBounds;
      void flushBounds();
    };

    const observer = new ResizeObserver(() => {
      requestBoundsSync();
    });
    observer.observe(viewportRef.current);
    const frameId = window.requestAnimationFrame(() => {
      requestBoundsSync();
    });
    const settleTimeoutIds = BOUNDS_SETTLE_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        requestBoundsSync();
      }, delayMs),
    );
    window.addEventListener("resize", requestBoundsSync);
    window.addEventListener("scroll", requestBoundsSync, true);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      for (const timeoutId of settleTimeoutIds) {
        window.clearTimeout(timeoutId);
      }
      observer.disconnect();
      window.removeEventListener("resize", requestBoundsSync);
      window.removeEventListener("scroll", requestBoundsSync, true);
    };
  }, [activeProjectId, api, effectivePaneWidth, open, runBrowserAction]);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paneRef.current) {
      return;
    }
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = startWidth + delta;
      setWidth(Math.min(nextWidth, maxPaneWidth));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const navigate = async () => {
    if (!api?.browser || !activeProjectId || urlInput.trim().length === 0) {
      return;
    }
    const nextSnapshot = await runBrowserAction("navigate browser", () =>
      api.browser.navigate({
        projectId: activeProjectId,
        url: urlInput,
      }),
    );
    if (nextSnapshot) {
      setSnapshot(nextSnapshot);
    }
  };

  const onUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    void navigate();
  };

  const createTab = () => {
    if (!api?.browser || !activeProjectId) {
      return;
    }
    void runBrowserAction("new browser tab", () =>
      api.browser.newTab({
        projectId: activeProjectId,
      }),
    ).then((nextSnapshot) => {
      if (nextSnapshot) {
        setSnapshot(nextSnapshot);
      }
    });
  };

  const activateTab = (tabId: BrowserTabId) => {
    if (!api?.browser || !activeProjectId) {
      return;
    }
    void runBrowserAction("switch browser tab", () =>
      api.browser.activateTab({ projectId: activeProjectId, tabId }),
    ).then((nextSnapshot) => {
      if (nextSnapshot) {
        setSnapshot(nextSnapshot);
      }
    });
  };

  const closeTab = (tabId: BrowserTabId) => {
    if (!api?.browser || !activeProjectId) {
      return;
    }
    void runBrowserAction("close browser tab", () =>
      api.browser.closeTab({ projectId: activeProjectId, tabId }),
    ).then((nextSnapshot) => {
      if (nextSnapshot) {
        setSnapshot(nextSnapshot);
      }
    });
  };

  const browserOpen = open && isDesktopBrowserAvailable && activeProjectId !== null;
  const controlsDisabled = !browserOpen || !activeProjectId || !api?.browser;

  if (!isDesktopBrowserAvailable || !browserOpen) {
    return null;
  }

  return (
    <aside
      ref={paneRef}
      className="relative flex h-full shrink-0 border-l border-border bg-background"
      data-testid="integrated-browser-pane"
      style={
        {
          width: effectivePaneWidth,
          minWidth: Math.min(BROWSER_PANE_MIN_WIDTH, effectivePaneWidth),
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize"
        onPointerDown={onResizeStart}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 shrink-0 flex-col border-b border-border" data-testid="integrated-browser-top-header">
          <div className="flex h-8 min-w-0 items-center gap-1 px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((tab) => {
                const isActive = tab.tabId === activeTab?.tabId;
                const tabLabel = tab.navigation.title?.trim() || tab.navigation.url || "New tab";
                return (
                  <button
                    key={tab.tabId}
                    type="button"
                    className={cn(
                      "group flex min-w-0 max-w-[180px] items-center gap-1 rounded border px-2 py-0.5 text-xs",
                      isActive
                        ? "border-border bg-muted/70 text-foreground"
                        : "border-transparent bg-muted/40 text-muted-foreground hover:border-border/70 hover:text-foreground",
                    )}
                    onClick={() => activateTab(tab.tabId)}
                    title={tabLabel}
                  >
                    <span className="truncate">{tabLabel}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Close tab ${tabLabel}`}
                      className="rounded p-0.5 opacity-70 hover:bg-background hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.tabId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(tab.tabId);
                        }
                      }}
                    >
                      <XIcon className="size-3" />
                    </span>
                  </button>
                );
              })}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New tab"
              disabled={controlsDisabled}
              onClick={createTab}
            >
              +
            </Button>
          </div>
          <div className="flex h-9 min-w-0 items-center gap-2 px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Back"
                disabled={controlsDisabled || !activeTab?.navigation.canGoBack}
                onClick={() => {
                  if (!activeProjectId) {
                    return;
                  }
                  void runBrowserAction("go back", () =>
                    api.browser.back({ projectId: activeProjectId }),
                  ).then((nextSnapshot) => {
                    if (nextSnapshot) {
                      setSnapshot(nextSnapshot);
                    }
                  });
                }}
              >
                <ArrowLeftIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Forward"
                disabled={controlsDisabled || !activeTab?.navigation.canGoForward}
                onClick={() => {
                  if (!activeProjectId) {
                    return;
                  }
                  void runBrowserAction("go forward", () =>
                    api.browser.forward({ projectId: activeProjectId }),
                  ).then((nextSnapshot) => {
                    if (nextSnapshot) {
                      setSnapshot(nextSnapshot);
                    }
                  });
                }}
              >
                <ArrowRightIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Reload"
                disabled={controlsDisabled}
                onClick={() => {
                  if (!activeProjectId) {
                    return;
                  }
                  void runBrowserAction("reload page", () =>
                    api.browser.reload({ projectId: activeProjectId }),
                  ).then((nextSnapshot) => {
                    if (nextSnapshot) {
                      setSnapshot(nextSnapshot);
                    }
                  });
                }}
              >
                <RefreshCwIcon className={cn(activeTab?.navigation.isLoading && "animate-spin")} />
              </Button>
              <Input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={onUrlKeyDown}
                className="h-8 min-w-[120px] flex-1 basis-0 rounded-md border-border bg-muted/40 text-xs"
                spellCheck={false}
                aria-label="Browser URL"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1" data-testid="integrated-browser-header-actions">
              <Toggle
                pressed={activeTab?.inspectMode === true}
                onPressedChange={(next) => {
                  if (!activeProjectId) {
                    return;
                  }
                  void runBrowserAction("toggle inspect mode", () =>
                    api.browser.setInspectMode({ projectId: activeProjectId, enabled: next }),
                  ).then((nextSnapshot) => {
                    if (nextSnapshot) {
                      setSnapshot(nextSnapshot);
                    }
                  });
                }}
                variant="outline"
                size="sm"
                aria-label="Inspect element"
                disabled={controlsDisabled}
              >
                <SearchIcon className="size-3.5" />
              </Toggle>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Kill browser"
                disabled={controlsDisabled}
                onClick={() => {
                  if (!activeProjectId) {
                    return;
                  }
                  void runBrowserAction("kill browser", () =>
                    api.browser.kill({ projectId: activeProjectId }),
                  ).then(() => {
                    setSnapshot(null);
                  });
                }}
              >
                <GlobeIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Collapse browser"
                onClick={() => setOpen(false)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <div
            ref={viewportRef}
            className="absolute inset-0"
            data-integrated-browser-native-viewport="true"
          />
          {(isSyncingBounds || !activeTab) && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
              Loading browser...
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
