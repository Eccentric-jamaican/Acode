import type {
  BrowserPaneBounds,
  BrowserSessionSnapshot,
  BrowserTabId,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { inspectCaptureLabel } from "~/browserInspectCapture";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import {
  resolveBrowserNavigationUrl,
} from "./IntegratedBrowserPane.logic";

const BOUNDS_SETTLE_DELAYS_MS = [0, 50, 150, 300] as const;
const CHAT_MIN_WIDTH_PX = 540;
const BROWSER_MIN_EFFECTIVE_WIDTH_PX = 280;
const EMPTY_BROWSER_TABS: ReadonlyArray<NonNullable<BrowserSessionSnapshot["tabs"]>[number]> = [];

interface BrowserUrlInputProps {
  value: string;
  onChange: (nextValue: string) => void;
  onSubmit: (nextValue: string) => void;
  disabled: boolean;
  className?: string;
  ariaLabel: string;
}

function BrowserUrlInput(props: BrowserUrlInputProps) {
  const { value, onChange, onSubmit, disabled, className, ariaLabel } = props;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      onSubmit(value);
    },
    [onSubmit, value],
  );

  return (
    <div className="min-w-[120px] flex-1 basis-0">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        className={className}
        spellCheck={false}
        aria-label={ariaLabel}
        disabled={disabled}
      />
    </div>
  );
}

function arePaneBoundsEqual(
  left: BrowserPaneBounds | null,
  right: BrowserPaneBounds | null,
): boolean {
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
  open: boolean;
  layout?: "aside" | "panel";
  onRequestOpen: () => void;
  onRequestClose: () => void;
}

interface BrowserTabsStripProps {
  tabs: ReadonlyArray<NonNullable<BrowserSessionSnapshot["tabs"]>[number]>;
  activeTabId: BrowserTabId | null;
  controlsDisabled: boolean;
  onActivateTab: (tabId: BrowserTabId) => void;
  onCloseTab: (tabId: BrowserTabId) => void;
}

