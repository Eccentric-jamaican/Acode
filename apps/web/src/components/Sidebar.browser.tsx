import "../index.css";

import {
  type BrowserPaneBounds,
  type BrowserSessionSnapshot,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
  type DesktopBridge,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useBrowserPaneStore } from "../browserPaneStore";
import { applyDesktopWindowChromeMetrics } from "../desktopWindowChrome";
import { getRouter } from "../router";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { showContextMenuFallback } from "../contextMenuFallback";

const PROJECT_ID = "project-sidebar-browser" as ProjectId;
const THREAD_ID = "thread-sidebar-browser" as ThreadId;
const TURN_ID = TurnId.makeUnsafe("turn-sidebar-browser");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
let nextSequence = 1;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createFixture(): TestFixture {
  return {
    snapshot: {
      snapshotSequence: 1,
      projects: [
        {
          id: PROJECT_ID,
          title: "t3code-main",
          workspaceRoot: "C:\\Users\\Addis\\source\\repos\\t3code-main",
          defaultModel: "gpt-5",
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      tasks: [],
      taskRuntimes: [],
      projectRules: [],
      threads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          origin: "user",
          taskId: null,
          title: "Settings popover backend wiring",
          model: "gpt-5",
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "main",
          worktreePath: null,
          isPinned: false,
          latestTurn: {
            turnId: TURN_ID,
            state: "running",
            interactionMode: "default",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TURN_ID,
            lastError: null,
            updatedAt: NOW_ISO,
          },
        },
      ],
      updatedAt: NOW_ISO,
    },
    serverConfig: {
      cwd: "C:\\Users\\Addis\\source\\repos\\t3code-main",
      keybindingsConfigPath: "C:\\Users\\Addis\\.t3\\userdata\\keybindings.json",
      keybindings: [],
      issues: [],
      providers: [
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: NOW_ISO,
        },
      ],
      providerAccounts: [
        {
          provider: "codex",
          state: "authenticated",
          authMode: "chatgpt",
          requiresOpenaiAuth: false,
          account: {
            type: "chatgpt",
            email: "aellisatl@gmail.com",
            planType: "plus",
          },
          rateLimits: [
            {
              limitId: "codex",
              limitName: "Codex",
              planType: "plus",
              primary: {
                usedPercent: 0,
                windowDurationMins: 300,
                resetsAt: "2026-03-04T17:47:00.000Z",
              },
              secondary: {
                usedPercent: 100,
                windowDurationMins: 10_080,
                resetsAt: "2026-03-18T00:00:00.000Z",
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "722.9550000000",
              },
            },
          ],
          login: {
            status: "idle",
            loginId: null,
            authUrl: null,
            error: null,
          },
          message: null,
          updatedAt: NOW_ISO,
        },
      ],
      availableEditors: [],
    },
    welcome: {
      cwd: "C:\\Users\\Addis\\source\\repos\\t3code-main",
      projectName: "t3code-main",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function makeProjectEntry(
  id: ProjectId,
  title: string,
  overrides: Partial<OrchestrationReadModel["projects"][number]> = {},
): OrchestrationReadModel["projects"][number] {
  return {
    id,
    title,
    workspaceRoot: `C:\\workspace\\${title}`,
    defaultModel: "gpt-5",
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    ...overrides,
  };
}

function makeThreadEntry(
  id: ThreadId,
  projectId: ProjectId,
  title: string,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id,
    projectId,
    origin: "user",
    taskId: null,
    title,
    model: "gpt-5",
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: "main",
    worktreePath: null,
    isPinned: false,
    latestTurn: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  return {};
}

function applyDispatchCommand(command: ClientOrchestrationCommand): { sequence: number } {
  if (command.type === "thread.meta.update" && command.isPinned !== undefined) {
    const nextUpdatedAt = new Date(Date.parse(NOW_ISO) + nextSequence * 1_000).toISOString();
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        snapshotSequence: nextSequence,
        updatedAt: nextUpdatedAt,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === command.threadId
            ? {
                ...thread,
                isPinned: command.isPinned ?? thread.isPinned,
                updatedAt: nextUpdatedAt,
              }
            : thread,
        ),
      },
    };
  }
  if (command.type === "thread.archive") {
    const nextUpdatedAt = new Date(Date.parse(NOW_ISO) + nextSequence * 1_000).toISOString();
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        snapshotSequence: nextSequence,
        updatedAt: nextUpdatedAt,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === command.threadId
            ? {
                ...thread,
                archivedAt: nextUpdatedAt,
                updatedAt: nextUpdatedAt,
              }
            : thread,
        ),
      },
    };
  }

  return { sequence: nextSequence++ };
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let request: WsRequestEnvelope;
      try {
        request = JSON.parse(event.data) as WsRequestEnvelope;
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") {
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
        const command = request.body.command as ClientOrchestrationCommand | undefined;
        if (command) {
          const result = applyDispatchCommand(command);
          client.send(
            JSON.stringify({
              id: request.id,
              result,
            }),
          );
          if (command.type === "thread.meta.update" && command.isPinned !== undefined) {
            client.send(
              JSON.stringify({
                type: "push",
                channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
                data: {
                  sequence: result.sequence,
                  eventId: `event-${result.sequence}`,
                  aggregateKind: "thread",
                  aggregateId: command.threadId,
                  occurredAt:
                    fixture.snapshot.threads.find((thread) => thread.id === command.threadId)
                      ?.updatedAt ?? NOW_ISO,
                  commandId: command.commandId,
                  causationEventId: null,
                  correlationId: command.commandId,
                  metadata: {},
                  type: "thread.meta-updated",
                  payload: {
                    threadId: command.threadId,
                    isPinned: command.isPinned,
                    updatedAt:
                      fixture.snapshot.threads.find((thread) => thread.id === command.threadId)
                        ?.updatedAt ?? NOW_ISO,
                  },
                },
              }),
            );
          }
          if (command.type === "thread.archive") {
            client.send(
              JSON.stringify({
                type: "push",
                channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
                data: {
                  sequence: result.sequence,
                  eventId: `event-${result.sequence}`,
                  aggregateKind: "thread",
                  aggregateId: command.threadId,
                  occurredAt:
                    fixture.snapshot.threads.find((thread) => thread.id === command.threadId)
                      ?.updatedAt ?? NOW_ISO,
                  commandId: command.commandId,
                  causationEventId: null,
                  correlationId: command.commandId,
                  metadata: {},
                  type: "thread.archived",
                  payload: {
                    threadId: command.threadId,
                    archivedAt:
                      fixture.snapshot.threads.find((thread) => thread.id === command.threadId)
                        ?.archivedAt ?? NOW_ISO,
                    updatedAt:
                      fixture.snapshot.threads.find((thread) => thread.id === command.threadId)
                        ?.updatedAt ?? NOW_ISO,
                  },
                },
              }),
            );
          }
          return;
        }
      }
      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(method),
        }),
      );
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForProductionStyles(): Promise<void> {
  await expect
    .poll(
      () => getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      { timeout: 4_000, interval: 16 },
    )
    .not.toBe("");
}

