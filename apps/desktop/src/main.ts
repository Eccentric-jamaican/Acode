import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import type {
  ApprovalRequestId,
  BrowserInspectCapture,
  BrowserPaneBounds,
  BrowserRuntimeEvent,
  DesktopNotificationAction,
  DesktopNotificationFallbackInput,
  DesktopNotificationPayload,
  DesktopNotificationQuestion,
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import {
  APP_DESKTOP_APP_ID,
  APP_DESKTOP_ENABLE_AUTO_UPDATES,
  getAppDisplayName,
} from "@t3tools/shared/branding";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { BrowserRuntimeRegistry } from "./browserRuntime";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { fixPath } from "./fixPath";
import {
  getAutoUpdateDisabledReason,
  shouldBroadcastDownloadProgress,
} from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { importLegacyDesktopStateIfNeeded } from "./legacyStateImport";
import { resolveDesktopStateDir } from "./statePaths";
import { getDesktopWindowChromeMetrics } from "./windowChromeMetrics";

fixPath();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";
const NOTIFICATIONS_ACTION_CHANNEL = "desktop:notifications-action";
const NOTIFICATIONS_CONSUME_PENDING_ACTIONS_CHANNEL = "desktop:notifications-consume-pending-actions";
const BROWSER_GET_STATE_CHANNEL = "desktop:browser-get-state";
const BROWSER_OPEN_CHANNEL = "desktop:browser-open";
const BROWSER_CLOSE_PANE_CHANNEL = "desktop:browser-close-pane";
const BROWSER_NEW_TAB_CHANNEL = "desktop:browser-new-tab";
const BROWSER_ACTIVATE_TAB_CHANNEL = "desktop:browser-activate-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "desktop:browser-close-tab";
const BROWSER_NAVIGATE_CHANNEL = "desktop:browser-navigate";
const BROWSER_BACK_CHANNEL = "desktop:browser-back";
const BROWSER_FORWARD_CHANNEL = "desktop:browser-forward";
const BROWSER_RELOAD_CHANNEL = "desktop:browser-reload";
const BROWSER_KILL_CHANNEL = "desktop:browser-kill";
const BROWSER_GET_SETTINGS_CHANNEL = "desktop:browser-get-settings";
const BROWSER_UPDATE_SETTINGS_CHANNEL = "desktop:browser-update-settings";
const BROWSER_CLEAR_BROWSING_DATA_CHANNEL = "desktop:browser-clear-browsing-data";
const BROWSER_SET_INSPECT_MODE_CHANNEL = "desktop:browser-set-inspect-mode";
const BROWSER_CAPTURE_INSPECT_SELECTION_CHANNEL = "desktop:browser-capture-inspect-selection";
const BROWSER_EVENT_CHANNEL = "desktop:browser-event";
const BROWSER_PAGE_EVENT_CHANNEL = "desktop:browser-page-event";
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = getAppDisplayName(isDevelopment);
const STATE_DIR = resolveDesktopStateDir(process.env.T3CODE_STATE_DIR);
const legacyStateImport = importLegacyDesktopStateIfNeeded({
  targetStateDir: STATE_DIR,
  explicitStateDir: process.env.T3CODE_STATE_DIR,
});
const ELECTRON_USER_DATA_DIR =
  process.env.T3CODE_ELECTRON_USER_DATA_DIR?.trim() ||
  Path.join(app.getPath("appData"), APP_DISPLAY_NAME);
const DESKTOP_SCHEME = "t3";
function resolveExplicitDevRoot(): string | null {
  const commandLineValue = app.commandLine.getSwitchValue("t3code-dev-root")?.trim();
  if (commandLineValue) {
    return Path.resolve(commandLineValue);
  }

  for (const argument of process.argv) {
    if (!argument.startsWith("--t3code-dev-root=")) {
      continue;
    }
    const value = argument.slice("--t3code-dev-root=".length).trim();
    if (value.length === 0) {
      continue;
    }
    return Path.resolve(value);
  }
  return null;
}

const EXPLICIT_DEV_ROOT = resolveExplicitDevRoot();
const ROOT_DIR = EXPLICIT_DEV_ROOT ?? Path.resolve(__dirname, "../../..");
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const WINDOWS_TOAST_ACTIVATOR_CLSID = "{5F94EA7E-6646-4B11-9AA6-4C80A88E1D1A}";
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Cold starts can exceed 45s on larger local state stores; keep the renderer
// gated longer so it doesn't spam connection-refused before backend is ready.
const BACKEND_READY_TIMEOUT_MS = 90_000;
const BACKEND_READY_POLL_INTERVAL_MS = 250;
const BACKEND_READY_SOCKET_TIMEOUT_MS = 500;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let browserBridgeServer: Http.Server | null = null;
let browserBridgeUrl = "";
let browserBridgeAuthToken = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
const pendingDesktopNotificationActions: DesktopNotificationAction[] = [];
let windowsRichToastDisabledForSession: string | null = null;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const browserRuntimeRegistry = new BrowserRuntimeRegistry({
  browserPreloadPath: Path.join(__dirname, "browserPreload.js"),
  settingsPath: Path.join(STATE_DIR, "browser-use-settings.json"),
  approveOpenUrl: async (url) => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(
      [`Open ${url} in the in-app browser?`, "You can change this in Settings > Browser use."].join(
        "\n",
      ),
      owner,
    );
  },
  approveHistoryAccess: async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(
      [
        "Allow Codex to navigate browser history?",
        "You can change this in Settings > Browser use.",
      ].join("\n"),
      owner,
    );
  },
});
const initialUpdateState = (): DesktopUpdateState => createInitialDesktopUpdateState(app.getVersion());