function BrowserTabsStrip(props: BrowserTabsStripProps) {
  const { tabs, activeTabId, controlsDisabled, onActivateTab, onCloseTab } = props;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.tabId === activeTabId;
        const tabLabel = tab.navigation.title?.trim() || tab.navigation.url || "New tab";
        return (
          <div
            key={tab.tabId}
            className={cn(
              "group flex min-w-0 max-w-[180px] items-center rounded border text-xs",
              isActive
                ? "border-border bg-muted/70 text-foreground"
                : "border-transparent bg-muted/40 text-muted-foreground hover:border-border/70 hover:text-foreground",
            )}
            title={tabLabel}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate py-0.5 pl-2 pr-1 text-left"
              disabled={controlsDisabled}
              onClick={() => onActivateTab(tab.tabId)}
            >
              {tabLabel}
            </button>
            <button
              type="button"
              aria-label={`Close tab ${tabLabel}`}
              className="mr-1 rounded p-0.5 opacity-70 hover:bg-background hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              disabled={controlsDisabled}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.tabId);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function IntegratedBrowserPane(props: BrowserPaneProps) {
  const {
    activeProjectId,
    activeThreadId,
    open,
    layout = "aside",
    onRequestClose,
  } = props;
  const usesAsideLayout = layout === "aside";
  const { settings } = useAppSettings();
  const width = useBrowserPaneStore((state) => state.width);
  const setWidth = useBrowserPaneStore((state) => state.setWidth);
  const addImage = useComposerDraftStore((state) => state.addImage);
  const addInspectCapture = useComposerDraftStore((state) => state.addInspectCapture);
  const paneRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<BrowserSessionSnapshot | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const activeProjectIdRef = useRef<ProjectId | null>(activeProjectId);
  const activeThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  const captureInFlightRef = useRef(false);
  const pendingCapturesRef = useRef(0);
  const lastDispatchedBoundsRef = useRef<BrowserPaneBounds | null>(null);
  const latestBoundsRequestSeqRef = useRef(0);
  const latestBoundsResponseSeqRef = useRef(0);
  const api = readNativeApi();
  const isDesktopBrowserAvailable =
    api && typeof window !== "undefined" && Boolean(window.desktopBridge?.browser);
  const session = snapshot?.session ?? null;
  const tabs = snapshot?.tabs ?? EMPTY_BROWSER_TABS;
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

        addInspectCapture(liveThreadId, {
          id:
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `inspect-${Date.now()}`,
          label: inspectCaptureLabel(capture),
          capture,
        });
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
  }, [
    addImage,
    addInspectCapture,
    api,
    handleBrowserError,
    runBrowserAction,
    settings.keepInspectModeAfterCapture,
  ]);

  useEffect(() => {
    if (!api?.browser) {
      return;
    }
    const unsubscribe = api.browser.onEvent((event) => {
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
  }, [activeProjectId, activeThreadId, api, drainCaptureQueue]);

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
      lastDispatchedBoundsRef.current = null;
      latestBoundsRequestSeqRef.current = 0;
      latestBoundsResponseSeqRef.current = 0;
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
    if (!usesAsideLayout) {
      return;
    }
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
  }, [open, usesAsideLayout]);

  useLayoutEffect(() => {
    if (!open || !api?.browser || !activeProjectId || !viewportRef.current) {
      if (!open) {
        void api?.browser?.closePane().catch(() => undefined);
      }
      return;
    }

    let cancelled = false;
    let animationFrameId: number | null = null;
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

    const requestBoundsSync = () => {
      const nextBounds = readBounds();
      if (!nextBounds) {
        return;
      }
      if (arePaneBoundsEqual(lastDispatchedBoundsRef.current, nextBounds)) {
        return;
      }
      lastDispatchedBoundsRef.current = nextBounds;
      const requestSeq = ++latestBoundsRequestSeqRef.current;
      void runBrowserAction("open browser pane", () =>
        api.browser.open({
          projectId: activeProjectId,
          bounds: nextBounds,
        }),
      ).then((nextSnapshot) => {
        if (nextSnapshot === undefined) {
          return;
        }
        if (requestSeq < latestBoundsResponseSeqRef.current) {
          return;
        }
        latestBoundsResponseSeqRef.current = requestSeq;
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      });
    };

    const requestBoundsSyncOnNextFrame = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        requestBoundsSync();
      });
    };

    const observer = new ResizeObserver(() => {
      requestBoundsSyncOnNextFrame();
    });
    observer.observe(viewportRef.current);
    requestBoundsSyncOnNextFrame();
    const settleTimeoutIds = BOUNDS_SETTLE_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        requestBoundsSync();
      }, delayMs),
    );
    window.addEventListener("resize", requestBoundsSyncOnNextFrame);
    window.addEventListener("scroll", requestBoundsSyncOnNextFrame, true);
    return () => {
      cancelled = true;
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      for (const timeoutId of settleTimeoutIds) {
        window.clearTimeout(timeoutId);
      }
      observer.disconnect();
      window.removeEventListener("resize", requestBoundsSyncOnNextFrame);
      window.removeEventListener("scroll", requestBoundsSyncOnNextFrame, true);
    };
  }, [activeProjectId, api, effectivePaneWidth, open, runBrowserAction]);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paneRef.current) {
      return;
    }
    event.preventDefault();
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

  const navigate = async (nextInput?: string) => {
    const rawTarget = (nextInput ?? urlInput).trim();
    if (!api?.browser || !activeProjectId || rawTarget.length === 0) {
      return;
    }
    const targetUrl = resolveBrowserNavigationUrl(rawTarget);
    const nextSnapshot = await runBrowserAction("navigate browser", () =>
      api.browser.navigate({
        projectId: activeProjectId,
        url: targetUrl,
      }),
    );
    if (nextSnapshot) {
      setSnapshot(nextSnapshot);
    }
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

  if (!usesAsideLayout) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn("relative z-[60] flex min-w-0 shrink-0 flex-col border-b border-border")}
          data-testid="integrated-browser-top-header"
        >
          <div className="flex h-8 min-w-0 items-center gap-1 px-2">
            <BrowserTabsStrip
              tabs={tabs}
              activeTabId={activeTab?.tabId ?? null}
              controlsDisabled={controlsDisabled}
              onActivateTab={activateTab}
              onCloseTab={closeTab}
            />
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
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
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
              <BrowserUrlInput
                value={urlInput}
                onChange={setUrlInput}
                onSubmit={(nextValue) => {
                  void navigate(nextValue);
                }}
                disabled={controlsDisabled}
                className="h-8 min-w-[120px] flex-1 basis-0 rounded-md border-border bg-muted/40 text-xs"
                ariaLabel="Browser URL"
              />
            </div>
            <div
              className="flex shrink-0 items-center gap-1"
              data-testid="integrated-browser-header-actions"
            >
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
                aria-label="Collapse browser"
                onClick={onRequestClose}
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
          {!activeTab && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
              Loading browser...
            </div>
          )}
        </div>
      </div>
    );
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
        <div
          className={cn("relative z-[60] flex min-w-0 shrink-0 flex-col border-b border-border")}
          data-testid="integrated-browser-top-header"
        >
          <div className="flex h-8 min-w-0 items-center gap-1 px-2">
            <BrowserTabsStrip
              tabs={tabs}
              activeTabId={activeTab?.tabId ?? null}
              controlsDisabled={controlsDisabled}
              onActivateTab={activateTab}
              onCloseTab={closeTab}
            />
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
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
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
              <BrowserUrlInput
                value={urlInput}
                onChange={setUrlInput}
                onSubmit={(nextValue) => {
                  void navigate(nextValue);
                }}
                disabled={controlsDisabled}
                className="h-8 min-w-[120px] flex-1 basis-0 rounded-md border-border bg-muted/40 text-xs"
                ariaLabel="Browser URL"
              />
            </div>
            <div
              className="flex shrink-0 items-center gap-1"
              data-testid="integrated-browser-header-actions"
            >
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
                aria-label="Collapse browser"
                onClick={onRequestClose}
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
          {!activeTab && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
              Loading browser...
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