function dispatchPointerDown(target: EventTarget | null): void {
  const EventCtor = window.PointerEvent ?? window.MouseEvent;
  target?.dispatchEvent(
    new EventCtor("pointerdown", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

function projectOrderLabels(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "[data-testid^='sidebar-project-']:not([data-testid^='sidebar-project-new-thread-'])",
    ),
  ].map((element) => element.getAttribute("aria-label") ?? "");
}

function elementOpacityByTestId(testId: string): number | null {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  if (!element) {
    return null;
  }
  const opacity = Number.parseFloat(window.getComputedStyle(element).opacity);
  return Number.isFinite(opacity) ? opacity : null;
}

function visibleSidebarToggleCount(label: "Collapse Sidebar" | "Expand Sidebar"): number {
  return [...document.querySelectorAll<HTMLElement>(`[aria-label='${label}']`)].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }).length;
}

function desktopInsetShellMetrics(): {
  contentInsetLeft: number;
  paddingLeft: string;
  shellLeft: number;
} {
  const shell = document.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
  const content = shell?.firstElementChild;
  expect(shell).not.toBeNull();
  expect(content).toBeInstanceOf(HTMLElement);

  const shellRect = shell!.getBoundingClientRect();
  const contentRect = (content as HTMLElement).getBoundingClientRect();

  return {
    paddingLeft: window.getComputedStyle(shell!).paddingLeft,
    contentInsetLeft: Math.round(contentRect.left - shellRect.left),
    shellLeft: Math.round(shellRect.left),
  };
}

function desktopTitlebarBandMetrics(): {
  bandBottom: number;
  bandHeight: number;
} {
  const band = document.querySelector<HTMLElement>("[data-testid='desktop-titlebar-band']");
  expect(band).not.toBeNull();

  const bandRect = band!.getBoundingClientRect();

  return {
    bandBottom: Math.round(bandRect.bottom),
    bandHeight: Math.round(bandRect.height),
  };
}

function desktopTitlebarBandClearance(targetTestId: string): {
  bandBottom: number;
  targetTop: number;
} {
  const band = document.querySelector<HTMLElement>("[data-testid='desktop-titlebar-band']");
  const target = document.querySelector<HTMLElement>(`[data-testid='${targetTestId}']`);
  expect(band).not.toBeNull();
  expect(target).not.toBeNull();

  const bandRect = band!.getBoundingClientRect();
  const targetRect = target!.getBoundingClientRect();

  return {
    bandBottom: Math.round(bandRect.bottom),
    targetTop: Math.round(targetRect.top),
  };
}

function desktopCaptionButtonLaneMetrics(targetTestId: string): {
  laneWidth: number;
  targetRight: number;
} {
  const target = document.querySelector<HTMLElement>(`[data-testid='${targetTestId}']`);
  expect(target).not.toBeNull();

  const actionElements = Array.from(
    target!.querySelectorAll<HTMLElement>("button, [role='button'], a, input, textarea, select"),
  );
  const targetRight = actionElements.length
    ? Math.max(...actionElements.map((element) => element.getBoundingClientRect().right))
    : target!.getBoundingClientRect().right;
  const laneWidth = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue("--desktop-caption-button-lane-width"),
  );

  return {
    laneWidth: Number.isFinite(laneWidth) ? Math.round(laneWidth) : 0,
    targetRight: Math.round(targetRight),
  };
}

function computedBackgroundColorByTestId(testId: string): string {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  return window.getComputedStyle(element!).backgroundColor;
}

function sidebarSurfaceBackgroundColor(): string {
  const element = document.querySelector<HTMLElement>("[data-slot='sidebar-container']");
  expect(element).not.toBeNull();
  return window.getComputedStyle(element!).backgroundColor;
}

function sidebarSurfaceWidth(): number {
  const element = document.querySelector<HTMLElement>("[data-testid='desktop-titlebar-band-sidebar-surface']");
  expect(element).not.toBeNull();
  return Math.round(element!.getBoundingClientRect().width);
}

function sidebarInsetBackgroundColor(): string {
  const element = document.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
  expect(element).not.toBeNull();
  return window.getComputedStyle(element!).backgroundColor;
}

function elementHeightByTestId(testId: string): number {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  return Math.round(element!.getBoundingClientRect().height);
}

function viewportRightGapByTestId(testId: string): number {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  return Math.round(window.innerWidth - element!.getBoundingClientRect().right);
}

function scrollViewportRightGapByTestId(testId: string): number {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  expect(element).not.toBeNull();
  const viewport = element!.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
  expect(viewport).not.toBeNull();

  return Math.round(viewport!.getBoundingClientRect().right - element!.getBoundingClientRect().right);
}

const DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS: BrowserPaneBounds = {
  x: 1_020,
  y: 22,
  width: 480,
  height: 760,
};

function createDesktopBrowserSnapshot(
  projectId: ProjectId,
  paneBounds: BrowserPaneBounds = DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS,
): BrowserSessionSnapshot {
  const tab = {
    tabId: "tab-1",
    sessionId: "browser-session-sidebar-test",
    projectId,
    inspectMode: false,
    hasSelection: false,
    navigation: {
      url: "https://www.google.com/search",
      title: "Google",
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      lastCommittedAt: NOW_ISO,
    },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  } as const;
  return {
    paneOpen: true,
    paneProjectId: projectId,
    paneBounds,
    session: {
      sessionId: tab.sessionId,
      projectId: tab.projectId,
      inspectMode: tab.inspectMode,
      hasSelection: tab.hasSelection,
      navigation: tab.navigation,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
    },
    tabs: [tab],
    activeTabId: tab.tabId,
  };
}

