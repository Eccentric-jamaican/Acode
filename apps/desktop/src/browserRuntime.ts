import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  BrowserClearBrowsingDataInput,
  BrowserInspectCapture,
  BrowserNavigationState,
  BrowserPaneBounds,
  BrowserRuntimeEvent,
  BrowserSessionSnapshot,
  BrowserSessionSummary,
  BrowserTabId,
  BrowserUseSettings,
  BrowserUseSettingsPatch,
  ProjectId,
} from "@t3tools/contracts";
import { BrowserWindow, session as electronSession, WebContentsView } from "electron";

const INSPECT_OVERLAY_ID = "__t3_browser_inspect_overlay";
const AGENT_CURSOR_ID = "__t3_browser_agent_cursor";
const AGENT_CURSOR_SCRIPT = String.raw`
(() => {
  const cursorId = ${JSON.stringify(AGENT_CURSOR_ID)};
  let cursor = document.getElementById(cursorId);
  if (!(cursor instanceof HTMLElement)) {
    cursor = document.createElement("div");
    cursor.id = cursorId;
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.position = "fixed";
    cursor.style.left = "0px";
    cursor.style.top = "0px";
    cursor.style.width = "18px";
    cursor.style.height = "18px";
    cursor.style.pointerEvents = "none";
    cursor.style.zIndex = "2147483647";
    cursor.style.transform = "translate(-50%, -50%)";
    cursor.style.transition = "left 90ms ease-out, top 90ms ease-out, opacity 80ms ease-out, scale 80ms ease-out";
    cursor.style.opacity = "0";
    cursor.style.borderRadius = "9999px";
    cursor.style.background = "rgba(16, 185, 129, 0.28)";
    cursor.style.border = "2px solid rgba(16, 185, 129, 0.98)";
    cursor.style.boxShadow = "0 0 0 5px rgba(16, 185, 129, 0.16), 0 8px 18px rgba(0, 0, 0, 0.28)";

    const dot = document.createElement("div");
    dot.style.position = "absolute";
    dot.style.left = "50%";
    dot.style.top = "50%";
    dot.style.width = "4px";
    dot.style.height = "4px";
    dot.style.borderRadius = "9999px";
    dot.style.background = "white";
    dot.style.transform = "translate(-50%, -50%)";
    dot.style.boxShadow = "0 0 5px rgba(0, 0, 0, 0.35)";
    cursor.appendChild(dot);
    document.documentElement.appendChild(cursor);
  }

  const moveTo = (x, y, intent) => {
    const safeX = Math.max(0, Math.min(window.innerWidth, Number(x) || 0));
    const safeY = Math.max(0, Math.min(window.innerHeight, Number(y) || 0));
    cursor.style.left = safeX + "px";
    cursor.style.top = safeY + "px";
    cursor.style.opacity = "1";
    cursor.style.scale = intent === "click" ? "0.82" : "1";
    window.clearTimeout(window.__t3BrowserAgentCursorScaleTimer);
    window.__t3BrowserAgentCursorScaleTimer = window.setTimeout(() => {
      cursor.style.scale = "1";
    }, 90);
    window.clearTimeout(window.__t3BrowserAgentCursorHideTimer);
    window.__t3BrowserAgentCursorHideTimer = window.setTimeout(() => {
      cursor.style.opacity = "0.52";
    }, 1400);
  };

  window.__t3BrowserAgentCursor = { moveTo };
  return true;
})()
`;
const INSPECT_SCRIPT = String.raw`
(() => {
  const host = window.__t3BrowserHost;
  if (!host || typeof host.inspectSelectionChanged !== "function") {
    return false;
  }
  if (typeof window.__t3BrowserInspectCleanup === "function") {
    window.__t3BrowserInspectCleanup();
  }

  let hovered = null;
  const overlay = document.createElement("div");
  overlay.id = ${JSON.stringify(INSPECT_OVERLAY_ID)};
  overlay.style.position = "fixed";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";
  overlay.style.border = "2px solid rgba(59, 130, 246, 0.95)";
  overlay.style.background = "rgba(59, 130, 246, 0.14)";
  overlay.style.borderRadius = "4px";
  overlay.style.boxSizing = "border-box";
  overlay.style.display = "none";
  document.documentElement.appendChild(overlay);

  const currentSelection = window.__t3BrowserSelectedElement instanceof Element
    ? window.__t3BrowserSelectedElement
    : null;

  const updateOverlay = (target) => {
    if (!(target instanceof Element)) {
      overlay.style.display = "none";
      return;
    }
    const rect = target.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  };

  if (currentSelection) {
    updateOverlay(currentSelection);
    host.inspectSelectionChanged(true);
  } else {
    host.inspectSelectionChanged(false);
  }

  const resolveTarget = (event) => event.target instanceof Element ? event.target : null;

  const onMouseMove = (event) => {
    if (window.__t3BrowserSelectedElement instanceof Element) {
      updateOverlay(window.__t3BrowserSelectedElement);
      return;
    }
    hovered = resolveTarget(event);
    updateOverlay(hovered);
  };

  const onClick = (event) => {
    const target = resolveTarget(event);
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    window.__t3BrowserSelectedElement = target;
    updateOverlay(target);
    host.inspectSelectionChanged(true);
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    delete window.__t3BrowserSelectedElement;
    hovered = null;
    updateOverlay(null);
    host.inspectSelectionChanged(false);
  };

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);

  window.__t3BrowserInspectCleanup = () => {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  };

  return true;
})()
`;