function emitBrowserEvent(event: BrowserRuntimeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(BROWSER_EVENT_CHANNEL, event);
  }
}

browserRuntimeRegistry.on("event", emitBrowserEvent);

app.setPath("userData", ELECTRON_USER_DATA_DIR);
app.setPath("sessionData", Path.join(ELECTRON_USER_DATA_DIR, "session"));

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function asProjectId(value: unknown): ProjectId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("projectId must be a non-empty string.");
  }
  return value as ProjectId;
}

function asPaneBounds(value: unknown): BrowserPaneBounds {
  if (!value || typeof value !== "object") {
    throw new Error("bounds must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error("bounds must contain finite numbers.");
  }
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }
  return value as Record<string, unknown>;
}

function readWindowsLastNotificationAddedTime(appId: string): number | null {
  if (process.platform !== "win32") {
    return null;
  }

  const registryPath = `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`;
  const result = ChildProcess.spawnSync("reg.exe", ["query", registryPath, "/v", "LastNotificationAddedTime"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/LastNotificationAddedTime\s+REG_QWORD\s+0x([0-9a-f]+)/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return Number.parseInt(match[1], 16);
  } catch {
    return null;
  }
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readNotificationQuestion(
  rawQuestion: unknown,
  questionIndex: number,
): DesktopNotificationQuestion {
  const question = asRecord(rawQuestion);
  const rawOptions = question.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw new Error(`questions[${questionIndex}].options must be a non-empty array.`);
  }

  return {
    id: readRequiredString(question, "id"),
    header: readRequiredString(question, "header"),
    question: readRequiredString(question, "question"),
    options: rawOptions.map((rawOption) => {
      const option = asRecord(rawOption);
      return {
        id: readRequiredString(option, "id"),
        label: readRequiredString(option, "label"),
        description: readRequiredString(option, "description"),
      };
    }),
  };
}

function parseDesktopNotificationPayload(rawInput: unknown): DesktopNotificationPayload {
  const input = asRecord(rawInput);
  const kind = readRequiredString(input, "kind");
  const base = {
    notificationId: readRequiredString(input, "notificationId"),
    threadId: readRequiredString(input, "threadId") as ThreadId,
    projectId: readRequiredString(input, "projectId") as ProjectId,
    title: readRequiredString(input, "title"),
    body: String(input.body ?? ""),
    ...(readBoolean(input, "silent") ? { silent: true } : {}),
  };

  if (kind === "turn_completed") {
    return {
      kind,
      ...base,
    };
  }

  if (kind === "approval_required") {
    const requestKind = readRequiredString(input, "requestKind");
    if (
      requestKind !== "command" &&
      requestKind !== "file-read" &&
      requestKind !== "file-change"
    ) {
      throw new Error("requestKind must be command, file-read, or file-change.");
    }
    const detail = readOptionalString(input, "detail");
    return {
      ...base,
      kind,
      requestId: readRequiredString(input, "requestId") as ApprovalRequestId,
      requestKind,
      ...(detail ? { detail } : {}),
    };
  }

  if (kind === "user_input_required") {
    const rawQuestions = input.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      throw new Error("questions must be a non-empty array.");
    }
    return {
      ...base,
      kind,
      requestId: readRequiredString(input, "requestId") as ApprovalRequestId,
      questions: rawQuestions.map(readNotificationQuestion),
    };
  }

  throw new Error(`Unsupported notification kind: ${kind}`);
}

function emitDesktopNotificationAction(action: DesktopNotificationAction): void {
  pendingDesktopNotificationActions.push(action);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(NOTIFICATIONS_ACTION_CHANNEL, action);
  }
}

function consumePendingDesktopNotificationActions(): DesktopNotificationAction[] {
  const pending = [...pendingDesktopNotificationActions];
  pendingDesktopNotificationActions.length = 0;
  return pending;
}