function createDesktopBrowserBridge(projectId: ProjectId): DesktopBridge["browser"] {
  let paneBounds = { ...DEFAULT_DESKTOP_BROWSER_PANE_BOUNDS };
  let tabs = [createDesktopBrowserSnapshot(projectId, paneBounds).tabs?.[0]].filter(Boolean) as NonNullable<
    BrowserSessionSnapshot["tabs"]
  >;
  let activeTabId = tabs[0]?.tabId ?? null;
  const buildSnapshot = (): BrowserSessionSnapshot => {
    const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0] ?? null;
    return {
      paneOpen: true,
      paneProjectId: projectId,
      paneBounds,
      session: activeTab
        ? {
            sessionId: activeTab.sessionId,
            projectId: activeTab.projectId,
            inspectMode: activeTab.inspectMode,
            hasSelection: activeTab.hasSelection,
            navigation: activeTab.navigation,
            createdAt: activeTab.createdAt,
            updatedAt: activeTab.updatedAt,
          }
        : null,
      tabs,
      activeTabId,
    };
  };

  return {
    getState: async () => buildSnapshot(),
    open: async (input) => {
      paneBounds = { ...input.bounds };
      return buildSnapshot();
    },
    closePane: async () => undefined,
    newTab: async () => {
      const tabId = `tab-${tabs.length + 1}`;
      const base = buildSnapshot().tabs?.[0];
      if (!base) {
        return buildSnapshot();
      }
      tabs = [
        ...tabs,
        {
          ...base,
          tabId,
          sessionId: `browser-session-sidebar-test-${tabId}`,
          navigation: {
            ...base.navigation,
            url: "about:blank",
            title: "",
            canGoBack: false,
            canGoForward: false,
          },
        },
      ];
      activeTabId = tabId;
      return buildSnapshot();
    },
    activateTab: async (input) => {
      activeTabId = input.tabId;
      return buildSnapshot();
    },
    closeTab: async (input) => {
      tabs = tabs.filter((tab) => tab.tabId !== input.tabId);
      if (tabs.length === 0) {
        const fallback = createDesktopBrowserSnapshot(projectId, paneBounds).tabs?.[0];
        if (fallback) {
          tabs = [fallback];
        }
      }
      if (!tabs.some((tab) => tab.tabId === activeTabId)) {
        activeTabId = tabs[0]?.tabId ?? null;
      }
      return buildSnapshot();
    },
    navigate: async (input) => {
      tabs = tabs.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              navigation: {
                ...tab.navigation,
                url: input.url,
              },
            }
          : tab,
      );
      return buildSnapshot();
    },
    back: async () => buildSnapshot(),
    forward: async () => buildSnapshot(),
    reload: async () => buildSnapshot(),
    kill: async () => undefined,
    getSettings: async () => ({
      approvalPolicy: "alwaysAsk",
      historyPolicy: "alwaysAsk",
      blockedDomains: [],
      allowedDomains: [],
    }),
    updateSettings: async (input) => ({
      approvalPolicy: input.approvalPolicy ?? "alwaysAsk",
      historyPolicy: input.historyPolicy ?? "alwaysAsk",
      blockedDomains: input.blockedDomains ?? [],
      allowedDomains: input.allowedDomains ?? [],
    }),
    clearBrowsingData: async () => undefined,
    setInspectMode: async (input) => {
      tabs = tabs.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              inspectMode: input.enabled,
            }
          : tab,
      );
      return buildSnapshot();
    },
    captureInspectSelection: async () => null,
    onEvent: () => () => {},
  };
}

function desktopBrandTriggerOpacities(): { mark: number; toggle: number } {
  const mark = document.querySelector<HTMLElement>("[data-slot='sidebar-brand-mark']");
  const toggle = document.querySelector<HTMLElement>("[data-slot='sidebar-brand-toggle-icon']");
  expect(mark).not.toBeNull();
  expect(toggle).not.toBeNull();

  return {
    mark: Number.parseFloat(window.getComputedStyle(mark!).opacity),
    toggle: Number.parseFloat(window.getComputedStyle(toggle!).opacity),
  };
}

function disableWelcomeBootstrap(targetFixture: TestFixture): void {
  targetFixture.welcome = {
    cwd: targetFixture.welcome.cwd,
    projectName: targetFixture.welcome.projectName,
  };
}

function chatHomeVariantKey(): string | null {
  return (
    document
      .querySelector<HTMLElement>("[data-testid='chat-home-surface']")
      ?.getAttribute("data-home-variant") ?? null
  );
}

function chatHomeVariantText(): string | null {
  return (
    document
      .querySelector<HTMLElement>("[data-testid='chat-home-variant-copy']")
      ?.textContent?.trim() ?? null
  );
}

async function collapseDesktopSidebar(): Promise<void> {
  await expect.poll(() => visibleSidebarToggleCount("Collapse Sidebar")).toBe(1);
  await page.getByRole("button", { name: "Collapse Sidebar" }).click();
  await expect.poll(() => visibleSidebarToggleCount("Expand Sidebar")).toBe(1);
  await waitForLayout();
}

async function dragProjectRow(
  sourceTestId: string,
  targetTestId: string,
  position: "before" | "after" = "before",
): Promise<void> {
  const source = document.querySelector<HTMLElement>(`[data-testid='${sourceTestId}']`);
  const target = document.querySelector<HTMLElement>(`[data-testid='${targetTestId}']`);
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  if (!source || !target) {
    return;
  }

  const dataTransfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }),
  );
  await nextFrame();
  const targetRect = target.getBoundingClientRect();
  const clientY = position === "before" ? targetRect.top + 1 : targetRect.bottom - 1;
  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientY,
    }),
  );
  await nextFrame();
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientY,
    }),
  );
  source.dispatchEvent(
    new DragEvent("dragend", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }),
  );
  await nextFrame();
}

async function mountSidebarApp(
  options:
    | {
        configureFixture?: (fixture: TestFixture) => void;
        initialEntries?: string[];
        viewport?: { width: number; height: number };
      }
    | string[] = {},
) {
  const resolvedOptions = Array.isArray(options) ? { initialEntries: options } : options;

  resolvedOptions.configureFixture?.(fixture);

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);
  applyDesktopWindowChromeMetrics(document.documentElement);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: resolvedOptions.initialEntries ?? ["/"],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await page.viewport(
    resolvedOptions.viewport?.width ?? 1440,
    resolvedOptions.viewport?.height ?? 960,
  );
  await waitForLayout();
  await waitForProductionStyles();

  return {
    router,
    cleanup: async () => {
      await screen.unmount();
      if (host.isConnected) {
        host.remove();
      }
      document.querySelector("[data-testid='context-menu-overlay']")?.remove();
      document.querySelector("[data-testid='context-menu-fallback']")?.remove();
    },
  };
}

