import { ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  var __browserRuntimeTestLog: string[] | undefined;
}

vi.mock("electron", () => {
  class TinyEmitter {
    private readonly listeners = new Map<string, Array<(...args: Array<unknown>) => void>>();

    on(event: string, listener: (...args: Array<unknown>) => void) {
      const next = this.listeners.get(event) ?? [];
      next.push(listener);
      this.listeners.set(event, next);
      return this;
    }

    emit(event: string, ...args: Array<unknown>) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    }
  }

  class MockWebContents extends TinyEmitter {
    id = Math.floor(Math.random() * 100_000);
    currentUrl = "";
    title = "";
    loading = false;
    zoomFactor = 1;
    setZoomFactorCalls: number[] = [];
    executeJavaScriptCalls: string[] = [];
    ownerView: MockWebContentsView | null = null;
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined,
    };

    async loadURL(url: string): Promise<void> {
      this.loading = true;
      this.currentUrl = url;
      this.emit("did-start-loading");
      this.emit("did-navigate");
      this.loading = false;
      this.emit("dom-ready");
      this.emit("did-finish-load");
      this.emit("did-stop-loading");
    }

    getURL(): string {
      return this.currentUrl;
    }

    getTitle(): string {
      return this.title;
    }

    isLoading(): boolean {
      return this.loading;
    }

    async executeJavaScript(script?: string): Promise<unknown> {
      if (typeof script === "string") {
        this.executeJavaScriptCalls.push(script);
      }
      return null;
    }

    async capturePage() {
      return {
        toPNG: () => Buffer.from(""),
      };
    }

    reload(): void {}

    close(): void {}

    sendInputEvent(): void {}

    getZoomFactor(): number {
      return this.zoomFactor;
    }

    setZoomFactor(factor: number): void {
      this.zoomFactor = factor;
      this.setZoomFactorCalls.push(factor);
    }
  }

  class MockWebContentsView {
    readonly webContents = new MockWebContents();
    readonly setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
    readonly setVisibleCalls: boolean[] = [];
    readonly partition: string | null;
    private bounds = { x: 0, y: 0, width: 0, height: 0 };

    constructor(options?: { webPreferences?: { partition?: string } }) {
      this.partition = options?.webPreferences?.partition ?? null;
      this.webContents.ownerView = this;
    }

    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      globalThis.__browserRuntimeTestLog?.push("setBounds");
      this.bounds = { ...bounds };
      this.setBoundsCalls.push({ ...bounds });
    }

    getBounds() {
      return this.bounds;
    }

    setVisible(visible: boolean): void {
      this.setVisibleCalls.push(visible);
    }
  }

  return {
    BrowserWindow: undefined,
    session: {
      fromPartition: vi.fn(() => ({
        clearCache: vi.fn(async () => undefined),
        clearStorageData: vi.fn(async () => undefined),
      })),
    },
    WebContentsView: MockWebContentsView,
  };
});

import { BROWSER_STORAGE_PARTITION, BrowserRuntimeRegistry } from "./browserRuntime";

interface TestWebContents {
  currentUrl: string;
  loadURL: (url: string) => Promise<void>;
  setZoomFactorCalls: number[];
  executeJavaScriptCalls: string[];
}

interface TestView {
  webContents: TestWebContents;
  partition: string | null;
  setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }>;
  setVisibleCalls: boolean[];
}

interface TestTabRuntime {
  view: TestView;
}

interface TestProjectRuntime {
  tabs: Map<string, TestTabRuntime>;
  activeTabId: string | null;
}

function getProjectRuntime(registry: BrowserRuntimeRegistry, projectId: ProjectId): TestProjectRuntime {
  const runtime = ((registry as any).runtimes as Map<ProjectId, TestProjectRuntime>).get(projectId);
  expect(runtime).toBeDefined();
  return runtime!;
}

function getActiveTabRuntime(registry: BrowserRuntimeRegistry, projectId: ProjectId): TestTabRuntime {
  const projectRuntime = getProjectRuntime(registry, projectId);
  expect(projectRuntime.activeTabId).toBeTruthy();
  const tab = projectRuntime.activeTabId
    ? projectRuntime.tabs.get(projectRuntime.activeTabId)
    : undefined;
  expect(tab).toBeDefined();
  return tab!;
}