const DISABLE_INSPECT_SCRIPT = String.raw`
(() => {
  if (typeof window.__t3BrowserInspectCleanup === "function") {
    window.__t3BrowserInspectCleanup();
    delete window.__t3BrowserInspectCleanup;
  }
  return window.__t3BrowserSelectedElement instanceof Element;
})()
`;

const CLEAR_SELECTION_SCRIPT = String.raw`
(() => {
  delete window.__t3BrowserSelectedElement;
  return true;
})()
`;

const CAPTURE_SELECTION_SCRIPT = String.raw`
(() => {
  const element = window.__t3BrowserSelectedElement instanceof Element
    ? window.__t3BrowserSelectedElement
    : null;
  if (!element) {
    return null;
  }

  const toSelector = (target) => {
    const parts = [];
    let current = target;
    while (current instanceof Element && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += "#" + current.id.replace(/[^a-zA-Z0-9_-]+/g, "");
        parts.unshift(part);
        break;
      }
      if (current.classList.length > 0) {
        part += "." + Array.from(current.classList).slice(0, 2).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (candidate) => candidate.tagName === current.tagName,
        );
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };

  const toDescriptor = (target) => {
    let value = target.tagName.toLowerCase();
    if (target.id) {
      value += "#" + target.id;
    }
    if (target.classList.length > 0) {
      value += "." + Array.from(target.classList).slice(0, 2).join(".");
    }
    return value;
  };

  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const textSummary = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const accessibilityParts = [
    element.getAttribute("aria-label"),
    element.getAttribute("role"),
    element.getAttribute("name"),
    element.getAttribute("alt"),
    element.getAttribute("title"),
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  const ancestry = [];
  let current = element;
  while (current instanceof Element && ancestry.length < 6) {
    ancestry.unshift(toDescriptor(current));
    current = current.parentElement;
  }

  const sourceUrl = element instanceof HTMLImageElement
    ? element.currentSrc || element.src || null
    : element instanceof HTMLAnchorElement
      ? element.href || null
      : null;

  return {
    url: window.location.href,
    tagName: element.tagName.toLowerCase(),
    selector: toSelector(element),
    ancestry,
    textSummary,
    accessibilitySummary: accessibilityParts.join(" | "),
    sourceUrl,
    sourceLocation: null,
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    computedStyle: {
      display: computed.display,
      position: computed.position,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
      padding: computed.padding,
      margin: computed.margin,
      border: computed.border,
      borderRadius: computed.borderRadius,
    },
  };
})()
`;

const MAX_TEXT_LENGTH = 20_000;
const WAIT_POLL_INTERVAL_MS = 100;
const ATTACHED_BOUNDS_REAPPLY_DELAYS_MS = [0, 75, 200, 500] as const;
const INTEGRATED_BROWSER_VIEWPORT_SELECTOR = '[data-integrated-browser-native-viewport="true"]';
const DEFAULT_NEW_TAB_URL = "https://www.google.com";
export const BROWSER_STORAGE_PARTITION = "persist:t3-browser-default";

const DEFAULT_BROWSER_USE_SETTINGS: BrowserUseSettings = {
  approvalPolicy: "alwaysAsk",
  historyPolicy: "alwaysAsk",
  blockedDomains: [],
  allowedDomains: [],
};

interface BrowserTabRuntimeRecord {
  tabId: BrowserTabId;
  sessionId: string;
  projectId: ProjectId;
  view: Electron.WebContentsView;
  createdAt: string;
  updatedAt: string;
  inspectMode: boolean;
  hasSelection: boolean;
  navigation: BrowserNavigationState;
}

interface BrowserProjectRuntimeRecord {
  projectId: ProjectId;
  tabs: Map<BrowserTabId, BrowserTabRuntimeRecord>;
  tabOrder: BrowserTabId[];
  activeTabId: BrowserTabId | null;
}

function isNavigationAbortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_ABORTED") || message.includes("ERR_FAILED");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBounds(bounds: BrowserPaneBounds): BrowserPaneBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