beforeAll(async () => {
  await worker.start({
    onUnhandledRequest: "error",
    serviceWorker: {
      url: "/mockServiceWorker.js",
    },
  });
});

afterAll(async () => {
  await worker.stop();
});

beforeEach(() => {
  fixture = createFixture();
  nextSequence = fixture.snapshot.snapshotSequence + 1;
  window.desktopBridge = {
    getWsUrl: () => `ws://${window.location.host}`,
    getWindowChromeMetrics: () => ({
      platform: "win32",
      titlebarHeightPx: 22,
      leadingInsetPx: 0,
      trailingInsetPx: 138,
      captionButtonLaneWidthPx: 104,
    }),
    openExternal: async () => true,
    pickFolder: async () => null,
    confirm: async () => true,
  } as unknown as DesktopBridge;
  window.localStorage.clear();
  useStore.setState({
    projects: [],
    threads: [],
    threadsHydrated: false,
  });
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useBrowserPaneStore.setState({
    width: 480,
  });
});

afterEach(() => {
  worker.resetHandlers();
  Reflect.deleteProperty(window, "desktopBridge");
  applyDesktopWindowChromeMetrics(document.documentElement);
});

describe("Sidebar browser", () => {
  it("resolves browser fallback context-menu selection before outside dismissal", async () => {
    const resolveSpy = vi.fn();
    const resultPromise = showContextMenuFallback([{ id: "pin", label: "Pin thread" }]).then(
      (result) => {
        resolveSpy(result);
        return result;
      },
    );

    const button = document.querySelector<HTMLButtonElement>("[data-context-menu-item-id='pin']");
    const overlay = document.querySelector<HTMLDivElement>("[data-testid='context-menu-overlay']");

    expect(button).not.toBeNull();
    expect(overlay).not.toBeNull();

    dispatchPointerDown(button);
    dispatchPointerDown(overlay);

    await expect(resultPromise).resolves.toBe("pin");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-testid='context-menu-fallback']")).toBeNull();
  });

  it("shows backend-backed projects and threads in the sidebar", async () => {
    const mounted = await mountSidebarApp();

    await expect
      .poll(() => document.body.textContent?.includes("t3code-main") ?? false, {
        timeout: 8_000,
        interval: 16,
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          document.body.textContent?.includes("Settings popover backend wiring") ?? false,
        {
          timeout: 8_000,
          interval: 16,
        },
      )
      .toBe(true);

    await mounted.cleanup();
  });

  it("renders the redesigned primary nav with Plugins and Orchestrate", async () => {
    const mounted = await mountSidebarApp();

    await expect
      .poll(() => {
        const text = document.body.textContent ?? "";
        return (
          text.indexOf("New thread") < text.indexOf("Automations") &&
          text.indexOf("Automations") < text.indexOf("Skills") &&
          text.indexOf("Skills") < text.indexOf("Plugins") &&
          text.indexOf("Plugins") < text.indexOf("Orchestrate")
        );
      })
      .toBe(true);

    await expect.element(page.getByRole("button", { name: "Plugins" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Orchestrate" })).toBeVisible();

    await mounted.cleanup();
  });

  it("shows add-project and filter actions beside the Threads heading", async () => {
    const mounted = await mountSidebarApp();

    await expect.element(page.getByRole("button", { name: "Add project" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Filter threads" })).toBeVisible();

    await mounted.cleanup();
  });

  it("uses a dedicated settings sidebar layout on the settings route", async () => {
    const mounted = await mountSidebarApp({ initialEntries: ["/settings"] });

    await expect.element(page.getByTestId("settings-sidebar")).toBeVisible();
    await expect.element(page.getByTestId("settings-sidebar-item-appearance")).toBeVisible();
    await expect.element(page.getByTestId("settings-sidebar-back-to-chat")).toBeVisible();
    await expect
      .poll(() => document.querySelector("[data-testid='sidebar-filter-threads']") !== null)
      .toBe(false);

    await mounted.cleanup();
  });

  it("renders the minimal home surface on / when no projects and no threads are available", async () => {
    const mounted = await mountSidebarApp({
      initialEntries: ["/"],
      configureFixture: (targetFixture) => {
        disableWelcomeBootstrap(targetFixture);
        targetFixture.snapshot = {
          ...targetFixture.snapshot,
          projects: [],
          threads: [],
        };
      },
    });

    await expect.element(page.getByTestId("chat-home-surface")).toBeVisible();
    await expect.poll(() => chatHomeVariantKey()).toBe("no-projects");
    await expect.poll(() => chatHomeVariantText()).toBe("Open or add a project to get started.");

    await mounted.cleanup();
  });

  it("renders fallback content on stale thread URLs and then redirects home without a blank frame", async () => {
    const staleThreadId = "thread-stale-route";
    const mounted = await mountSidebarApp({
      initialEntries: [`/${staleThreadId}`],
      configureFixture: (targetFixture) => {
        disableWelcomeBootstrap(targetFixture);
        targetFixture.snapshot = {
          ...targetFixture.snapshot,
          threads: [],
        };
      },
    });

    await expect.element(page.getByTestId("chat-home-surface")).toBeVisible();
    await expect.poll(() => chatHomeVariantKey()).toBe("no-thread");
    await expect.poll(() => mounted.router.state.location.pathname).toBe("/");

    await mounted.cleanup();
  });

  it("renders the no-thread home variant when projects exist but no active thread is selected", async () => {
    const mounted = await mountSidebarApp({
      initialEntries: ["/"],
      configureFixture: (targetFixture) => {
        disableWelcomeBootstrap(targetFixture);
        targetFixture.snapshot = {
          ...targetFixture.snapshot,
          threads: [],
        };
      },
    });

    await expect.element(page.getByTestId("chat-home-surface")).toBeVisible();
    await expect.poll(() => chatHomeVariantKey()).toBe("no-thread");
    await expect.poll(() => chatHomeVariantText()).toBe(
      "Select a thread or create a new one to get started.",
    );

    await mounted.cleanup();
  });

  it("shows only one desktop sidebar toggle at a time for the active thread shell", async () => {
    const mounted = await mountSidebarApp([`/${THREAD_ID}`]);

    await collapseDesktopSidebar();
    await expect.poll(() => visibleSidebarToggleCount("Expand Sidebar")).toBe(1);
    await expect
      .poll(() => document.querySelector<HTMLElement>("[data-testid='chat-thread-shell']") !== null)
      .toBe(true);

    await mounted.cleanup();
  });

  it.each([
    {
      initialEntries: ["/"],
      label: "thread index",
      configureFixture: disableWelcomeBootstrap,
    },
    {
      initialEntries: ["/settings"],
      label: "settings",
    },
    {
      initialEntries: ["/orchestrate"],
      label: "orchestrate",
    },
    {
      initialEntries: [`/${THREAD_ID}`],
      label: "active thread",
    },
  ])(
    "keeps the shell flush for the $label route when the sidebar is collapsed",
    async ({ configureFixture, initialEntries }) => {
      const mounted = await mountSidebarApp({
        initialEntries,
        ...(configureFixture ? { configureFixture } : {}),
      });

      await collapseDesktopSidebar();
      await expect.poll(() => desktopInsetShellMetrics()).toEqual({
        paddingLeft: "0px",
        contentInsetLeft: 0,
        shellLeft: 8,
      });
      await expect.poll(() => desktopTitlebarBandMetrics().bandHeight).toBe(22);
      await expect.element(page.getByTestId("desktop-leading-slot")).toBeVisible();

      await mounted.cleanup();
    },
  );

  it.each([
    {
      collapseSidebar: false,
      initialEntries: ["/orchestrate"],
      label: "orchestrate expanded",
      titleTestId: "orchestrate-header-title",
      actionsTestId: "orchestrate-header-actions",
      topHeaderTestId: "orchestrate-top-header",
      kind: "orchestrate" as const,
    },
    {
      collapseSidebar: true,
      initialEntries: ["/orchestrate"],
      label: "orchestrate collapsed",
      titleTestId: "orchestrate-header-title",
      actionsTestId: "orchestrate-header-actions",
      topHeaderTestId: "orchestrate-top-header",
      kind: "orchestrate" as const,
    },
    {
      collapseSidebar: false,
      initialEntries: [`/${THREAD_ID}`],
      label: "active thread expanded",
      titleTestId: "chat-header-title",
      actionsTestId: "chat-header-actions",
      topHeaderTestId: "chat-top-header",
      kind: "fixed" as const,
    },
    {
      collapseSidebar: true,
      initialEntries: [`/${THREAD_ID}`],
      label: "active thread collapsed",
      titleTestId: "chat-header-title",
      actionsTestId: "chat-header-actions",
      topHeaderTestId: "chat-top-header",
      kind: "fixed" as const,
    },
  ])(
    "keeps the $label header below the desktop titlebar band",
    async ({ collapseSidebar, initialEntries, titleTestId, actionsTestId, topHeaderTestId, kind }) => {
      const mounted = await mountSidebarApp({ initialEntries });

      if (collapseSidebar) {
        await collapseDesktopSidebar();
      }

      await expect.poll(() => desktopTitlebarBandMetrics().bandHeight).toBe(22);
      await expect
        .poll(() => {
          const metrics = desktopTitlebarBandClearance(titleTestId);
          return metrics.targetTop - metrics.bandBottom;
        })
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(() => {
          const metrics = desktopTitlebarBandClearance(actionsTestId);
          return metrics.targetTop - metrics.bandBottom;
        })
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(() => {
          const metrics = desktopCaptionButtonLaneMetrics(actionsTestId);
          return window.innerWidth - metrics.laneWidth - metrics.targetRight;
        })
        .toBeGreaterThanOrEqual(0);
      if (kind === "fixed") {
        await expect.poll(() => elementHeightByTestId(topHeaderTestId)).toBe(40);
      } else {
        await expect.poll(() => elementHeightByTestId(topHeaderTestId)).toBeGreaterThanOrEqual(40);
      }

      await mounted.cleanup();
    },
  );

  it("keeps integrated browser and diff top chrome below the desktop titlebar band", async () => {
    window.desktopBridge = {
      ...window.desktopBridge,
      browser: createDesktopBrowserBridge(PROJECT_ID),
    } as DesktopBridge;
    useBrowserPaneStore.setState({
      width: 480,
    });

    const mounted = await mountSidebarApp({
      initialEntries: [`/${THREAD_ID}?panel=browser`],
      viewport: {
        width: 1680,
        height: 960,
      },
    });

    await expect.element(page.getByTestId("integrated-browser-header-actions")).toBeVisible();
    await expect.element(page.getByTestId("integrated-browser-pane")).toBeVisible();
    await expect.poll(() => desktopTitlebarBandMetrics().bandHeight).toBe(22);
    await expect.poll(() => elementHeightByTestId("integrated-browser-top-header")).toBeGreaterThanOrEqual(40);
    await expect.poll(() => viewportRightGapByTestId("integrated-browser-pane")).toBe(0);

    await expect
      .poll(
        () =>
          desktopTitlebarBandClearance("integrated-browser-header-actions").targetTop -
          desktopTitlebarBandClearance("integrated-browser-header-actions").bandBottom,
      )
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() => {
        const metrics = desktopCaptionButtonLaneMetrics("integrated-browser-header-actions");
        return window.innerWidth - metrics.laneWidth - metrics.targetRight;
      })
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() => {
        const metrics = desktopCaptionButtonLaneMetrics("integrated-browser-header-actions");
        return window.innerWidth - metrics.targetRight;
      })
      .toBeLessThanOrEqual(16);

    await expect.element(page.getByLabelText("Toggle diff panel")).toBeVisible();
    await page.getByLabelText("Toggle diff panel").click();
    await expect.element(page.getByTestId("diff-panel-header-actions")).toBeVisible();
    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>("[data-testid='integrated-browser-pane']") ?? null,
      )
      .toBeNull();
    await expect.poll(() => elementHeightByTestId("diff-panel-top-header")).toBe(40);

    await expect
      .poll(
        () =>
          desktopTitlebarBandClearance("diff-panel-header-actions").targetTop -
          desktopTitlebarBandClearance("diff-panel-header-actions").bandBottom,
      )
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() => {
        const metrics = desktopCaptionButtonLaneMetrics("diff-panel-header-actions");
        return window.innerWidth - metrics.laneWidth - metrics.targetRight;
      })
      .toBeGreaterThanOrEqual(0);
    await expect.poll(() => desktopInsetShellMetrics().paddingLeft).toBe("0px");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);

    await mounted.cleanup();
  });

  it("stretches the orchestrate board to the scroll viewport when only a few columns are visible", async () => {
    const mounted = await mountSidebarApp({ initialEntries: ["/orchestrate"] });

    await expect.element(page.getByTestId("orchestrate-board-grid")).toBeVisible();
    await expect.poll(() => scrollViewportRightGapByTestId("orchestrate-board-grid")).toBe(0);

    await mounted.cleanup();
  });

  it.each([
    {
      initialEntries: ["/settings"],
      label: "settings",
      topHeaderTestId: "settings-top-header",
      expectedHeight: 40,
    },
    {
      initialEntries: ["/orchestrate"],
      label: "orchestrate",
      topHeaderTestId: "orchestrate-top-header",
      expectedHeight: 40,
    },
  ])(
    "matches the desktop titlebar band main surface to the $label page shell surface",
    async ({ initialEntries, topHeaderTestId, expectedHeight }) => {
    const mounted = await mountSidebarApp({ initialEntries });

    expect(computedBackgroundColorByTestId("desktop-titlebar-band-main-surface")).toBe(
      sidebarInsetBackgroundColor(),
    );
    expect(computedBackgroundColorByTestId("desktop-titlebar-band-sidebar-surface")).toBe(
      sidebarSurfaceBackgroundColor(),
    );
    await expect.poll(() => elementHeightByTestId(topHeaderTestId)).toBeGreaterThanOrEqual(expectedHeight);

    await mounted.cleanup();
    },
  );

  it.each([
    {
      initialEntries: ["/settings"],
      label: "settings",
      titleTestId: "settings-header-label",
    },
    {
      initialEntries: ["/orchestrate"],
      label: "orchestrate",
      titleTestId: "orchestrate-header-title",
    },
    {
      initialEntries: [`/${THREAD_ID}`],
      label: "active thread",
      titleTestId: "chat-header-title",
    },
  ])(
    "keeps the $label header below the desktop titlebar band when the sidebar is collapsed",
    async ({ initialEntries, titleTestId }) => {
      const mounted = await mountSidebarApp({ initialEntries });

      await collapseDesktopSidebar();
      await expect.poll(() => desktopInsetShellMetrics().paddingLeft).toBe("0px");
      await expect.poll(() => desktopTitlebarBandMetrics().bandHeight).toBe(22);
      await expect.element(page.getByTestId("desktop-leading-slot")).toBeVisible();
      if (titleTestId === "settings-header-label") {
        await expect.poll(() => elementHeightByTestId("settings-top-header")).toBe(40);
      } else if (titleTestId === "orchestrate-header-title") {
        await expect.poll(() => elementHeightByTestId("orchestrate-top-header")).toBeGreaterThanOrEqual(40);
      } else {
        await expect.poll(() => elementHeightByTestId("chat-top-header")).toBe(40);
      }
      await expect
        .poll(() => {
          const metrics = desktopTitlebarBandClearance(titleTestId);
          return metrics.targetTop - metrics.bandBottom;
        })
        .toBeGreaterThanOrEqual(0);

      await mounted.cleanup();
    },
  );

  it("renders the desktop leading slot and swaps from the logo mark to the toggle affordance on hover and focus", async () => {
    const mounted = await mountSidebarApp([`/${THREAD_ID}`]);
    const trigger = page.getByTestId("desktop-sidebar-brand-trigger");
    const threadShell = page.getByTestId("chat-thread-shell");

    await expect.element(page.getByTestId("desktop-leading-slot")).toBeVisible();
    await expect.element(trigger).toBeVisible();

    await threadShell.hover();
    await expect.poll(() => desktopBrandTriggerOpacities()).toEqual({ mark: 1, toggle: 0 });

    await trigger.hover();
    await expect.poll(() => desktopBrandTriggerOpacities()).toEqual({ mark: 0, toggle: 1 });

    document.querySelector<HTMLElement>("[data-testid='desktop-sidebar-brand-trigger']")?.focus();
    await nextFrame();
    await expect.poll(() => desktopBrandTriggerOpacities()).toEqual({ mark: 0, toggle: 1 });

    await mounted.cleanup();
  });

  it("does not reserve an Electron titlebar band in plain browser mode without Electron APIs", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    const mounted = await mountSidebarApp([`/${THREAD_ID}`]);

    await expect.poll(() => desktopInsetShellMetrics().paddingLeft).toBe("0px");
    expect(document.querySelector("[data-testid='desktop-titlebar-band']")).toBeNull();
    expect(document.querySelector("[data-testid='desktop-leading-slot']")).toBeNull();

    await mounted.cleanup();
  });

  it("shrinks the sidebar titlebar surface to the trigger slot width when the desktop sidebar is collapsed", async () => {
    const mounted = await mountSidebarApp([`/${THREAD_ID}`]);

    await expect.element(page.getByTestId("desktop-titlebar-band-sidebar-surface")).toBeVisible();
    await expect.poll(() => elementHeightByTestId("sidebar-top-header")).toBe(40);
    expect(computedBackgroundColorByTestId("desktop-titlebar-band-sidebar-surface")).toBe(
      sidebarSurfaceBackgroundColor(),
    );

    await collapseDesktopSidebar();

    expect(sidebarSurfaceWidth()).toBe(52);
    expect(computedBackgroundColorByTestId("desktop-titlebar-band-sidebar-surface")).toBe(
      sidebarSurfaceBackgroundColor(),
    );

    await mounted.cleanup();
  });

  it("opens the settings popover with authenticated account data and rate limits", async () => {
    const mounted = await mountSidebarApp();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.element(page.getByText("aellisatl@gmail.com")).toBeVisible();
    await expect.element(page.getByText("Personal account")).toBeVisible();

    await page.getByRole("button", { name: /Rate limits remaining 0%/ }).click();
    await expect.element(page.getByText("5h")).toBeVisible();
    await expect.element(page.getByText("Weekly")).toBeVisible();
    await expect.element(page.getByText("Upgrade to Pro")).toBeVisible();
    await expect.element(page.getByText("Learn more")).toBeVisible();

    await mounted.cleanup();
  });

  it("switches between grouped and chronological thread organization", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [
          makeThreadEntry("thread-alpha" as ThreadId, projectAlpha, "Alpha thread"),
          makeThreadEntry("thread-beta" as ThreadId, projectBeta, "Beta thread"),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectAlpha,
        bootstrapThreadId: "thread-alpha" as ThreadId,
      },
    };

    const mounted = await mountSidebarApp();

    await expect
      .poll(() => projectOrderLabels().length)
      .toBe(2);

    await page.getByRole("button", { name: "Filter threads" }).click();
    await page.getByText("Chronological list", { exact: true }).click();

    await expect
      .poll(() => projectOrderLabels().length)
      .toBe(0);

    await mounted.cleanup();
  });

  it("switches sort order between updated and created", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [makeProjectEntry(projectAlpha, "Alpha")],
        threads: [
          makeThreadEntry("thread-created-newest" as ThreadId, projectAlpha, "Created newest", {
            createdAt: "2026-03-04T12:05:00.000Z",
            updatedAt: "2026-03-04T12:01:00.000Z",
          }),
          makeThreadEntry("thread-updated-newest" as ThreadId, projectAlpha, "Updated newest", {
            createdAt: "2026-03-04T12:01:00.000Z",
            updatedAt: "2026-03-04T12:06:00.000Z",
          }),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectAlpha,
        bootstrapThreadId: "thread-updated-newest" as ThreadId,
      },
    };

    const mounted = await mountSidebarApp();

    await expect
      .poll(() => {
        const sidebarText = document.body.textContent ?? "";
        return (
          sidebarText.indexOf("Updated newest") < sidebarText.indexOf("Created newest")
        );
      })
      .toBe(true);

    await page.getByRole("button", { name: "Filter threads" }).click();
    await page.getByText("Created", { exact: true }).click();

    await expect
      .poll(() => {
        const sidebarText = document.body.textContent ?? "";
        return (
          sidebarText.indexOf("Created newest") < sidebarText.indexOf("Updated newest")
        );
      })
      .toBe(true);

    await mounted.cleanup();
  });

  it("filters to relevant threads and hides empty projects", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [
          makeThreadEntry("thread-stale" as ThreadId, projectAlpha, "Stale thread", {
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          makeThreadEntry("thread-relevant" as ThreadId, projectBeta, "Relevant thread", {
            isPinned: true,
            createdAt: "2026-03-04T12:05:00.000Z",
            updatedAt: "2026-03-04T12:05:00.000Z",
          }),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectBeta,
        bootstrapThreadId: "thread-relevant" as ThreadId,
      },
    };

    const mounted = await mountSidebarApp();

    await page.getByRole("button", { name: "Filter threads" }).click();
    await page.getByText("Relevant", { exact: true }).click();

    await expect
      .poll(() => projectOrderLabels())
      .toEqual(["Beta"]);
    await expect
      .poll(() => document.body.textContent?.includes("Relevant thread") ?? false)
      .toBe(true);
    await expect
      .poll(() => document.body.textContent?.includes("Alpha") ?? false)
      .toBe(false);

    await mounted.cleanup();
  });

  it("reorders projects via drag and drop and persists after remount", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    const projectGamma = "project-gamma" as ProjectId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
          makeProjectEntry(projectGamma, "Gamma"),
        ],
        threads: [],
      },
      welcome: {
        cwd: "C:\\Users\\Addis\\source\\repos\\t3code-main",
        projectName: "t3code-main",
      } as WsWelcomePayload,
    };

    const mounted = await mountSidebarApp();

    await expect.poll(() => projectOrderLabels()).toEqual(["Alpha", "Beta", "Gamma"]);

    await dragProjectRow("sidebar-project-project-gamma", "sidebar-project-project-alpha");

    await expect.poll(() => projectOrderLabels()).toEqual(["Gamma", "Alpha", "Beta"]);

    await mounted.cleanup();
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });

    const remounted = await mountSidebarApp();
    await expect.poll(() => projectOrderLabels()).toEqual(["Gamma", "Alpha", "Beta"]);
    await remounted.cleanup();
  });

  it("uses the first visible project when New thread is clicked without an active thread", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [],
      },
      welcome: {
        cwd: "C:\\Users\\Addis\\source\\repos\\t3code-main",
        projectName: "t3code-main",
      } as WsWelcomePayload,
    };

    const mounted = await mountSidebarApp();

    await page.getByTestId("sidebar-primary-new-thread").click();

    await expect
      .poll(() => {
        const draftMap = useComposerDraftStore.getState().projectDraftThreadIdByProjectId;
        return draftMap[projectAlpha] ?? null;
      })
      .not.toBeNull();

    await mounted.cleanup();
  });

  it("disposes an empty primary new-thread draft when switching threads", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    const threadBeta = "thread-beta" as ThreadId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [makeThreadEntry(threadBeta, projectBeta, "Beta thread")],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectBeta,
        bootstrapThreadId: threadBeta,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${threadBeta}`] });

    await page.getByTestId(`sidebar-project-${projectAlpha}`).hover();
    await page.getByTestId(`sidebar-project-new-thread-${projectAlpha}`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha] ?? null)
      .not.toBeNull();

    const draftThreadId = useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha];
    expect(draftThreadId).toBeTruthy();
    if (!draftThreadId) {
      await mounted.cleanup();
      return;
    }

    await page.getByTestId(`sidebar-thread-${threadBeta}`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId] ?? null)
      .toBeNull();
    await expect
      .poll(() => useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha] ?? null)
      .toBeNull();

    await mounted.cleanup();
  });

  it("keeps a primary new-thread draft with typed prompt when switching threads", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    const threadBeta = "thread-beta" as ThreadId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [makeThreadEntry(threadBeta, projectBeta, "Beta thread")],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectBeta,
        bootstrapThreadId: threadBeta,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${threadBeta}`] });

    await page.getByTestId(`sidebar-project-${projectAlpha}`).hover();
    await page.getByTestId(`sidebar-project-new-thread-${projectAlpha}`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha] ?? null)
      .not.toBeNull();

    const draftThreadId = useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha];
    expect(draftThreadId).toBeTruthy();
    if (!draftThreadId) {
      await mounted.cleanup();
      return;
    }

    useComposerDraftStore.getState().setPrompt(draftThreadId, "Keep this draft");

    await page.getByTestId(`sidebar-thread-${threadBeta}`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId] ?? null)
      .not.toBeNull();
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[draftThreadId]?.prompt ?? null)
      .toBe("Keep this draft");

    await mounted.cleanup();
  });

  it("keeps the dashed disposable thread flow behavior when switching threads", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    const threadBeta = "thread-beta" as ThreadId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [makeThreadEntry(threadBeta, projectBeta, "Beta thread")],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectBeta,
        bootstrapThreadId: threadBeta,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${threadBeta}`] });

    await page.getByTestId(`sidebar-project-${projectAlpha}`).hover();
    await page.getByLabelText(`New disposable thread in Alpha`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha] ?? null)
      .not.toBeNull();

    const draftThreadId = useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha];
    expect(draftThreadId).toBeTruthy();
    if (!draftThreadId) {
      await mounted.cleanup();
      return;
    }

    await expect
      .poll(() => useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId]?.isTemporary ?? false)
      .toBe(true);

    useComposerDraftStore.getState().setPrompt(draftThreadId, "Temporary chat should still dispose");
    await page.getByTestId(`sidebar-thread-${threadBeta}`).click();

    await expect
      .poll(() => useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId] ?? null)
      .toBeNull();

    await mounted.cleanup();
  });

  it("creates a local draft thread from the hovered project action without reusing another branch", async () => {
    const projectAlpha = "project-alpha" as ProjectId;
    const projectBeta = "project-beta" as ProjectId;
    const threadBeta = "thread-beta" as ThreadId;
    const projectActionTestId = `sidebar-project-new-thread-${projectAlpha}`;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        projects: [
          makeProjectEntry(projectAlpha, "Alpha"),
          makeProjectEntry(projectBeta, "Beta"),
        ],
        threads: [
          makeThreadEntry("thread-alpha" as ThreadId, projectAlpha, "Alpha thread"),
          makeThreadEntry(threadBeta, projectBeta, "Beta thread", {
            branch: "feature/previous-branch",
            worktreePath: "C:\\worktrees\\feature-previous-branch",
          }),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapProjectId: projectBeta,
        bootstrapThreadId: threadBeta,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${threadBeta}`] });

    await expect.poll(() => elementOpacityByTestId(projectActionTestId)).toBe(0);

    await page.getByTestId(`sidebar-project-${projectAlpha}`).hover();

    await expect.poll(() => elementOpacityByTestId(projectActionTestId)).toBe(1);

    await page.getByTestId(projectActionTestId).click();

    await expect
      .poll(() => {
        const draftThreadId =
          useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectAlpha] ?? null;
        if (!draftThreadId) {
          return null;
        }
        const draftThread = useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId];
        if (!draftThread) {
          return null;
        }
        return {
          projectId: draftThread.projectId,
          branch: draftThread.branch,
          worktreePath: draftThread.worktreePath,
          envMode: draftThread.envMode,
        };
      })
      .toEqual({
        projectId: projectAlpha,
        branch: null,
        worktreePath: null,
        envMode: "local",
      });

    await mounted.cleanup();
  });

  it("auto-reveals an active subagent child thread alongside its parent", async () => {
    const parentThreadId = "thread-parent" as ThreadId;
    const childThreadId = "subagent:thread-parent:child-provider-1" as ThreadId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        threads: [
          makeThreadEntry(parentThreadId, PROJECT_ID, "Parent thread"),
          makeThreadEntry(childThreadId, PROJECT_ID, "Locke [explorer]", {
            parentThreadId,
            subagentAgentId: "agent-1",
            subagentNickname: "Locke",
            subagentRole: "explorer",
          } as Partial<OrchestrationReadModel["threads"][number]>),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapThreadId: childThreadId,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${childThreadId}`] });

    try {
      await expect.element(page.getByTestId(`sidebar-thread-${parentThreadId}`)).toBeVisible();
      await expect.element(page.getByTestId(`sidebar-thread-${childThreadId}`)).toBeVisible();
      await expect
        .poll(
          () => document.body.textContent?.includes("Locke") ?? false,
        )
        .toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("archives a regular thread from the inline hover action", async () => {
    const mounted = await mountSidebarApp();

    try {
      const threadRow = page.getByTestId(`sidebar-thread-${THREAD_ID}`);
      await threadRow.hover();
      await expect.element(page.getByTestId(`sidebar-thread-archive-${THREAD_ID}`)).toBeVisible();

      await page.getByTestId(`sidebar-thread-archive-${THREAD_ID}`).click();
      await expect
        .element(page.getByTestId(`sidebar-thread-archive-confirm-${THREAD_ID}`))
        .toBeVisible();

      await page.getByTestId(`sidebar-thread-archive-confirm-${THREAD_ID}`).click();

      await expect
        .poll(
          () =>
            fixture.snapshot.threads.find((thread) => thread.id === THREAD_ID)?.archivedAt ?? null,
        )
        .not.toBe(null);
      await expect.element(page.getByTestId(`sidebar-thread-${THREAD_ID}`)).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the inline archive action for pinned and nested subagent rows", async () => {
    const pinnedThreadId = "thread-pinned" as ThreadId;
    const parentThreadId = "thread-parent-archive" as ThreadId;
    const childThreadId = "subagent:thread-parent-archive:child-provider-archive" as ThreadId;
    fixture = {
      ...fixture,
      snapshot: {
        ...fixture.snapshot,
        threads: [
          makeThreadEntry(pinnedThreadId, PROJECT_ID, "Pinned thread", {
            isPinned: true,
            pinnedAt: NOW_ISO,
          } as Partial<OrchestrationReadModel["threads"][number]>),
          makeThreadEntry(parentThreadId, PROJECT_ID, "Parent thread"),
          makeThreadEntry(childThreadId, PROJECT_ID, "Scout [researcher]", {
            parentThreadId,
            subagentAgentId: "agent-archive",
            subagentNickname: "Scout",
            subagentRole: "researcher",
          } as Partial<OrchestrationReadModel["threads"][number]>),
        ],
      },
      welcome: {
        ...fixture.welcome,
        bootstrapThreadId: childThreadId,
      },
    };

    const mounted = await mountSidebarApp({ initialEntries: [`/${childThreadId}`] });

    try {
      await page.getByTestId(`sidebar-pinned-thread-${pinnedThreadId}`).hover();
      await expect
        .element(page.getByTestId(`sidebar-thread-archive-${pinnedThreadId}`))
        .toBeVisible();

      await page.getByTestId(`sidebar-thread-${childThreadId}`).hover();
      await expect
        .element(page.getByTestId(`sidebar-thread-archive-${childThreadId}`))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});