describe("BrowserRuntimeRegistry", () => {
  beforeEach(() => {
    globalThis.__browserRuntimeTestLog = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    globalThis.__browserRuntimeTestLog = undefined;
  });

  it("suppresses abort-style navigation errors after a non-blank page commits", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-1");

    await registry.ensure(projectId);
    const tab = getActiveTabRuntime(registry, projectId);
    tab.view.webContents.loadURL = async () => {
      tab.view.webContents.currentUrl = "https://www.google.com/";
      throw new Error("ERR_ABORTED");
    };

    await expect(registry.navigate(projectId, "google.com")).resolves.toMatchObject({
      session: expect.objectContaining({
        navigation: expect.objectContaining({
          url: "https://google.com",
        }),
      }),
    });
  });

  it("still throws abort-style navigation errors when nothing committed", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-2");

    await registry.ensure(projectId);
    const tab = getActiveTabRuntime(registry, projectId);
    tab.view.webContents.loadURL = async () => {
      tab.view.webContents.currentUrl = "about:blank";
      throw new Error("ERR_ABORTED");
    };

    await expect(registry.navigate(projectId, "https://example.com")).rejects.toThrow("ERR_ABORTED");
  });

  it("uses the shared persistent browser partition", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-persistent-1");
    const otherProjectId = ProjectId.makeUnsafe("project-persistent-2");

    await registry.ensure(projectId);
    await registry.ensure(otherProjectId);
    const tab = getActiveTabRuntime(registry, projectId);
    const otherTab = getActiveTabRuntime(registry, otherProjectId);
    expect(tab.view.partition).toBe(BROWSER_STORAGE_PARTITION);
    expect(otherTab.view.partition).toBe(BROWSER_STORAGE_PARTITION);
  });

  it("enforces browser approval and history policies", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-policy-1");

    await registry.updateSettings({
      approvalPolicy: "deny",
      historyPolicy: "deny",
    });

    await expect(registry.ensure(projectId)).rejects.toThrow("Browser opening is disabled");

    await registry.updateSettings({ approvalPolicy: "allow" });
    await registry.ensure(projectId);
    await expect(registry.back(projectId)).rejects.toThrow("Browser history access is disabled");
  });

  it("attaches the native view before applying pane bounds", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const addChildView = vi.fn((view: unknown) => {
      globalThis.__browserRuntimeTestLog?.push("addChildView");
      return view;
    });
    const window = {
      contentView: {
        addChildView,
        removeChildView: vi.fn(),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-3");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 10, y: 20, width: 320, height: 240 });
    vi.runAllTimers();

    const tab = getActiveTabRuntime(registry, projectId);
    expect(addChildView).toHaveBeenCalledWith(tab.view);
    expect(globalThis.__browserRuntimeTestLog?.indexOf("addChildView")).toBeLessThan(
      globalThis.__browserRuntimeTestLog?.indexOf("setBounds") ?? Number.POSITIVE_INFINITY,
    );
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 10,
      y: 20,
      width: 320,
      height: 240,
    });
    expect(tab.view.setVisibleCalls.at(-1)).toBe(true);
  });

  it("updates pane state when reopening with new bounds", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-4");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 10, y: 20, width: 320, height: 240 });
    const snapshot = await registry.open(projectId, { x: 25, y: 35, width: 480, height: 360 });
    vi.runAllTimers();
    const tab = getActiveTabRuntime(registry, projectId);

    expect(snapshot.paneOpen).toBe(true);
    expect(snapshot.paneProjectId).toBe(projectId);
    expect(snapshot.paneBounds).toEqual({ x: 25, y: 35, width: 480, height: 360 });
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 25,
      y: 35,
      width: 480,
      height: 360,
    });
  });

  it("detaches the pane without discarding the runtime and reapplies exact bounds on reopen", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    const window = {
      contentView: {
        addChildView,
        removeChildView,
      },
    };
    const projectId = ProjectId.makeUnsafe("project-5");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 10, y: 20, width: 420, height: 320 });
    vi.runAllTimers();
    const tab = getActiveTabRuntime(registry, projectId);
    await registry.closePane();
    expect(removeChildView).toHaveBeenCalledWith(tab.view);
    expect((registry as any).attachedProjectId).toBeNull();
    expect((registry as any).paneOpen).toBe(false);
    expect((registry as any).paneBounds).toBeNull();
    expect(((registry as any).runtimes as Map<ProjectId, unknown>).has(projectId)).toBe(true);

    const reopened = await registry.open(projectId, { x: 25, y: 35, width: 480, height: 360 });
    vi.runAllTimers();

    expect(reopened.paneOpen).toBe(true);
    expect(reopened.paneProjectId).toBe(projectId);
    expect(reopened.paneBounds).toEqual({ x: 25, y: 35, width: 480, height: 360 });
    expect(addChildView).toHaveBeenCalledTimes(2);
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 25,
      y: 35,
      width: 480,
      height: 360,
    });
    expect(tab.view.webContents.setZoomFactorCalls).toHaveLength(0);
  });

  it("clears attachment state if the window is already destroyed while detaching", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const removeChildView = vi.fn(() => {
      throw new Error("Object has been destroyed");
    });
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: vi.fn(),
        removeChildView,
      },
    };
    const projectId = ProjectId.makeUnsafe("project-destroyed-window");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 10, y: 20, width: 420, height: 320 });

    expect(() => registry.setWindow(null)).not.toThrow();
    expect(removeChildView).toHaveBeenCalledTimes(1);
    expect((registry as any).attachedProjectId).toBeNull();
    expect((registry as any).attachedTabId).toBeNull();
  });

  it("applies requested pane bounds directly to the native view", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-6");

    registry.setWindow(window as never);
    const snapshot = await registry.open(projectId, { x: 500, y: 35, width: 200, height: 360 });
    vi.runAllTimers();
    const tab = getActiveTabRuntime(registry, projectId);

    expect(snapshot.paneBounds).toEqual({ x: 500, y: 35, width: 200, height: 360 });
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 500,
      y: 35,
      width: 200,
      height: 360,
    });

    await registry.open(projectId, { x: 580, y: 35, width: 200, height: 360 });
    vi.runAllTimers();

    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 580,
      y: 35,
      width: 200,
      height: 360,
    });
  });

  it("avoids viewport remeasurement when resizing the already attached tab", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const measureViewport = vi.fn(async () => null);
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      webContents: {
        executeJavaScript: measureViewport,
      },
    };
    const projectId = ProjectId.makeUnsafe("project-6-resize");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 500, y: 35, width: 200, height: 360 });
    await registry.open(projectId, { x: 560, y: 35, width: 240, height: 360 });

    expect(measureViewport).toHaveBeenCalledTimes(1);
  });

  it("scales renderer pane bounds by the host zoom factor before applying native bounds", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      webContents: {
        getZoomFactor: vi.fn(() => 0.8),
        executeJavaScript: vi.fn(async () => null),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-6b");

    registry.setWindow(window as never);
    await registry.open(projectId, { x: 500, y: 35, width: 200, height: 360 });
    vi.runAllTimers();
    const tab = getActiveTabRuntime(registry, projectId);
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 400,
      y: 28,
      width: 160,
      height: 288,
    });
  });

  it("keeps the latest pane bounds when open requests resolve out of order", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-7");

    registry.setWindow(window as never);
    await registry.ensure(projectId);

    let resolveFirstOpen: () => void = () => undefined;
    const firstOpenGate = new Promise<void>((resolve) => {
      resolveFirstOpen = () => resolve();
    });
    const originalEnsureRuntime = (registry as any).ensureRuntime.bind(registry) as (
      projectId: ProjectId,
    ) => Promise<unknown>;
    let ensureInvocationCount = 0;

    (registry as any).ensureRuntime = vi.fn(async (nextProjectId: ProjectId) => {
      ensureInvocationCount += 1;
      if (ensureInvocationCount === 1) {
        await firstOpenGate;
      }
      return originalEnsureRuntime(nextProjectId);
    });

    const staleOpen = registry.open(projectId, { x: 540, y: 35, width: 200, height: 360 });
    await Promise.resolve();
    const latestSnapshot = await registry.open(projectId, { x: 420, y: 35, width: 260, height: 360 });
    resolveFirstOpen();
    await staleOpen;
    vi.runAllTimers();

    expect(latestSnapshot.paneBounds).toEqual({ x: 420, y: 35, width: 260, height: 360 });
    const tab = getActiveTabRuntime(registry, projectId);
    expect(tab.view.setBoundsCalls.at(-1)).toEqual({
      x: 420,
      y: 35,
      width: 260,
      height: 360,
    });
  });

  it("ignores async viewport measurements after the pane closes", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    let resolveViewportMeasurement: (value: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null) => void = () => undefined;
    const viewportMeasurementGate = new Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>((resolve) => {
      resolveViewportMeasurement = resolve;
    });
    const window = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      webContents: {
        executeJavaScript: vi.fn(() => viewportMeasurementGate),
      },
    };
    const projectId = ProjectId.makeUnsafe("project-8");

    registry.setWindow(window as never);
    const openPromise = registry.open(projectId, { x: 10, y: 20, width: 320, height: 240 });
    await Promise.resolve();

    await registry.closePane();
    resolveViewportMeasurement({ x: 25, y: 35, width: 480, height: 360 });

    await openPromise;
    vi.runAllTimers();
    await Promise.resolve();
    const tab = getActiveTabRuntime(registry, projectId);
    expect(tab.view.setBoundsCalls).toHaveLength(0);
    expect((registry as any).paneOpen).toBe(false);
    expect((registry as any).paneBounds).toBeNull();
    expect((registry as any).attachedProjectId).toBeNull();
  });

  it("creates, activates, and closes tabs while tracking the active tab", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-tabs-1");

    const initial = await registry.ensure(projectId);
    expect(initial.tabs).toHaveLength(1);
    expect(initial.activeTabId).toBe(initial.tabs?.[0]?.tabId ?? null);

    const withSecondTab = await registry.newTab(projectId, "https://example.com");
    expect(withSecondTab.tabs).toHaveLength(2);
    const firstTabId = initial.tabs?.[0]?.tabId;
    const secondTabId = withSecondTab.activeTabId;
    expect(secondTabId).not.toBe(firstTabId);

    expect(firstTabId).toBeTruthy();
    if (!firstTabId) {
      throw new Error("Expected first tab id");
    }

    const reactivated = await registry.activateTab(projectId, firstTabId);
    expect(reactivated.activeTabId).toBe(firstTabId);

    const closed = await registry.closeTab(projectId, firstTabId);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).not.toBe(firstTabId);
  });

  it("recreates a default-start replacement tab when closing the last tab", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-tabs-2");

    const initial = await registry.ensure(projectId);
    const initialTabId = initial.activeTabId;
    expect(initialTabId).toBeTruthy();
    if (!initialTabId) {
      throw new Error("Expected initial tab id");
    }

    const afterClose = await registry.closeTab(projectId, initialTabId);
    expect(afterClose.tabs).toHaveLength(1);
    expect(afterClose.activeTabId).toBeTruthy();
    expect(afterClose.activeTabId).not.toBe(initialTabId);
    expect(afterClose.session?.navigation.url).toBe("https://www.google.com");
  });

  it("injects a visible agent cursor for browser interactions", async () => {
    const registry = new BrowserRuntimeRegistry({ browserPreloadPath: "test-preload.js" });
    const projectId = ProjectId.makeUnsafe("project-agent-cursor");

    await registry.ensure(projectId);
    const tab = getActiveTabRuntime(registry, projectId);
    tab.view.webContents.executeJavaScriptCalls = [];

    await registry.click(projectId, "button.primary");

    const script = tab.view.webContents.executeJavaScriptCalls.join("\n");
    expect(script).toContain("__t3_browser_agent_cursor");
    expect(script).toContain("button.primary");
    expect(script).toContain('moveTo(x, y, "click")');
  });
});