async function readIntegratedBrowserViewportBounds(
  window: BrowserWindow | null,
): Promise<BrowserPaneBounds | null> {
  if (!window) {
    return null;
  }

  try {
    const result = await window.webContents.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(INTEGRATED_BROWSER_VIEWPORT_SELECTOR)});
        if (!(element instanceof HTMLElement)) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) {
          return null;
        }

        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })()`,
      true,
    );

    if (
      !result ||
      typeof result !== "object" ||
      !("x" in result) ||
      !("y" in result) ||
      !("width" in result) ||
      !("height" in result)
    ) {
      return null;
    }

    const candidate = result as Record<string, unknown>;
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const width = Number(candidate.width);
    const height = Number(candidate.height);
    if (![x, y, width, height].every(Number.isFinite)) {
      return null;
    }

    return normalizeBounds({ x, y, width, height });
  } catch {
    return null;
  }
}

function scaleBoundsByZoomFactor(bounds: BrowserPaneBounds, zoomFactor: number): BrowserPaneBounds {
  if (!Number.isFinite(zoomFactor) || Math.abs(zoomFactor - 1) < 0.001) {
    return normalizeBounds(bounds);
  }
  return normalizeBounds({
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor,
  });
}

function toSessionSummary(tab: BrowserTabRuntimeRecord): BrowserSessionSummary {
  return {
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    inspectMode: tab.inspectMode,
    hasSelection: tab.hasSelection,
    navigation: tab.navigation,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

function toTabSummary(tab: BrowserTabRuntimeRecord) {
  return {
    tabId: tab.tabId,
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    inspectMode: tab.inspectMode,
    hasSelection: tab.hasSelection,
    navigation: tab.navigation,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

function captureRectForSelection(input: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Electron.Rectangle {
  const width = Math.max(1, Math.ceil(input.width));
  const height = Math.max(1, Math.ceil(input.height));
  return {
    x: Math.max(0, Math.floor(input.x)),
    y: Math.max(0, Math.floor(input.y)),
    width,
    height,
  };
}

async function capturePngDataUrl(
  webContents: Electron.WebContents,
  rect: Electron.Rectangle,
): Promise<string> {
  const image = await webContents.capturePage(rect);
  return `data:image/png;base64,${image.toPNG().toString("base64")}`;
}

function selectorInteractionScript(selector: string, body: string): string {
  return `(async () => {
      ${AGENT_CURSOR_SCRIPT};
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof Element)) {
        throw new Error("Target element not found.");
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      window.__t3BrowserAgentCursor?.moveTo(x, y, "move");
      ${body}
    })()`;
}

export interface BrowserRuntimeRegistryOptions {
  browserPreloadPath: string;
  settingsPath?: string;
  approveOpenUrl?: (url: string) => Promise<boolean>;
  approveHistoryAccess?: () => Promise<boolean>;
}

export class BrowserRuntimeRegistry extends EventEmitter<{
  event: [BrowserRuntimeEvent];
}> {
  private readonly runtimes = new Map<ProjectId, BrowserProjectRuntimeRecord>();
  private readonly browserPreloadPath: string;
  private readonly settingsPath: string | null;
  private readonly approveOpenUrl: ((url: string) => Promise<boolean>) | null;
  private readonly approveHistoryAccess: (() => Promise<boolean>) | null;
  private settings: BrowserUseSettings = DEFAULT_BROWSER_USE_SETTINGS;
  private window: BrowserWindow | null = null;
  private attachedProjectId: ProjectId | null = null;
  private attachedTabId: BrowserTabId | null = null;
  private paneOpen = false;
  private paneProjectId: ProjectId | null = null;
  private paneBounds: BrowserPaneBounds | null = null;
  private paneRequestVersion = 0;

  constructor(options: BrowserRuntimeRegistryOptions) {
    super();
    this.browserPreloadPath = options.browserPreloadPath;
    this.settingsPath = options.settingsPath ?? null;
    this.approveOpenUrl = options.approveOpenUrl ?? null;
    this.approveHistoryAccess = options.approveHistoryAccess ?? null;
    this.settings = this.readSettings();
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) {
      return;
    }
    if (this.window && this.attachedProjectId && this.attachedTabId) {
      this.detachAttachedView(this.window);
    }
    this.window = window;
    if (window && this.paneOpen && this.paneProjectId && this.paneBounds) {
      this.attachActiveTab(window, this.paneProjectId, this.paneBounds);
    }
  }

  handlePageEvent(projectId: ProjectId, payload: { type: string; hasSelection?: unknown }): void {
    const projectRuntime = this.runtimes.get(projectId);
    const activeTab = this.getActiveTab(projectRuntime);
    if (!activeTab) {
      return;
    }
    this.applyPageEvent(activeTab, payload);
  }

  handlePageEventByWebContentsId(
    webContentsId: number,
    payload: { type: string; hasSelection?: unknown },
  ): void {
    const context = this.findTabByWebContentsId(webContentsId);
    if (!context) {
      return;
    }
    this.applyPageEvent(context.tab, payload);
  }

  findProjectIdByWebContentsId(webContentsId: number): ProjectId | null {
    const context = this.findTabByWebContentsId(webContentsId);
    return context?.tab.projectId ?? null;
  }

  async getState(projectId: ProjectId): Promise<BrowserSessionSnapshot> {
    return this.snapshotForProject(projectId);
  }

  async open(projectId: ProjectId, bounds: BrowserPaneBounds): Promise<BrowserSessionSnapshot> {
    const requestVersion = ++this.paneRequestVersion;
    this.paneOpen = true;
    this.paneProjectId = projectId;
    this.paneBounds = normalizeBounds(bounds);
    const projectRuntime = await this.ensureRuntime(projectId);
    if (
      requestVersion !== this.paneRequestVersion ||
      !this.paneOpen ||
      this.paneProjectId !== projectId ||
      !this.paneBounds
    ) {
      return this.snapshotForProject(projectId);
    }
    const activeTab = this.getActiveTab(projectRuntime);
    const isSameAttachedTab =
      Boolean(this.window) &&
      Boolean(activeTab) &&
      this.attachedProjectId === projectId &&
      this.attachedTabId === activeTab?.tabId;
    if (isSameAttachedTab && this.window) {
      this.attachActiveTab(this.window, projectId, this.paneBounds);
      this.emitStateUpdated(projectId);
      return this.snapshotForProject(projectId);
    }
    const measuredBounds = await readIntegratedBrowserViewportBounds(this.window);
    if (
      requestVersion !== this.paneRequestVersion ||
      !this.paneOpen ||
      this.paneProjectId !== projectId ||
      !this.paneBounds
    ) {
      return this.snapshotForProject(projectId);
    }
    if (measuredBounds) {
      this.paneBounds = measuredBounds;
    }
    if (this.window) {
      this.attachActiveTab(this.window, projectId, this.paneBounds);
    }
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async closePane(): Promise<void> {
    this.paneRequestVersion += 1;
    this.paneOpen = false;
    this.paneBounds = null;
    if (this.window) {
      this.detachAttachedView(this.window);
    }
    if (this.paneProjectId) {
      this.emitStateUpdated(this.paneProjectId);
    }
    this.paneProjectId = null;
  }

  async requestPane(projectId: ProjectId): Promise<void> {
    this.emit("event", {
      type: "pane.requested",
      projectId,
    });
  }

  async newTab(projectId: ProjectId, url?: string): Promise<BrowserSessionSnapshot> {
    const projectRuntime = await this.ensureRuntime(projectId);
    const initialUrl =
      typeof url === "string" && url.trim().length > 0
        ? this.normalizeUrl(url)
        : DEFAULT_NEW_TAB_URL;
    await this.assertCanOpenUrl(initialUrl);
    await this.createTab(projectRuntime, { url: initialUrl, activate: true });

    if (this.window && this.paneOpen && this.paneProjectId === projectId && this.paneBounds) {
      this.attachActiveTab(this.window, projectId, this.paneBounds);
    }
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async activateTab(projectId: ProjectId, tabId: BrowserTabId): Promise<BrowserSessionSnapshot> {
    const projectRuntime = await this.ensureRuntime(projectId);
    if (!projectRuntime.tabs.has(tabId)) {
      throw new Error(`Tab '${tabId}' was not found.`);
    }
    projectRuntime.activeTabId = tabId;

    if (this.window && this.paneOpen && this.paneProjectId === projectId && this.paneBounds) {
      this.attachActiveTab(this.window, projectId, this.paneBounds);
    }
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async closeTab(projectId: ProjectId, tabId: BrowserTabId): Promise<BrowserSessionSnapshot> {
    const projectRuntime = await this.ensureRuntime(projectId);
    const tab = projectRuntime.tabs.get(tabId);
    if (!tab) {
      return this.snapshotForProject(projectId);
    }

    const previousTabOrder = [...projectRuntime.tabOrder];
    const closedIndex = previousTabOrder.indexOf(tabId);

    if (this.window && this.attachedProjectId === projectId && this.attachedTabId === tabId) {
      this.detachAttachedView(this.window);
    }

    projectRuntime.tabs.delete(tabId);
    projectRuntime.tabOrder = projectRuntime.tabOrder.filter((entry) => entry !== tabId);
    tab.view.webContents.close({ waitForBeforeUnload: false });

    if (projectRuntime.tabOrder.length === 0) {
      await this.createTab(projectRuntime, { url: DEFAULT_NEW_TAB_URL, activate: true });
    } else if (
      projectRuntime.activeTabId === tabId ||
      !projectRuntime.activeTabId ||
      !projectRuntime.tabs.has(projectRuntime.activeTabId)
    ) {
      const nextIndex = Math.min(
        Math.max(closedIndex, 0),
        Math.max(projectRuntime.tabOrder.length - 1, 0),
      );
      projectRuntime.activeTabId =
        projectRuntime.tabOrder[nextIndex] ?? projectRuntime.tabOrder[0] ?? null;
    }

    if (this.window && this.paneOpen && this.paneProjectId === projectId && this.paneBounds) {
      this.attachActiveTab(this.window, projectId, this.paneBounds);
    }
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async navigate(projectId: ProjectId, url: string): Promise<BrowserSessionSnapshot> {
    const tab = await this.ensureActiveTab(projectId);
    const targetUrl = this.normalizeUrl(url);
    await this.assertCanOpenUrl(targetUrl);
    await this.loadUrl(tab, targetUrl);
    tab.navigation = {
      ...tab.navigation,
      url: targetUrl,
      lastCommittedAt: nowIso(),
    };
    tab.updatedAt = nowIso();
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async back(projectId: ProjectId): Promise<BrowserSessionSnapshot> {
    const tab = await this.ensureActiveTab(projectId);
    await this.assertCanUseHistory();
    if (tab.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
    return this.snapshotForProject(projectId);
  }

  async forward(projectId: ProjectId): Promise<BrowserSessionSnapshot> {
    const tab = await this.ensureActiveTab(projectId);
    await this.assertCanUseHistory();
    if (tab.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
    return this.snapshotForProject(projectId);
  }

  async reload(projectId: ProjectId): Promise<BrowserSessionSnapshot> {
    const tab = await this.ensureActiveTab(projectId);
    tab.view.webContents.reload();
    return this.snapshotForProject(projectId);
  }

  async kill(projectId: ProjectId): Promise<void> {
    const projectRuntime = this.runtimes.get(projectId);
    if (!projectRuntime) {
      return;
    }
    if (this.window && this.attachedProjectId === projectId) {
      this.detachAttachedView(this.window);
    }
    for (const tab of projectRuntime.tabs.values()) {
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.runtimes.delete(projectId);
    if (this.paneProjectId === projectId) {
      this.paneProjectId = null;
      this.paneOpen = false;
      this.paneBounds = null;
    }
    this.emitStateUpdated(projectId);
  }

  async getSettings(): Promise<BrowserUseSettings> {
    return this.settings;
  }

  async updateSettings(patch: BrowserUseSettingsPatch): Promise<BrowserUseSettings> {
    this.settings = normalizeBrowserUseSettings({
      ...this.settings,
      ...patch,
    });
    this.writeSettings();
    return this.settings;
  }

  async clearBrowsingData(input: BrowserClearBrowsingDataInput): Promise<void> {
    const browserSession = electronSession.fromPartition(BROWSER_STORAGE_PARTITION);
    switch (input.kind) {
      case "cookies":
        await browserSession.clearStorageData({ storages: ["cookies"] });
        return;
      case "cache":
        await browserSession.clearCache();
        await browserSession.clearStorageData({ storages: ["cachestorage"] });
        return;
      case "siteData":
        await browserSession.clearStorageData({
          storages: ["localstorage", "indexdb", "websql", "serviceworkers"],
        });
        return;
      case "all":
        await browserSession.clearCache();
        await browserSession.clearStorageData();
        return;
    }
  }

  async setInspectMode(projectId: ProjectId, enabled: boolean): Promise<BrowserSessionSnapshot> {
    const tab = await this.ensureActiveTab(projectId);
    tab.inspectMode = enabled;
    tab.updatedAt = nowIso();
    if (enabled) {
      await tab.view.webContents.executeJavaScript(INSPECT_SCRIPT, true);
    } else {
      tab.hasSelection = await tab.view.webContents.executeJavaScript(DISABLE_INSPECT_SCRIPT, true);
    }
    this.emitStateUpdated(projectId);
    return this.snapshotForProject(projectId);
  }

  async captureInspectSelection(projectId: ProjectId): Promise<BrowserInspectCapture | null> {
    const tab = this.getActiveTab(this.runtimes.get(projectId));
    if (!tab) {
      return null;
    }
    const selection = (await tab.view.webContents.executeJavaScript(
      CAPTURE_SELECTION_SCRIPT,
      true,
    )) as
      | (Omit<BrowserInspectCapture, "sessionId" | "projectId" | "screenshotDataUrl" | "capturedAt"> & {
          boundingBox: BrowserInspectCapture["boundingBox"];
        })
      | null;
    if (!selection) {
      return null;
    }

    const screenshotDataUrl = await capturePngDataUrl(
      tab.view.webContents,
      captureRectForSelection(selection.boundingBox),
    );

    await tab.view.webContents.executeJavaScript(CLEAR_SELECTION_SCRIPT, true);
    tab.hasSelection = false;
    tab.inspectMode = false;
    tab.updatedAt = nowIso();
    await tab.view.webContents.executeJavaScript(DISABLE_INSPECT_SCRIPT, true);
    this.emitStateUpdated(projectId);

    return {
      sessionId: tab.sessionId,
      projectId,
      url: selection.url,
      tagName: selection.tagName,
      selector: selection.selector,
      ancestry: selection.ancestry,
      textSummary: selection.textSummary,
      accessibilitySummary: selection.accessibilitySummary,
      sourceUrl: selection.sourceUrl,
      sourceLocation: selection.sourceLocation,
      boundingBox: selection.boundingBox,
      computedStyle: selection.computedStyle,
      screenshotDataUrl,
      capturedAt: nowIso(),
    };
  }

  async ensure(projectId: ProjectId): Promise<BrowserSessionSnapshot> {
    await this.ensureRuntime(projectId);
    return this.snapshotForProject(projectId);
  }

  async snapshot(projectId: ProjectId): Promise<Record<string, unknown>> {
    const tab = await this.ensureActiveTab(projectId);
    const result = await tab.view.webContents.executeJavaScript(
      `(() => ({
        url: window.location.href,
        title: document.title,
        text: (document.body?.innerText ?? "").slice(0, ${MAX_TEXT_LENGTH}),
        html: document.documentElement?.outerHTML?.slice(0, ${MAX_TEXT_LENGTH}) ?? "",
      }))()`,
      true,
    );
    return result as Record<string, unknown>;
  }

  async screenshot(projectId: ProjectId): Promise<string> {
    const tab = await this.ensureActiveTab(projectId);
    const bounds = tab.view.getBounds();
    return capturePngDataUrl(tab.view.webContents, {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
    });
  }

  async waitFor(projectId: ProjectId, input: { selector?: string; text?: string; timeoutMs?: number }) {
    const tab = await this.ensureActiveTab(projectId);
    const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 10_000, 60_000));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const matched = await tab.view.webContents.executeJavaScript(
        `(async () => {
          const selector = ${JSON.stringify(input.selector ?? "")};
          const text = ${JSON.stringify(input.text ?? "")};
          if (selector.length > 0 && document.querySelector(selector)) {
            return true;
          }
          if (text.length > 0 && document.body && document.body.innerText.includes(text)) {
            return true;
          }
          return false;
        })()`,
        true,
      );
      if (matched === true) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    }
    throw new Error("Timed out waiting for browser condition.");
  }

  async click(projectId: ProjectId, selector: string): Promise<void> {
    const tab = await this.ensureActiveTab(projectId);
    await tab.view.webContents.executeJavaScript(
      selectorInteractionScript(
        selector,
      `
      window.__t3BrowserAgentCursor?.moveTo(x, y, "click");
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
      element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
      element.click();
      `,
      ),
      true,
    );
  }

  async hover(projectId: ProjectId, selector: string): Promise<void> {
    const tab = await this.ensureActiveTab(projectId);
    await tab.view.webContents.executeJavaScript(
      selectorInteractionScript(
        selector,
      `
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
      element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
      `,
      ),
      true,
    );
  }

  async fill(projectId: ProjectId, input: { selector: string; value: string }): Promise<void> {
    const tab = await this.ensureActiveTab(projectId);
    await tab.view.webContents.executeJavaScript(
      selectorInteractionScript(
        input.selector,
      `
      if (!("value" in element)) {
        throw new Error("Target element does not support value assignment.");
      }
      window.__t3BrowserAgentCursor?.moveTo(x, y, "click");
      element.focus();
      element.value = ${JSON.stringify(input.value)};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      `,
      ),
      true,
    );
  }

  async typeText(projectId: ProjectId, input: { selector: string; text: string }): Promise<void> {
    const tab = await this.ensureActiveTab(projectId);
    await tab.view.webContents.executeJavaScript(
      selectorInteractionScript(
        input.selector,
      `
      if (!("value" in element)) {
        throw new Error("Target element does not support text input.");
      }
      window.__t3BrowserAgentCursor?.moveTo(x, y, "click");
      element.focus();
      element.value = (String(element.value ?? "") + ${JSON.stringify(input.text)});
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      `,
      ),
      true,
    );
  }

  async pressKey(projectId: ProjectId, key: string): Promise<void> {
    const tab = await this.ensureActiveTab(projectId);
    await tab.view.webContents.executeJavaScript(
      `(async () => {
        ${AGENT_CURSOR_SCRIPT};
        const target = document.activeElement instanceof Element ? document.activeElement : document.body;
        const rect = target?.getBoundingClientRect?.();
        const x = rect ? rect.left + Math.min(rect.width / 2, 24) : window.innerWidth / 2;
        const y = rect ? rect.top + Math.min(rect.height / 2, 18) : window.innerHeight / 2;
        window.__t3BrowserAgentCursor?.moveTo(x, y, "click");
      })()`,
      true,
    );
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    tab.view.webContents.sendInputEvent({ type: "char", keyCode: key });
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
  }

  async evaluate(projectId: ProjectId, expression: string): Promise<unknown> {
    const tab = await this.ensureActiveTab(projectId);
    return tab.view.webContents.executeJavaScript(
      `(async () => {
        return await (0, eval)(${JSON.stringify(expression)});
      })()`,
      true,
    );
  }

  private applyPageEvent(
    tab: BrowserTabRuntimeRecord,
    payload: { type: string; hasSelection?: unknown },
  ): void {
    if (payload.type !== "inspect-selection-changed") {
      return;
    }
    tab.hasSelection = payload.hasSelection === true;
    tab.updatedAt = nowIso();
    this.emitStateUpdated(tab.projectId);
    this.emit("event", {
      type: "inspect.selection.changed",
      projectId: tab.projectId,
      hasSelection: tab.hasSelection,
    });
  }

  private async ensureRuntime(projectId: ProjectId): Promise<BrowserProjectRuntimeRecord> {
    const existing = this.runtimes.get(projectId);
    if (existing) {
      return existing;
    }

    const projectRuntime: BrowserProjectRuntimeRecord = {
      projectId,
      tabs: new Map(),
      tabOrder: [],
      activeTabId: null,
    };
    await this.assertCanOpenUrl(DEFAULT_NEW_TAB_URL);
    this.runtimes.set(projectId, projectRuntime);
    await this.createTab(projectRuntime, { url: DEFAULT_NEW_TAB_URL, activate: true });
    return projectRuntime;
  }

  private async ensureActiveTab(projectId: ProjectId): Promise<BrowserTabRuntimeRecord> {
    const projectRuntime = await this.ensureRuntime(projectId);
    const activeTab = this.getActiveTab(projectRuntime);
    if (!activeTab) {
      return this.createTab(projectRuntime, { url: DEFAULT_NEW_TAB_URL, activate: true });
    }
    return activeTab;
  }

  private getActiveTab(
    projectRuntime: BrowserProjectRuntimeRecord | undefined,
  ): BrowserTabRuntimeRecord | null {
    if (!projectRuntime || !projectRuntime.activeTabId) {
      return null;
    }
    return projectRuntime.tabs.get(projectRuntime.activeTabId) ?? null;
  }

  private async createTab(
    projectRuntime: BrowserProjectRuntimeRecord,
    input: { url: string; activate: boolean },
  ): Promise<BrowserTabRuntimeRecord> {
    const tabId = randomUUID() as BrowserTabId;
    const partition = BROWSER_STORAGE_PARTITION;
    const preloadPath = Path.resolve(this.browserPreloadPath);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const createdAt = nowIso();
    const tab: BrowserTabRuntimeRecord = {
      tabId,
      sessionId: randomUUID(),
      projectId: projectRuntime.projectId,
      view,
      createdAt,
      updatedAt: createdAt,
      inspectMode: false,
      hasSelection: false,
      navigation: {
        url: null,
        title: null,
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        lastCommittedAt: null,
      },
    };
    this.installListeners(tab);
    projectRuntime.tabs.set(tabId, tab);
    projectRuntime.tabOrder.push(tabId);
    if (input.activate) {
      projectRuntime.activeTabId = tabId;
    }

    try {
      await this.loadUrl(tab, input.url);
      return tab;
    } catch (error) {
      projectRuntime.tabs.delete(tabId);
      projectRuntime.tabOrder = projectRuntime.tabOrder.filter((entry) => entry !== tabId);
      if (projectRuntime.activeTabId === tabId) {
        projectRuntime.activeTabId = projectRuntime.tabOrder[0] ?? null;
      }
      tab.view.webContents.close({ waitForBeforeUnload: false });
      throw error;
    }
  }

  private installListeners(tab: BrowserTabRuntimeRecord): void {
    const syncNavigation = () => {
      tab.navigation = {
        url: tab.view.webContents.getURL() || null,
        title: tab.view.webContents.getTitle() || null,
        canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
        isLoading: tab.view.webContents.isLoading(),
        lastCommittedAt: nowIso(),
      };
      tab.updatedAt = nowIso();
      this.emitStateUpdated(tab.projectId);
    };

    tab.view.webContents.on("did-navigate", syncNavigation);
    tab.view.webContents.on("did-navigate-in-page", syncNavigation);
    tab.view.webContents.on("page-title-updated", syncNavigation);
    tab.view.webContents.on("did-start-loading", syncNavigation);
    tab.view.webContents.on("did-stop-loading", syncNavigation);
    tab.view.webContents.on("dom-ready", () => {
      this.scheduleAttachedBoundsReapply(tab.projectId, tab.tabId);
    });
    tab.view.webContents.on("did-finish-load", () => {
      this.scheduleAttachedBoundsReapply(tab.projectId, tab.tabId);
    });
    tab.view.webContents.on("did-stop-loading", () => {
      this.scheduleAttachedBoundsReapply(tab.projectId, tab.tabId);
    });
    tab.view.webContents.on("render-process-gone", () => {
      tab.updatedAt = nowIso();
      this.emitStateUpdated(tab.projectId);
    });
  }

  private emitStateUpdated(projectId: ProjectId): void {
    this.emit("event", {
      type: "state.updated",
      projectId,
      snapshot: this.snapshotForProject(projectId),
    });
  }

  private snapshotForProject(projectId: ProjectId): BrowserSessionSnapshot {
    const projectRuntime = this.runtimes.get(projectId);
    const activeTab = this.getActiveTab(projectRuntime);
    return {
      paneOpen: this.paneOpen,
      paneProjectId: this.paneProjectId,
      paneBounds: this.paneBounds,
      session: activeTab ? toSessionSummary(activeTab) : null,
      tabs:
        projectRuntime?.tabOrder
          .map((tabId) => projectRuntime.tabs.get(tabId))
          .filter((tab): tab is BrowserTabRuntimeRecord => tab !== undefined)
          .map((tab) => toTabSummary(tab)) ?? [],
      activeTabId: projectRuntime?.activeTabId ?? null,
    };
  }

  private async loadUrl(tab: BrowserTabRuntimeRecord, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      const committedUrl = tab.view.webContents.getURL();
      if (
        isNavigationAbortError(error) &&
        committedUrl.length > 0 &&
        committedUrl !== "about:blank"
      ) {
        return;
      }
      throw error;
    }
  }

  private applyBounds(
    tab: BrowserTabRuntimeRecord,
    bounds: BrowserPaneBounds,
    options: { forceViewportRefresh?: boolean } = {},
  ): void {
    const hostWindowWebContents = this.window?.webContents;
    const hostZoomFactor =
      hostWindowWebContents && typeof hostWindowWebContents.getZoomFactor === "function"
        ? hostWindowWebContents.getZoomFactor()
        : 1;
    const nextBounds = scaleBoundsByZoomFactor(bounds, hostZoomFactor);
    const shouldShow = nextBounds.width > 0 && nextBounds.height > 0;

    if (options.forceViewportRefresh && shouldShow) {
      const nudgedBounds = { ...nextBounds };
      if (nudgedBounds.width > 1) {
        nudgedBounds.width -= 1;
      } else if (nudgedBounds.height > 1) {
        nudgedBounds.height -= 1;
      }
      if (
        nudgedBounds.width !== nextBounds.width ||
        nudgedBounds.height !== nextBounds.height
      ) {
        tab.view.setBounds(nudgedBounds);
      }
    }

    tab.view.setBounds(nextBounds);
    tab.view.setVisible(shouldShow);
    void tab.view.webContents
      .executeJavaScript(
        `window.dispatchEvent(new Event("resize")); window.visualViewport?.dispatchEvent?.(new Event("resize"));`,
        true,
      )
      .catch(() => undefined);
  }

  private attachActiveTab(window: BrowserWindow, projectId: ProjectId, bounds: BrowserPaneBounds): void {
    const projectRuntime = this.runtimes.get(projectId);
    const activeTab = this.getActiveTab(projectRuntime);
    if (!activeTab) {
      return;
    }

    const contentView = (window as BrowserWindow & {
      contentView: {
        addChildView: (view: Electron.WebContentsView) => void;
        removeChildView: (view: Electron.WebContentsView) => void;
      };
    }).contentView;

    const sameAttachment =
      this.attachedProjectId === projectId && this.attachedTabId === activeTab.tabId;

    if (!sameAttachment && this.attachedProjectId && this.attachedTabId) {
      const attachedProjectRuntime = this.runtimes.get(this.attachedProjectId);
      const attachedTab = attachedProjectRuntime?.tabs.get(this.attachedTabId) ?? null;
      if (attachedTab) {
        contentView.removeChildView(attachedTab.view);
      }
    }
    if (!sameAttachment) {
      contentView.addChildView(activeTab.view);
    }

    this.applyBounds(activeTab, bounds, { forceViewportRefresh: !sameAttachment });
    this.attachedProjectId = projectId;
    this.attachedTabId = activeTab.tabId;
    if (!sameAttachment) {
      this.scheduleAttachedBoundsReapply(projectId, activeTab.tabId);
    }
  }

  private scheduleAttachedBoundsReapply(projectId: ProjectId, tabId: BrowserTabId): void {
    for (const delayMs of ATTACHED_BOUNDS_REAPPLY_DELAYS_MS) {
      globalThis.setTimeout(() => {
        void this.reapplyAttachedBounds(projectId, tabId);
      }, delayMs);
    }
  }

  private async reapplyAttachedBounds(projectId: ProjectId, tabId: BrowserTabId): Promise<void> {
    const requestVersion = this.paneRequestVersion;
    if (
      !this.window ||
      !this.paneOpen ||
      !this.paneBounds ||
      this.paneProjectId !== projectId ||
      this.attachedProjectId !== projectId ||
      this.attachedTabId !== tabId
    ) {
      return;
    }
    const projectRuntime = this.runtimes.get(projectId);
    const tab = projectRuntime?.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const measuredBounds = await readIntegratedBrowserViewportBounds(this.window);
    if (
      requestVersion !== this.paneRequestVersion ||
      !this.window ||
      !this.paneOpen ||
      !this.paneBounds ||
      this.paneProjectId !== projectId ||
      this.attachedProjectId !== projectId ||
      this.attachedTabId !== tabId
    ) {
      return;
    }
    if (measuredBounds) {
      this.paneBounds = measuredBounds;
    }
    this.applyBounds(tab, this.paneBounds, { forceViewportRefresh: true });
  }

  private detachAttachedView(window: BrowserWindow): void {
    if (!this.attachedProjectId || !this.attachedTabId) {
      return;
    }
    const projectRuntime = this.runtimes.get(this.attachedProjectId);
    const tab = projectRuntime?.tabs.get(this.attachedTabId) ?? null;
    if (!tab) {
      this.attachedProjectId = null;
      this.attachedTabId = null;
      return;
    }
    try {
      if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
        return;
      }
      const contentView = (window as BrowserWindow & {
        contentView: { removeChildView: (view: Electron.WebContentsView) => void };
      }).contentView;
      contentView.removeChildView(tab.view);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Object has been destroyed")) {
        throw error;
      }
    } finally {
      this.attachedProjectId = null;
      this.attachedTabId = null;
    }
  }

  private findTabByWebContentsId(
    webContentsId: number,
  ): { tab: BrowserTabRuntimeRecord } | null {
    for (const projectRuntime of this.runtimes.values()) {
      for (const tab of projectRuntime.tabs.values()) {
        if (tab.view.webContents.id === webContentsId) {
          return { tab };
        }
      }
    }
    return null;
  }

  private normalizeUrl(value: string): string {
    const trimmed = value.trim();
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return `https://${trimmed}`;
  }

  private async assertCanOpenUrl(url: string): Promise<void> {
    const hostname = hostnameFromUrl(url);
    if (!hostname) {
      return;
    }
    if (matchesDomainList(hostname, this.settings.blockedDomains)) {
      throw new Error(`Browser access to '${hostname}' is blocked by settings.`);
    }
    if (matchesDomainList(hostname, this.settings.allowedDomains)) {
      return;
    }
    switch (this.settings.approvalPolicy) {
      case "allow":
        return;
      case "deny":
        throw new Error("Browser opening is disabled by settings.");
      case "alwaysAsk": {
        if (!this.approveOpenUrl) {
          return;
        }
        const approved = await this.approveOpenUrl(url);
        if (!approved) {
          throw new Error("Browser opening was not approved.");
        }
      }
    }
  }

  private async assertCanUseHistory(): Promise<void> {
    switch (this.settings.historyPolicy) {
      case "allow":
        return;
      case "deny":
        throw new Error("Browser history access is disabled by settings.");
      case "alwaysAsk": {
        if (!this.approveHistoryAccess) {
          return;
        }
        const approved = await this.approveHistoryAccess();
        if (!approved) {
          throw new Error("Browser history access was not approved.");
        }
      }
    }
  }

  private readSettings(): BrowserUseSettings {
    if (!this.settingsPath) {
      return DEFAULT_BROWSER_USE_SETTINGS;
    }
    try {
      const raw = FS.readFileSync(this.settingsPath, "utf8");
      return normalizeBrowserUseSettings(JSON.parse(raw) as Partial<BrowserUseSettings>);
    } catch {
      return DEFAULT_BROWSER_USE_SETTINGS;
    }
  }

  private writeSettings(): void {
    if (!this.settingsPath) {
      return;
    }
    FS.mkdirSync(Path.dirname(this.settingsPath), { recursive: true });
    FS.writeFileSync(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
  }
}

function normalizeBrowserUseSettings(input: {
  approvalPolicy?: unknown;
  historyPolicy?: unknown;
  blockedDomains?: unknown;
  allowedDomains?: unknown;
}): BrowserUseSettings {
  return {
    approvalPolicy: normalizePolicy(input.approvalPolicy),
    historyPolicy: normalizePolicy(input.historyPolicy),
    blockedDomains: normalizeDomainList(input.blockedDomains),
    allowedDomains: normalizeDomainList(input.allowedDomains),
  };
}

function normalizePolicy(value: unknown): BrowserUseSettings["approvalPolicy"] {
  return value === "allow" || value === "deny" || value === "alwaysAsk" ? value : "alwaysAsk";
}

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.replace(/^\.+|\.+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    domains.push(normalized);
  }
  return domains;
}

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function matchesDomainList(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