function focusMainWindow(): void {
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function buildDesktopNotificationFallbackInput(
  input: DesktopNotificationPayload,
): DesktopNotificationFallbackInput {
  const action =
    input.kind === "turn_completed" ||
    input.kind === "approval_required" ||
    input.kind === "user_input_required"
      ? { type: "open-thread" as const, label: "Open thread" }
      : undefined;
  return {
    title: input.title,
    body: input.body,
    ...(input.silent === true ? { silent: true } : {}),
    ...(action ? { action } : {}),
  };
}

function encodeDesktopNotificationAction(args: Record<string, string>): string {
  const params = new URLSearchParams(args);
  return params.toString();
}

function parseDesktopNotificationActionPayload(serialized: string): Record<string, string> {
  const params = new URLSearchParams(serialized);
  return Object.fromEntries(params.entries());
}

function tryReadNotificationAnswer(
  rawInput: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = rawInput[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toUserInputResponseAction(
  input: Extract<DesktopNotificationPayload, { kind: "user_input_required" }>,
  rawAnswers: Record<string, unknown>,
): DesktopNotificationAction | null {
  const answers: Record<string, string> = {};
  for (const question of input.questions) {
    const selectionId = tryReadNotificationAnswer(rawAnswers, question.id);
    if (!selectionId) {
      return null;
    }
    const selected = question.options.find((option) => option.id === selectionId);
    if (!selected) {
      return null;
    }
    answers[question.id] = selected.label;
  }
  return {
    kind: "user_input_response",
    notificationId: input.notificationId,
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: input.requestId,
    answers,
  };
}

function handleWindowsToastActivation(
  input: DesktopNotificationPayload,
  serializedAction: string,
  rawNotificationInput: Record<string, unknown>,
): void {
  const payload = parseDesktopNotificationActionPayload(serializedAction);
  const actionKind = payload.action;
  if (actionKind === "open_thread") {
    focusMainWindow();
    emitDesktopNotificationAction({
      kind: "open_thread",
      notificationId: input.notificationId,
      threadId: input.threadId,
      projectId: input.projectId,
    });
    return;
  }
  if (actionKind === "approval_response" && input.kind === "approval_required") {
    const decision = payload.decision;
    if (decision === "accept" || decision === "decline") {
      emitDesktopNotificationAction({
        kind: "approval_response",
        notificationId: input.notificationId,
        threadId: input.threadId,
        projectId: input.projectId,
        requestId: input.requestId,
        decision,
      });
      return;
    }
  }
  if (actionKind === "user_input_response" && input.kind === "user_input_required") {
    const action = toUserInputResponseAction(input, rawNotificationInput);
    if (action) {
      emitDesktopNotificationAction(action);
      return;
    }
    focusMainWindow();
    emitDesktopNotificationAction({
      kind: "open_thread",
      notificationId: input.notificationId,
      threadId: input.threadId,
      projectId: input.projectId,
    });
    return;
  }

  focusMainWindow();
  emitDesktopNotificationAction({
    kind: "open_thread",
    notificationId: input.notificationId,
    threadId: input.threadId,
    projectId: input.projectId,
  });
}

async function readRequestBody(request: Http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function shouldRevealBrowserPaneForBridgeMethod(method: string): boolean {
  switch (method) {
    case "browser.ensure":
    case "browser.show":
    case "browser.new_tab":
    case "browser.activate_tab":
    case "browser.close_tab":
    case "browser.list_tabs":
    case "browser.navigate":
    case "browser.back":
    case "browser.forward":
    case "browser.reload":
    case "browser.snapshot":
    case "browser.screenshot":
    case "browser.wait_for":
    case "browser.click":
    case "browser.hover":
    case "browser.fill":
    case "browser.type_text":
    case "browser.press_key":
    case "browser.evaluate":
      return true;
    default:
      return false;
  }
}

async function handleBrowserBridgeRequest(body: unknown): Promise<unknown> {
  const record = asRecord(body);
  const method = record.method;
  const params = record.params;
  if (typeof method !== "string" || method.length === 0) {
    throw new Error("method must be a non-empty string.");
  }
  const input = params === undefined ? {} : asRecord(params);
  const revealedProjectId = shouldRevealBrowserPaneForBridgeMethod(method)
    ? asProjectId(input.projectId)
    : null;
  if (revealedProjectId) {
    await browserRuntimeRegistry.requestPane(revealedProjectId);
  }
  switch (method) {
    case "browser.ensure":
      return browserRuntimeRegistry.ensure(revealedProjectId ?? asProjectId(input.projectId));
    case "browser.show":
      return browserRuntimeRegistry.getState(revealedProjectId ?? asProjectId(input.projectId));
    case "browser.kill":
      await browserRuntimeRegistry.kill(asProjectId(input.projectId));
      return {};
    case "browser.new_tab":
      return browserRuntimeRegistry.newTab(
        asProjectId(input.projectId),
        typeof input.url === "string" && input.url.trim().length > 0 ? input.url : undefined,
      );
    case "browser.activate_tab":
      if (typeof input.tabId !== "string" || input.tabId.trim().length === 0) {
        throw new Error("tabId must be a non-empty string.");
      }
      return browserRuntimeRegistry.activateTab(asProjectId(input.projectId), input.tabId);
    case "browser.close_tab":
      if (typeof input.tabId !== "string" || input.tabId.trim().length === 0) {
        throw new Error("tabId must be a non-empty string.");
      }
      return browserRuntimeRegistry.closeTab(asProjectId(input.projectId), input.tabId);
    case "browser.list_tabs": {
      const state = await browserRuntimeRegistry.getState(asProjectId(input.projectId));
      return {
        tabs: state.tabs ?? [],
        activeTabId: state.activeTabId ?? null,
      };
    }
    case "browser.navigate":
      if (typeof input.url !== "string" || input.url.trim().length === 0) {
        throw new Error("url must be a non-empty string.");
      }
      return browserRuntimeRegistry.navigate(asProjectId(input.projectId), input.url);
    case "browser.get_settings":
      return browserRuntimeRegistry.getSettings();
    case "browser.update_settings":
      return browserRuntimeRegistry.updateSettings(input);
    case "browser.clear_browsing_data":
      return browserRuntimeRegistry.clearBrowsingData({
        kind:
          input.kind === "cookies" || input.kind === "cache" || input.kind === "siteData"
            ? input.kind
            : "all",
      });
    case "browser.back":
      return browserRuntimeRegistry.back(asProjectId(input.projectId));
    case "browser.forward":
      return browserRuntimeRegistry.forward(asProjectId(input.projectId));
    case "browser.reload":
      return browserRuntimeRegistry.reload(asProjectId(input.projectId));
    case "browser.snapshot":
      return browserRuntimeRegistry.snapshot(asProjectId(input.projectId));
    case "browser.screenshot":
      return { dataUrl: await browserRuntimeRegistry.screenshot(asProjectId(input.projectId)) };
    case "browser.wait_for":
      return {
        matched: await browserRuntimeRegistry.waitFor(asProjectId(input.projectId), {
          ...(typeof input.selector === "string" ? { selector: input.selector } : {}),
          ...(typeof input.text === "string" ? { text: input.text } : {}),
          ...(typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
            ? { timeoutMs: input.timeoutMs }
            : {}),
        }),
      };
    case "browser.click":
      if (typeof input.selector !== "string" || input.selector.trim().length === 0) {
        throw new Error("selector must be a non-empty string.");
      }
      await browserRuntimeRegistry.click(asProjectId(input.projectId), input.selector);
      return {};
    case "browser.hover":
      if (typeof input.selector !== "string" || input.selector.trim().length === 0) {
        throw new Error("selector must be a non-empty string.");
      }
      await browserRuntimeRegistry.hover(asProjectId(input.projectId), input.selector);
      return {};
    case "browser.fill":
      if (typeof input.selector !== "string" || typeof input.value !== "string") {
        throw new Error("selector and value must be strings.");
      }
      await browserRuntimeRegistry.fill(asProjectId(input.projectId), {
        selector: input.selector,
        value: input.value,
      });
      return {};
    case "browser.type_text":
      if (typeof input.selector !== "string" || typeof input.text !== "string") {
        throw new Error("selector and text must be strings.");
      }
      await browserRuntimeRegistry.typeText(asProjectId(input.projectId), {
        selector: input.selector,
        text: input.text,
      });
      return {};
    case "browser.press_key":
      if (typeof input.key !== "string" || input.key.trim().length === 0) {
        throw new Error("key must be a non-empty string.");
      }
      await browserRuntimeRegistry.pressKey(asProjectId(input.projectId), input.key);
      return {};
    case "browser.evaluate":
      if (typeof input.expression !== "string" || input.expression.trim().length === 0) {
        throw new Error("expression must be a non-empty string.");
      }
      return { value: await browserRuntimeRegistry.evaluate(asProjectId(input.projectId), input.expression) };
    default:
      throw new Error(`Unknown browser bridge method '${method}'.`);
  }
}

async function startBrowserBridgeServer(): Promise<void> {
  if (browserBridgeServer) {
    return;
  }
  browserBridgeAuthToken = Crypto.randomBytes(24).toString("hex");
  const createBridgeServer = () =>
    Http.createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/rpc") {
          response.writeHead(404).end();
          return;
        }
        if (request.headers["x-t3-browser-token"] !== browserBridgeAuthToken) {
          response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const body = await readRequestBody(request);
        const result = await handleBrowserBridgeRequest(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

  const MAX_BIND_ATTEMPTS = 12;
  let attempt = 0;
  while (attempt < MAX_BIND_ATTEMPTS) {
    attempt += 1;
    const server = createBridgeServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not resolve browser bridge server address.");
    }
    if (address.port === backendPort) {
      writeDesktopLogHeader(
        `browser bridge bind retry because selected port collides with backend port=${backendPort} attempt=${attempt}`,
      );
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      continue;
    }
    browserBridgeServer = server;
    browserBridgeUrl = `http://127.0.0.1:${address.port}/rpc`;
    server.unref();
    return;
  }

  throw new Error(
    `Failed to bind browser bridge server on a port distinct from backend port ${backendPort}.`,
  );
}

function stopBrowserBridgeServer(): void {
  if (!browserBridgeServer) {
    return;
  }
  browserBridgeServer.close();
  browserBridgeServer = null;
  browserBridgeUrl = "";
  browserBridgeAuthToken = "";
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  const writeChunk =
    (target: "stdout" | "stderr") =>
    (chunk: unknown): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (!app.isPackaged) {
      if (target === "stdout") {
        process.stdout.write(buffer);
      } else {
        process.stderr.write(buffer);
      }
    }
    backendLogSink?.write(buffer);
  };
  child.stdout?.on("data", writeChunk("stdout"));
  child.stderr?.on("data", writeChunk("stderr"));
}

initializePackagedLogging();
if (legacyStateImport.imported) {
  writeDesktopLogHeader(
    `imported legacy desktop state from ${legacyStateImport.sourceStateDir} to ${legacyStateImport.targetStateDir}`,
  );
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (EXPLICIT_DEV_ROOT) {
    return EXPLICIT_DEV_ROOT;
  }
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("A Code failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByBranding: !APP_DESKTOP_ENABLE_AUTO_UPDATES,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdates("menu");
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function resolveBrandPngPath(): string | null {
  const bundledIcon = resolveIconPath("png");
  if (bundledIcon) {
    return bundledIcon;
  }

  const repoAsset = Path.join(ROOT_DIR, "assets", "prod", "ACODE.png");
  return FS.existsSync(repoAsset) ? repoAsset : null;
}

function ensureWindowsToastShortcut(): void {
  if (process.platform !== "win32" || !app.isReady()) {
    return;
  }

  const shortcutPath = Path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APP_DISPLAY_NAME}.lnk`,
  );
  const shortcutDir = Path.dirname(shortcutPath);
  const targetPath = process.execPath;
  const iconPath = resolveIconPath("ico") ?? targetPath;
  const details = {
    target: targetPath,
    cwd: Path.dirname(targetPath),
    args: "",
    description: APP_DISPLAY_NAME,
    icon: iconPath,
    iconIndex: 0,
    appUserModelId: APP_DESKTOP_APP_ID,
    toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
  };

  try {
    FS.mkdirSync(shortcutDir, { recursive: true });
    const operation = FS.existsSync(shortcutPath) ? "update" : "create";
    const wroteShortcut = shell.writeShortcutLink(
      shortcutPath,
      operation,
      details,
    );
    if (!wroteShortcut) {
      console.warn(
        "[desktop-notifications] Failed to persist Windows toast shortcut metadata.",
        { shortcutPath, operation },
      );
    }
  } catch (error) {
    console.warn(
      "[desktop-notifications] Failed to ensure Windows toast shortcut metadata.",
      error,
    );
  }
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_DESKTOP_APP_ID);
    try {
      app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID);
    } catch (error) {
      console.warn("[desktop-notifications] Failed to set Toast Activator CLSID.", error);
    }
    ensureWindowsToastShortcut();
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveBrandPngPath();
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByBranding: !APP_DESKTOP_ENABLE_AUTO_UPDATES,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()));
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  clearUpdatePollTimer();
  try {
    await stopBackendAndWaitForExit();
    autoUpdater.quitAndInstall();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function buildWindowsToastActionString(
  input: DesktopNotificationPayload,
  action:
    | { action: "open_thread" }
    | { action: "approval_response"; decision: "accept" | "decline" }
    | { action: "user_input_response" },
): string {
  return encodeDesktopNotificationAction({
    action: action.action,
    notificationId: input.notificationId,
    threadId: input.threadId,
    projectId: input.projectId,
    ...(action.action === "approval_response" ? { decision: action.decision } : {}),
  });
}

function createWindowsToastOptions(input: DesktopNotificationPayload): Record<string, unknown> {
  const iconPath = resolveBrandPngPath() ?? undefined;
  const baseOptions: Record<string, unknown> = {
    aumid: APP_DESKTOP_APP_ID,
    uniqueID: input.notificationId,
    title: input.title,
    message: input.body,
    silent: input.silent,
    longTime: input.kind !== "turn_completed",
    keepalive: input.kind === "turn_completed" ? 120 : 600,
    ...(iconPath ? { icon: iconPath, cropIcon: true } : {}),
    activation: {
      type: "background",
      launch: buildWindowsToastActionString(input, { action: "open_thread" }),
    },
  };

  if (input.kind === "approval_required") {
    return {
      ...baseOptions,
      scenario: "reminder",
      button: [
        {
          text: "Approve",
          activation: {
            type: "background",
            launch: buildWindowsToastActionString(input, {
              action: "approval_response",
              decision: "accept",
            }),
          },
          style: "success",
        },
        {
          text: "Decline",
          activation: {
            type: "background",
            launch: buildWindowsToastActionString(input, {
              action: "approval_response",
              decision: "decline",
            }),
          },
          style: "critical",
        },
        {
          text: "Open thread",
          activation: {
            type: "background",
            launch: buildWindowsToastActionString(input, { action: "open_thread" }),
          },
        },
      ],
    };
  }

  if (input.kind === "user_input_required") {
    return {
      ...baseOptions,
      scenario: "reminder",
      select: input.questions.map((question) => ({
        id: question.id,
        title: `${question.header}: ${question.question}`,
        items: question.options.map((option, optionIndex) => ({
          id: option.id,
          text: option.label,
          ...(optionIndex === 0 ? { default: true } : {}),
        })),
      })),
      button: [
        {
          text: "Reply",
          activation: {
            type: "background",
            launch: buildWindowsToastActionString(input, { action: "user_input_response" }),
          },
        },
        {
          text: "Open thread",
          activation: {
            type: "background",
            launch: buildWindowsToastActionString(input, { action: "open_thread" }),
          },
        },
      ],
    };
  }

  return {
    ...baseOptions,
    button: [
      {
        text: "Open thread",
        activation: {
          type: "background",
          launch: buildWindowsToastActionString(input, { action: "open_thread" }),
        },
      },
    ],
  };
}

async function showWindowsRichNotification(input: DesktopNotificationPayload): Promise<boolean> {
  // In local dev, PowerToast falls back to a PowerShell bootstrap path that is
  // flaky on some Windows setups. Use Electron's built-in notification instead.
  if (process.platform !== "win32" || windowsRichToastDisabledForSession !== null || isDevelopment) {
    return false;
  }

  try {
    const previousAddedTime = readWindowsLastNotificationAddedTime(APP_DESKTOP_APP_ID);
    const { Toast } = await import("powertoast");
    const toast = new Toast(createWindowsToastOptions(input));
    toast.on("activated", (event: unknown, rawInput: unknown) => {
      if (typeof event !== "string" || event.trim().length === 0) {
        focusMainWindow();
        emitDesktopNotificationAction({
          kind: "open_thread",
          notificationId: input.notificationId,
          threadId: input.threadId,
          projectId: input.projectId,
        });
        return;
      }
      const notificationInput =
        rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
      handleWindowsToastActivation(input, event, notificationInput);
    });
    await toast.show(isDevelopment ? { disableWinRT: true } : undefined);
    await new Promise((resolve) => {
      setTimeout(resolve, 900);
    });
    const nextAddedTime = readWindowsLastNotificationAddedTime(APP_DESKTOP_APP_ID);
    const delivered =
      nextAddedTime !== null &&
      (previousAddedTime === null || nextAddedTime > previousAddedTime);
    if (!delivered) {
      console.warn(
        "[desktop-notifications] Windows rich toast was not recorded by the shell; falling back.",
        { notificationId: input.notificationId, kind: input.kind, previousAddedTime, nextAddedTime },
      );
    }
    return delivered;
  } catch (error) {
    const message = formatErrorMessage(error);
    if (
      /ERR_POWERSHELL|Install-Package|Microsoft\.Windows\.SDK\.NET\.Ref|No package found/i.test(
        message,
      )
    ) {
      windowsRichToastDisabledForSession = message;
      console.warn(
        "[desktop-notifications] Disabling Windows rich toasts for this app session after PowerShell failure.",
        { message },
      );
    }
    console.warn("[desktop-notifications] Windows rich toast failed; falling back.", error);
    return false;
  }
}

async function showElectronFallbackNotification(
  input: DesktopNotificationPayload,
): Promise<boolean> {
  const { Notification } = await import("electron");
  if (!Notification.isSupported()) {
    return false;
  }

  const fallback = buildDesktopNotificationFallbackInput(input);
  const notification = {
    title: fallback.title,
    body: fallback.body,
    ...(fallback.silent === true ? { silent: true } : {}),
    ...(fallback.action
      ? { actions: [{ type: "button" as const, text: fallback.action.label }] }
      : {}),
    ...getIconOption(),
  };

  try {
    const notif = new Notification(notification);
    notif.on("click", () => {
      focusMainWindow();
      emitDesktopNotificationAction({
        kind: "open_thread",
        notificationId: input.notificationId,
        threadId: input.threadId,
        projectId: input.projectId,
      });
    });
    notif.on("action", () => {
      focusMainWindow();
      emitDesktopNotificationAction({
        kind: "open_thread",
        notificationId: input.notificationId,
        threadId: input.threadId,
        projectId: input.projectId,
      });
    });
    notif.show();
    return true;
  } catch {
    return false;
  }
}

async function showDesktopNotification(input: DesktopNotificationPayload): Promise<boolean> {
  if (await showWindowsRichNotification(input)) {
    return true;
  }
  return showElectronFallbackNotification(input);
}

function configureAutoUpdater(): void {
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion()),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = app.getVersion().includes("-");
  let lastLoggedDownloadMilestone = -1;

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnUpdateAvailable(updateState, info.version, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function backendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(backendPort),
    T3CODE_STATE_DIR: STATE_DIR,
    T3CODE_DESKTOP_BROWSER_BRIDGE_URL: browserBridgeUrl,
    T3CODE_DESKTOP_BROWSER_BRIDGE_TOKEN: browserBridgeAuthToken,
  };
  // Always set T3CODE_AUTH_TOKEN explicitly so inherited shell env cannot
  // accidentally enable backend auth while desktop bridge WS URL has no token.
  env.T3CODE_AUTH_TOKEN = backendAuthToken;
  return env;
}

function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const child = ChildProcess.spawn(process.execPath, [backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

async function canConnectToBackendPort(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = new Net.Socket();
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(BACKEND_READY_SOCKET_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForBackendReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isQuitting) {
      return false;
    }
    if (await canConnectToBackendPort(port)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BACKEND_READY_POLL_INTERVAL_MS);
    });
  }
  return false;
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return false;
    }

    try {
      await shell.openExternal(parsedUrl.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(NOTIFICATIONS_IS_SUPPORTED_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_IS_SUPPORTED_CHANNEL, async () => {
    return true;
  });

  ipcMain.removeHandler(NOTIFICATIONS_SHOW_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_SHOW_CHANNEL, async (_event, rawInput: unknown) => {
    const input = parseDesktopNotificationPayload(rawInput);
    return showDesktopNotification(input);
  });

  ipcMain.removeHandler(NOTIFICATIONS_CONSUME_PENDING_ACTIONS_CHANNEL);
  ipcMain.handle(NOTIFICATIONS_CONSUME_PENDING_ACTIONS_CHANNEL, async () =>
    consumePendingDesktopNotificationActions(),
  );

  ipcMain.removeHandler(BROWSER_GET_STATE_CHANNEL);
  ipcMain.handle(BROWSER_GET_STATE_CHANNEL, async (_event, rawInput: unknown) =>
    browserRuntimeRegistry.getState(asProjectId(asRecord(rawInput).projectId)),
  );

  ipcMain.removeHandler(BROWSER_OPEN_CHANNEL);
  ipcMain.handle(BROWSER_OPEN_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    return browserRuntimeRegistry.open(asProjectId(input.projectId), asPaneBounds(input.bounds));
  });

  ipcMain.removeHandler(BROWSER_CLOSE_PANE_CHANNEL);
  ipcMain.handle(BROWSER_CLOSE_PANE_CHANNEL, async () => {
    await browserRuntimeRegistry.closePane();
  });

  ipcMain.removeHandler(BROWSER_NEW_TAB_CHANNEL);
  ipcMain.handle(BROWSER_NEW_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    return browserRuntimeRegistry.newTab(
      asProjectId(input.projectId),
      typeof input.url === "string" && input.url.trim().length > 0 ? input.url : undefined,
    );
  });

  ipcMain.removeHandler(BROWSER_ACTIVATE_TAB_CHANNEL);
  ipcMain.handle(BROWSER_ACTIVATE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    if (typeof input.tabId !== "string" || input.tabId.trim().length === 0) {
      throw new Error("tabId must be a non-empty string.");
    }
    return browserRuntimeRegistry.activateTab(asProjectId(input.projectId), input.tabId);
  });

  ipcMain.removeHandler(BROWSER_CLOSE_TAB_CHANNEL);
  ipcMain.handle(BROWSER_CLOSE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    if (typeof input.tabId !== "string" || input.tabId.trim().length === 0) {
      throw new Error("tabId must be a non-empty string.");
    }
    return browserRuntimeRegistry.closeTab(asProjectId(input.projectId), input.tabId);
  });

  ipcMain.removeHandler(BROWSER_NAVIGATE_CHANNEL);
  ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    if (typeof input.url !== "string" || input.url.trim().length === 0) {
      throw new Error("url must be a non-empty string.");
    }
    return browserRuntimeRegistry.navigate(asProjectId(input.projectId), input.url);
  });

  ipcMain.removeHandler(BROWSER_BACK_CHANNEL);
  ipcMain.handle(BROWSER_BACK_CHANNEL, async (_event, rawInput: unknown) =>
    browserRuntimeRegistry.back(asProjectId(asRecord(rawInput).projectId)),
  );

  ipcMain.removeHandler(BROWSER_FORWARD_CHANNEL);
  ipcMain.handle(BROWSER_FORWARD_CHANNEL, async (_event, rawInput: unknown) =>
    browserRuntimeRegistry.forward(asProjectId(asRecord(rawInput).projectId)),
  );

  ipcMain.removeHandler(BROWSER_RELOAD_CHANNEL);
  ipcMain.handle(BROWSER_RELOAD_CHANNEL, async (_event, rawInput: unknown) =>
    browserRuntimeRegistry.reload(asProjectId(asRecord(rawInput).projectId)),
  );

  ipcMain.removeHandler(BROWSER_KILL_CHANNEL);
  ipcMain.handle(BROWSER_KILL_CHANNEL, async (_event, rawInput: unknown) => {
    await browserRuntimeRegistry.kill(asProjectId(asRecord(rawInput).projectId));
  });

  ipcMain.removeHandler(BROWSER_GET_SETTINGS_CHANNEL);
  ipcMain.handle(BROWSER_GET_SETTINGS_CHANNEL, async () => browserRuntimeRegistry.getSettings());

  ipcMain.removeHandler(BROWSER_UPDATE_SETTINGS_CHANNEL);
  ipcMain.handle(BROWSER_UPDATE_SETTINGS_CHANNEL, async (_event, rawInput: unknown) =>
    browserRuntimeRegistry.updateSettings(asRecord(rawInput)),
  );

  ipcMain.removeHandler(BROWSER_CLEAR_BROWSING_DATA_CHANNEL);
  ipcMain.handle(BROWSER_CLEAR_BROWSING_DATA_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    await browserRuntimeRegistry.clearBrowsingData({
      kind:
        input.kind === "cookies" || input.kind === "cache" || input.kind === "siteData"
          ? input.kind
          : "all",
    });
  });

  ipcMain.removeHandler(BROWSER_SET_INSPECT_MODE_CHANNEL);
  ipcMain.handle(BROWSER_SET_INSPECT_MODE_CHANNEL, async (_event, rawInput: unknown) => {
    const input = asRecord(rawInput);
    return browserRuntimeRegistry.setInspectMode(
      asProjectId(input.projectId),
      input.enabled === true,
    );
  });

  ipcMain.removeHandler(BROWSER_CAPTURE_INSPECT_SELECTION_CHANNEL);
  ipcMain.handle(
    BROWSER_CAPTURE_INSPECT_SELECTION_CHANNEL,
    async (_event, rawInput: unknown): Promise<BrowserInspectCapture | null> =>
      browserRuntimeRegistry.captureInspectSelection(asProjectId(asRecord(rawInput).projectId)),
  );

  ipcMain.removeAllListeners(BROWSER_PAGE_EVENT_CHANNEL);
  ipcMain.on(BROWSER_PAGE_EVENT_CHANNEL, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") {
      return;
    }
    browserRuntimeRegistry.handlePageEventByWebContentsId(
      event.sender.id,
      rawPayload as { type: string; hasSelection?: unknown },
    );
  });
}

function getIconOption(): { icon: Electron.NativeImage } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses dock/app bundle icons
  const iconPath = resolveBrandPngPath();
  if (!iconPath) {
    return {};
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? {} : { icon };
}

function buildRendererContextMenuTemplate(
  params: Electron.ContextMenuParams,
): MenuItemConstructorOptions[] {
  const selectionText = params.selectionText.trim();
  const hasSelection = selectionText.length > 0;
  const canCopy = params.editFlags.canCopy || hasSelection;

  const template: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    if (params.editFlags.canCut) {
      template.push({ role: "cut" });
    }
    if (canCopy) {
      template.push({ role: "copy" });
    }
    if (params.editFlags.canPaste) {
      template.push({ role: "paste" });
    }
    if (params.editFlags.canDelete) {
      template.push({ role: "delete" });
    }
    if (params.editFlags.canSelectAll) {
      template.push({ role: "selectAll" });
    }
    return template;
  }

  if (canCopy) {
    template.push({ role: "copy" });
  }
  if (params.editFlags.canSelectAll) {
    template.push({ role: "selectAll" });
  }
  return template;
}

function createWindow(): BrowserWindow {
  const windowChromeMetrics = getDesktopWindowChromeMetrics(process.platform);
  const titleBarOverlay =
    process.platform === "darwin"
      ? false
      : {
          color: "#00000000",
          symbolColor: "#6b7280",
          height: windowChromeMetrics.titlebarHeightPx,
        };
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "hidden",
    titleBarOverlay,
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 76, y: 18 } } : {}),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
  });
  window.webContents.on("context-menu", (event, params) => {
    const template = buildRendererContextMenuTemplate(params);
    if (template.length === 0) {
      return;
    }
    event.preventDefault();
    Menu.buildFromTemplate(template).popup({ window });
  });
  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      browserRuntimeRegistry.setWindow(null);
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  browserRuntimeRegistry.setWindow(window);

  return window;
}

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  // Use T3CODE_PORT from environment if set (e.g., by dev-runner), otherwise reserve a random port
  const envPort = process.env.T3CODE_PORT;
  writeDesktopLogHeader(`bootstrap env T3CODE_PORT=${envPort ?? "not set"}`);
  if (envPort && /^\d+$/.test(envPort)) {
    backendPort = parseInt(envPort, 10);
    writeDesktopLogHeader(`using backend port from environment port=${backendPort}`);
  } else {
    backendPort = await Effect.service(NetService).pipe(
      Effect.flatMap((net) => net.reserveLoopbackPort()),
      Effect.provide(NetService.layer),
      Effect.runPromise,
    );
    writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  }
  // In dev mode (when T3CODE_PORT is set by dev-runner), don't use auth to allow Chrome debugging
  const isDevMode = envPort !== undefined;
  backendAuthToken = isDevMode ? "" : Crypto.randomBytes(24).toString("hex");
  const wsUrlQuery = backendAuthToken ? `?token=${encodeURIComponent(backendAuthToken)}` : "";
  backendWsUrl = `ws://127.0.0.1:${backendPort}/${wsUrlQuery}`;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;
  await startBrowserBridgeServer();
  writeDesktopLogHeader(`bootstrap resolved websocket url=${backendWsUrl}`);

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");
  const backendReady = await waitForBackendReady(backendPort, BACKEND_READY_TIMEOUT_MS);
  if (!backendReady) {
    writeDesktopLogHeader(
      `backend did not become ready within ${BACKEND_READY_TIMEOUT_MS}ms on port=${backendPort}; launching window anyway`,
    );
  } else {
    writeDesktopLogHeader(`backend is accepting connections on port=${backendPort}`);
  }
  mainWindow = createWindow();
  writeDesktopLogHeader("bootstrap main window created");
}

app.on("before-quit", () => {
  isQuitting = true;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  stopBrowserBridgeServer();
  stopBackend();
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    stopBrowserBridgeServer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBrowserBridgeServer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });
}
