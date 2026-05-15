// @ts-nocheck
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContextLike,
} from "./tool-contract.js";
import { ensurePermissions, type PermissionStatus } from "./permissions.js";

export interface ScreenshotParams {
  app?: string;
  launchId?: string;
  pid?: number;
  windowId?: number;
  windowTitle?: string;
}

export type MouseButton = "left" | "right" | "wheel" | "back" | "forward";

export interface ClickParams {
  x: number;
  y: number;
  button?: MouseButton;
  captureId?: string;
  allowGlobalInput?: boolean;
}

export interface DoubleClickParams {
  x: number;
  y: number;
  captureId?: string;
  allowGlobalInput?: boolean;
}

export interface MoveMouseParams {
  x: number;
  y: number;
  captureId?: string;
  allowGlobalInput?: boolean;
}

export interface DragParams {
  path: Array<{ x: number; y: number }>;
  captureId?: string;
  allowGlobalInput?: boolean;
}

export interface ScrollParams {
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
  captureId?: string;
  allowGlobalInput?: boolean;
}

export interface TypeTextParams {
  text: string;
  allowGlobalInput?: boolean;
}

export interface ListElementsParams {
  actionableOnly?: boolean;
  maxItems?: number;
  maxDepth?: number;
}

export interface GetVisibleTextParams {
  maxItems?: number;
  maxDepth?: number;
}

export type ActivateElementAction = "default" | "focus" | "invoke" | "select";

export interface ActivateElementParams {
  elementRef: string;
  action?: ActivateElementAction;
}

export interface KeypressParams {
  keys: string[];
  allowGlobalInput?: boolean;
}

export interface WaitParams {
  ms?: number;
}

export interface CurrentTarget {
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle: string;
  windowId: number;
}

export interface CurrentCapture {
  captureId: string;
  width: number;
  height: number;
  scaleFactor: number;
  timestamp: number;
}

interface ActivationFlags {
  activated: boolean;
  unminimized: boolean;
  raised: boolean;
}

export interface ComputerUseDetails {
  tool: string;
  session: {
    sessionId: string;
    inputMode: "semantic" | "virtual-cursor" | "global-input";
    fallbackRequired: boolean;
    appScoped: boolean;
  };
  target: {
    app: string;
    bundleId?: string;
    pid: number;
    windowTitle: string;
    windowId: number;
  };
  capture: {
    captureId: string;
    width: number;
    height: number;
    scaleFactor: number;
    timestamp: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
  activation: ActivationFlags;
  ghostCursor?: {
    x: number;
    y: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
}

export interface HelperApp {
  appName: string;
  bundleId?: string;
  pid: number;
  isFrontmost?: boolean;
}

interface FramePoints {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HelperWindow {
  windowId?: number;
  title: string;
  framePoints: FramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

interface FrontmostResult {
  appName: string;
  bundleId?: string;
  pid: number;
  windowTitle?: string;
  windowId?: number;
}

interface MousePositionResult {
  x: number;
  y: number;
}

interface ScreenshotPayload {
  pngBase64: string;
  width: number;
  height: number;
  scaleFactor: number;
}

interface FocusedElementResult {
  exists: boolean;
  elementRef?: string;
  role?: string;
  subrole?: string;
  isTextInput?: boolean;
  isSecure?: boolean;
  canSetValue?: boolean;
  value?: string;
  valueLength?: number;
}

interface AxPressAtPointResult {
  pressed: boolean;
  reason?: string;
}

interface NativeTextEntryResult {
  done: boolean;
  method?: string;
  verified?: boolean;
  reason?: string;
}

export interface SemanticElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: "window-relative-screenshot-pixels";
}

export interface SemanticElementInfo {
  elementRef: string;
  name: string;
  automationId: string;
  role: string;
  subrole: string;
  text: string;
  bounds: SemanticElementBounds;
  isTextInput: boolean;
  canSetValue: boolean;
  isKeyboardFocusable: boolean;
  supportsInvoke: boolean;
  supportsSelect: boolean;
  actionable: boolean;
  actionScore: number;
}

export interface VisibleTextItem {
  text: string;
  role: string;
  subrole: string;
  bounds: SemanticElementBounds;
}

interface SemanticWindowTargetInfo {
  app: string;
  bundleId?: string;
  pid: number;
  windowTitle: string;
  windowId: number;
}

export interface ListElementsDetails {
  tool: "list_elements";
  target: SemanticWindowTargetInfo;
  count: number;
  actionableOnly: boolean;
  elements: SemanticElementInfo[];
  session?: {
    sessionId: string;
    inputMode: "semantic" | "virtual-cursor" | "global-input";
    fallbackRequired: boolean;
    appScoped: boolean;
  };
  capture?: {
    captureId: string;
    width: number;
    height: number;
    scaleFactor: number;
    timestamp: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
}

export interface VisibleTextDetails {
  tool: "get_visible_text";
  target: SemanticWindowTargetInfo;
  count: number;
  text: string;
  items: VisibleTextItem[];
  session?: {
    sessionId: string;
    inputMode: "semantic" | "virtual-cursor" | "global-input";
    fallbackRequired: boolean;
    appScoped: boolean;
  };
  capture?: {
    captureId: string;
    width: number;
    height: number;
    scaleFactor: number;
    timestamp: number;
    coordinateSpace: "window-relative-screenshot-pixels";
  };
}

interface ResolvedTarget extends CurrentTarget {
  framePoints: FramePoints;
  scaleFactor: number;
  isMinimized: boolean;
  isOnscreen: boolean;
  isMain: boolean;
  isFocused: boolean;
}

interface PendingRequest {
  cmd: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

interface RuntimeState {
  currentTarget?: CurrentTarget;
  currentCapture?: CurrentCapture;
  currentSessionId?: string;
  ghostCursor?: MousePositionResult;
  sessionInputMode?: ComputerUseDetails["session"]["inputMode"];
  fallbackRequired: boolean;
  helper?: ChildProcessWithoutNullStreams;
  helperStdoutBuffer: string;
  helperStderrBuffer: string;
  pending: Map<string, PendingRequest>;
  requestSequence: number;
  queueTail: Promise<void>;
  permissionStatus?: PermissionStatus;
  lastPermissionCheckAt: number;
  helperInstallChecked: boolean;
}

const TOOL_NAMES = new Set([
  "launch_app",
  "screenshot",
  "observe_app",
  "attach_app",
  "focus_app",
  "move_window",
  "resize_window",
  "close_window",
  "active_window",
  "window_bounds",
  "click",
  "list_elements",
  "double_click",
  "move_mouse",
  "drag",
  "get_visible_text",
  "scroll",
  "type_text",
  "activate_element",
  "keypress",
  "wait",
]);

const MISSING_TARGET_ERROR =
  "No current controlled window. Call screenshot first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
  "The current controlled window is no longer available. Call screenshot to choose a new target window.";
const STALE_CAPTURE_ERROR =
  "The coordinates were based on an older screenshot. Call screenshot again to refresh the current window state.";
const PLATFORM_UNSUPPORTED_ERROR = "T3 Computer Use supports macOS and Windows only.";
const GLOBAL_INPUT_REQUIRED_ERROR =
  "This action would require global mouse or keyboard input and could interrupt the user. Ask the user for permission, then retry with allowGlobalInput: true.";

const COMMAND_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 25_000;
const ACTION_SETTLE_MS = 280;
const DEFAULT_WAIT_MS = 1_000;

const RECOVERABLE_SCREENSHOT_ERROR_CODES = new Set(["screenshot_timeout", "window_not_found"]);

const HELPER_FILE_NAME = process.platform === "win32" ? "bridge.exe" : "bridge";
const DEFAULT_T3_STATE_DIR = path.join(os.homedir(), ".t3", "dev");
const T3_STATE_DIR = process.env.T3CODE_STATE_DIR?.trim() || DEFAULT_T3_STATE_DIR;
const DESKTOP_BRIDGE_URL = process.env.T3CODE_DESKTOP_BROWSER_BRIDGE_URL?.trim() || "";
const DESKTOP_BRIDGE_TOKEN = process.env.T3CODE_DESKTOP_BROWSER_BRIDGE_TOKEN?.trim() || "";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const HELPER_STABLE_PATH =
  process.env.T3_COMPUTER_USE_HELPER_PATH?.trim() ||
  path.join(T3_STATE_DIR, "helpers", "t3-computer-use", HELPER_FILE_NAME);

function bundledHelperCandidates(): string[] {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const override = process.env.T3_COMPUTER_USE_BUNDLED_HELPER_PATH?.trim();
  return [
    ...(override ? [override] : []),
    path.join(PACKAGE_ROOT, "computer-use", "prebuilt", platform, arch, HELPER_FILE_NAME),
    path.join(PACKAGE_ROOT, "..", "computer-use", "prebuilt", platform, arch, HELPER_FILE_NAME),
    path.join(
      PACKAGE_ROOT,
      "..",
      "..",
      "computer-use",
      "prebuilt",
      platform,
      arch,
      HELPER_FILE_NAME,
    ),
  ];
}

const runtimeState: RuntimeState = {
  helperStdoutBuffer: "",
  helperStderrBuffer: "",
  pending: new Map(),
  requestSequence: 0,
  queueTail: Promise.resolve(),
  lastPermissionCheckAt: 0,
  helperInstallChecked: false,
  fallbackRequired: false,
};

class HelperTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperTransportError";
  }
}

class HelperCommandError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HelperCommandError";
    this.code = code;
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isRecoverableScreenshotError(error: unknown): error is HelperCommandError {
  return (
    error instanceof HelperCommandError &&
    !!error.code &&
    RECOVERABLE_SCREENSHOT_ERROR_CODES.has(error.code)
  );
}

function addRefreshHint(error: unknown): Error {
  const message = normalizeError(error).message;
  if (/call screenshot/i.test(message)) {
    return new Error(message);
  }
  return new Error(`${message} Call screenshot again to refresh the current window state.`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted.");
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Operation aborted."));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withRuntimeLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = runtimeState.queueTail;
  let release!: () => void;
  runtimeState.queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

function randomCaptureId(): string {
  try {
    return randomUUID();
  } catch {
    return `cap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function allowsGlobalInput(params: { allowGlobalInput?: boolean } | undefined): boolean {
  return params?.allowGlobalInput === true;
}

function requireGlobalInputAllowed(params: { allowGlobalInput?: boolean } | undefined): void {
  if (!allowsGlobalInput(params)) {
    runtimeState.fallbackRequired = true;
    throw new Error(GLOBAL_INPUT_REQUIRED_ERROR);
  }
  runtimeState.fallbackRequired = false;
}

function sessionIdForTarget(target: CurrentTarget): string {
  return [process.platform, target.bundleId ?? target.appName, target.pid, target.windowId]
    .map((part) => String(part).replace(/[^a-zA-Z0-9._-]+/g, "-"))
    .join(":");
}

function ensurePointIsInCapture(
  x: number,
  y: number,
  capture: CurrentCapture,
  errorPrefix = "Coordinates",
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${errorPrefix} must be finite numbers.`);
  }
  if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) {
    throw new Error(
      `${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest screenshot bounds (${capture.width}x${capture.height}). Call screenshot again and retry.`,
    );
  }
}

function updateGhostCursor(position: MousePositionResult): void {
  runtimeState.ghostCursor = {
    x: Math.max(0, Math.round(position.x)),
    y: Math.max(0, Math.round(position.y)),
  };
  runtimeState.sessionInputMode = "virtual-cursor";
  runtimeState.fallbackRequired = false;
}

function validateCaptureId(captureId?: string): CurrentCapture {
  if (!runtimeState.currentTarget || !runtimeState.currentCapture) {
    throw new Error(MISSING_TARGET_ERROR);
  }
  if (captureId && runtimeState.currentCapture.captureId !== captureId) {
    throw new Error(STALE_CAPTURE_ERROR);
  }
  return runtimeState.currentCapture;
}

function currentTargetOrThrow(): CurrentTarget {
  if (!runtimeState.currentTarget) {
    throw new Error(MISSING_TARGET_ERROR);
  }
  return runtimeState.currentTarget;
}

function emptyActivation(): ActivationFlags {
  return { activated: false, unminimized: false, raised: false };
}

function rejectAllPending(error: Error): void {
  for (const [id, pending] of runtimeState.pending) {
    clearTimeout(pending.timer);
    if (pending.abortListener) {
      pending.abortListener();
    }
    runtimeState.pending.delete(id);
    pending.reject(error);
  }
}

function handleHelperStdoutChunk(chunk: string): void {
  runtimeState.helperStdoutBuffer += chunk;

  while (true) {
    const newlineIndex = runtimeState.helperStdoutBuffer.indexOf("\n");
    if (newlineIndex < 0) break;

    const line = runtimeState.helperStdoutBuffer.slice(0, newlineIndex).trim();
    runtimeState.helperStdoutBuffer = runtimeState.helperStdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const id = typeof parsed?.id === "string" ? parsed.id : undefined;
    if (!id) continue;

    const pending = runtimeState.pending.get(id);
    if (!pending) continue;
    runtimeState.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abortListener) pending.abortListener();

    if (parsed.ok === true) {
      pending.resolve(parsed.result);
    } else {
      const message =
        typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : `Helper command '${pending.cmd}' failed.`;
      const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
      pending.reject(new HelperCommandError(message, code));
    }
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // Try the next bundled helper location.
    }
  }
  return undefined;
}

async function ensureHelperInstalled(signal?: AbortSignal): Promise<void> {
  const helperAlreadyPresent = await isExecutable(HELPER_STABLE_PATH);
  if (helperAlreadyPresent && runtimeState.helperInstallChecked) {
    return;
  }

  throwIfAborted(signal);
  if (!helperAlreadyPresent) {
    const candidates = bundledHelperCandidates();
    const source = await firstExistingPath(candidates);
    if (!source) {
      throw new Error(
        `T3 Computer Use helper is not bundled for ${process.platform}/${process.arch}. Checked: ${candidates.join(", ")}`,
      );
    }
    await mkdir(path.dirname(HELPER_STABLE_PATH), { recursive: true });
    await copyFile(source, HELPER_STABLE_PATH);
  }
  runtimeState.helperInstallChecked = true;

  if (!(await isExecutable(HELPER_STABLE_PATH))) {
    throw new Error(`Failed to install T3 Computer Use helper at ${HELPER_STABLE_PATH}.`);
  }
}

async function startBridgeProcess(): Promise<ChildProcessWithoutNullStreams> {
  if (!(await isExecutable(HELPER_STABLE_PATH))) {
    throw new HelperTransportError(`Computer-use helper is missing at ${HELPER_STABLE_PATH}.`);
  }

  const child = spawn(HELPER_STABLE_PATH, [], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.setDefaultEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    handleHelperStdoutChunk(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    runtimeState.helperStderrBuffer = `${runtimeState.helperStderrBuffer}${chunk}`.slice(-4_000);
  });

  child.on("error", (error) => {
    if (runtimeState.helper === child) {
      runtimeState.helper = undefined;
    }
    rejectAllPending(new HelperTransportError(`Computer-use helper crashed: ${error.message}`));
  });

  child.on("exit", (code, sig) => {
    if (runtimeState.helper === child) {
      runtimeState.helper = undefined;
    }
    const diagnostics = runtimeState.helperStderrBuffer.trim();
    const reason = sig ? `signal ${sig}` : `exit code ${code ?? "unknown"}`;
    const suffix = diagnostics ? `: ${diagnostics}` : "";
    rejectAllPending(new HelperTransportError(`Computer-use helper exited (${reason})${suffix}.`));
  });

  runtimeState.helper = child;
  runtimeState.helperStdoutBuffer = "";
  runtimeState.helperStderrBuffer = "";
  return child;
}

async function ensureBridgeProcess(): Promise<ChildProcessWithoutNullStreams> {
  if (runtimeState.helper && runtimeState.helper.exitCode === null && !runtimeState.helper.killed) {
    return runtimeState.helper;
  }
  return await startBridgeProcess();
}

async function bridgeCommand<T>(
  cmd: string,
  args: Record<string, unknown> = {},
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(options?.signal);
    const helper = await ensureBridgeProcess();
    const id = `req_${++runtimeState.requestSequence}`;

    try {
      const result = await new Promise<T>((resolve, reject) => {
        const payload = `${JSON.stringify({ id, cmd, ...args })}\n`;
        const timer = setTimeout(() => {
          runtimeState.pending.delete(id);
          reject(
            new HelperTransportError(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`),
          );
        }, timeoutMs);

        const pending: PendingRequest = {
          cmd,
          resolve,
          reject,
          timer,
        };

        const abortListener = () => {
          if (runtimeState.pending.delete(id)) {
            clearTimeout(timer);
            reject(new Error("Operation aborted."));
          }
        };

        if (options?.signal) {
          options.signal.addEventListener("abort", abortListener, { once: true });
          pending.abortListener = () => options.signal?.removeEventListener("abort", abortListener);
        }

        runtimeState.pending.set(id, pending);

        helper.stdin.write(payload, (error) => {
          if (!error) return;
          const p = runtimeState.pending.get(id);
          if (!p) return;
          runtimeState.pending.delete(id);
          clearTimeout(p.timer);
          if (p.abortListener) p.abortListener();
          reject(new HelperTransportError(`Failed to send command '${cmd}': ${error.message}`));
        });
      });

      return result;
    } catch (error) {
      if (error instanceof HelperTransportError && attempt === 0) {
        stopBridge();
        continue;
      }
      throw normalizeError(error);
    }
  }

  throw new Error(`Helper command '${cmd}' failed.`);
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
  const result = await bridgeCommand<any>("checkPermissions", {}, { signal });
  return {
    accessibility: toBoolean(result?.accessibility),
    screenRecording: toBoolean(result?.screenRecording),
  };
}

async function ensureReady(ctx: ExtensionContextLike, signal?: AbortSignal): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(PLATFORM_UNSUPPORTED_ERROR);
  }

  throwIfAborted(signal);
  await ensureHelperInstalled(signal);
  await ensureBridgeProcess();

  const now = Date.now();
  const canUseCachedPermissions =
    runtimeState.permissionStatus &&
    runtimeState.permissionStatus.accessibility &&
    runtimeState.permissionStatus.screenRecording &&
    now - runtimeState.lastPermissionCheckAt < 2_000;
  if (canUseCachedPermissions) {
    return;
  }

  let status = await checkPermissions(signal);
  runtimeState.permissionStatus = status;
  runtimeState.lastPermissionCheckAt = now;

  if (!status.accessibility || !status.screenRecording) {
    status = await ensurePermissions(
      ctx,
      {
        checkPermissions: (permissionSignal) => checkPermissions(permissionSignal ?? signal),
        openPermissionPane: async (kind, permissionSignal) => {
          await bridgeCommand(
            "openPermissionPane",
            { kind },
            { signal: permissionSignal ?? signal },
          );
        },
      },
      HELPER_STABLE_PATH,
      signal,
    );
  }

  runtimeState.permissionStatus = status;
  runtimeState.lastPermissionCheckAt = Date.now();
}

function parseApps(result: unknown): HelperApp[] {
  const array = Array.isArray(result) ? result : (result as any)?.apps;
  if (!Array.isArray(array)) return [];

  return array
    .map((raw) => {
      const pid = Math.trunc(toFiniteNumber((raw as any)?.pid, NaN));
      if (!Number.isFinite(pid) || pid <= 0) return undefined;
      const appName = toOptionalString((raw as any)?.appName) ?? "Unknown App";
      return {
        appName,
        bundleId: toOptionalString((raw as any)?.bundleId),
        pid,
        isFrontmost: toBoolean((raw as any)?.isFrontmost),
      } as HelperApp;
    })
    .filter((item): item is HelperApp => Boolean(item));
}

function parseFramePoints(raw: unknown): FramePoints {
  const frame = (raw as any)?.framePoints ?? {};
  return {
    x: toFiniteNumber(frame.x, 0),
    y: toFiniteNumber(frame.y, 0),
    w: Math.max(1, toFiniteNumber(frame.w, 1)),
    h: Math.max(1, toFiniteNumber(frame.h, 1)),
  };
}

function parseWindows(result: unknown): HelperWindow[] {
  const array = Array.isArray(result) ? result : (result as any)?.windows;
  if (!Array.isArray(array)) return [];

  return array.map((raw) => ({
    windowId: Number.isFinite((raw as any)?.windowId)
      ? Math.trunc((raw as any).windowId)
      : undefined,
    title: toOptionalString((raw as any)?.title) ?? "",
    framePoints: parseFramePoints(raw),
    scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
    isMinimized: toBoolean((raw as any)?.isMinimized),
    isOnscreen: toBoolean((raw as any)?.isOnscreen),
    isMain: toBoolean((raw as any)?.isMain),
    isFocused: toBoolean((raw as any)?.isFocused),
  }));
}

async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
  const result = await bridgeCommand<unknown>("listApps", {}, { signal });
  return parseApps(result);
}

async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
  const result = await bridgeCommand<unknown>("listWindows", { pid }, { signal });
  return parseWindows(result);
}

async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
  const result = await bridgeCommand<any>("getFrontmost", {}, { signal });
  const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error("No frontmost app was available for screenshot targeting.");
  }

  return {
    appName: toOptionalString(result?.appName) ?? "Unknown App",
    bundleId: toOptionalString(result?.bundleId),
    pid,
    windowTitle: toOptionalString(result?.windowTitle),
    windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
  };
}

function choosePreferredWindow(windows: HelperWindow[], appName: string): HelperWindow {
  if (!windows.length) {
    throw new Error(`No controllable window was found in app '${appName}'.`);
  }

  const scored = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
  return scored[0];
}

function scoreWindow(window: HelperWindow): number {
  let score = 0;
  if (window.isFocused) score += 100;
  if (window.isMain) score += 80;
  if (!window.isMinimized) score += 40;
  if (window.isOnscreen) score += 20;
  if (window.windowId && window.windowId > 0) score += 10;
  if (window.title.trim().length > 0) score += 2;
  return score;
}

function chooseAppByQuery(apps: HelperApp[], appQuery: string): HelperApp {
  const query = normalizeText(appQuery);
  const exactMatches = apps.filter((app) => normalizeText(app.appName) === query);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    return exactMatches.find((app) => app.isFrontmost) ?? exactMatches[0];
  }

  const partialMatches = apps.filter((app) => normalizeText(app.appName).includes(query));
  if (partialMatches.length === 0) {
    throw new Error(`App '${appQuery}' is not running.`);
  }
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  const candidates = partialMatches.map((app) => app.appName).join(", ");
  throw new Error(
    `App name '${appQuery}' is ambiguous (${candidates}). Use a more specific app name.`,
  );
}

function chooseWindowByTitle(
  windows: HelperWindow[],
  windowTitle: string,
  appName: string,
): HelperWindow {
  const query = normalizeText(windowTitle);
  const exactMatches = windows.filter((window) => normalizeText(window.title) === query);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const candidates = exactMatches.map((window) => window.title || "(untitled)").join(", ");
    throw new Error(
      `Window title '${windowTitle}' is ambiguous in app '${appName}' (${candidates}).`,
    );
  }

  const partialMatches = windows.filter((window) => normalizeText(window.title).includes(query));
  if (partialMatches.length === 0) {
    throw new Error(`Window '${windowTitle}' was not found in app '${appName}'.`);
  }
  if (partialMatches.length === 1) return partialMatches[0];

  const candidates = partialMatches.map((window) => window.title || "(untitled)").join(", ");
  throw new Error(
    `Window title '${windowTitle}' is ambiguous in app '${appName}' (${candidates}).`,
  );
}

function chooseAppByLaunchId(apps: HelperApp[], launchId: string): HelperApp | undefined {
  const query = normalizeText(launchId);
  if (!query) return undefined;

  const candidates = apps.filter((app) => {
    const appBundle = normalizeText(app.bundleId);
    const appName = normalizeText(app.appName);
    return (
      (appBundle.length > 0 && (appBundle.includes(query) || query.includes(appBundle))) ||
      (appName.length > 0 && (appName.includes(query) || query.includes(appName)))
    );
  });

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((app) => app.isFrontmost) ?? candidates[0];
}

function toResolvedTarget(app: HelperApp, window: HelperWindow): ResolvedTarget {
  return {
    appName: app.appName,
    bundleId: app.bundleId,
    pid: app.pid,
    windowTitle: window.title || "(untitled)",
    windowId: typeof window.windowId === "number" ? window.windowId : 0,
    framePoints: window.framePoints,
    scaleFactor: window.scaleFactor,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    isFocused: window.isFocused,
  };
}

function setCurrentTarget(target: ResolvedTarget): void {
  runtimeState.currentTarget = {
    appName: target.appName,
    bundleId: target.bundleId,
    pid: target.pid,
    windowTitle: target.windowTitle,
    windowId: target.windowId,
  };
  runtimeState.currentSessionId = sessionIdForTarget(runtimeState.currentTarget);
  runtimeState.sessionInputMode ??= "semantic";
}

async function resolveCurrentTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
  const current = currentTargetOrThrow();
  const windows = await listWindows(current.pid, signal);
  if (!windows.length) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }

  let match = windows.find(
    (window) => window.windowId !== undefined && window.windowId === current.windowId,
  );
  if (!match) {
    const titleQuery = normalizeText(current.windowTitle);
    const exactTitleMatches = windows.filter(
      (window) => normalizeText(window.title) === titleQuery,
    );
    if (exactTitleMatches.length === 1) {
      match = exactTitleMatches[0];
    }
  }

  if (!match) {
    match =
      windows.find((window) => window.isFocused) ??
      windows.find((window) => window.isMain) ??
      windows[0];
  }

  if (!match) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }

  const app: HelperApp = {
    appName: current.appName,
    bundleId: current.bundleId,
    pid: current.pid,
  };

  const resolved = toResolvedTarget(app, match);
  setCurrentTarget(resolved);
  return resolved;
}

async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
  const frontmost = await getFrontmost(signal);
  const apps = await listApps(signal);
  const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
    appName: frontmost.appName,
    bundleId: frontmost.bundleId,
    pid: frontmost.pid,
  };

  const windows = await listWindows(frontmost.pid, signal);
  if (!windows.length) {
    throw new Error(
      "No frontmost controllable window was found. Open an app window and call screenshot again.",
    );
  }

  let selected = windows.find(
    (window) => window.windowId !== undefined && window.windowId === frontmost.windowId,
  );
  if (!selected && frontmost.windowTitle) {
    selected = windows.find(
      (window) => normalizeText(window.title) === normalizeText(frontmost.windowTitle),
    );
  }
  selected ??= choosePreferredWindow(windows, app.appName);

  const resolved = toResolvedTarget(app, selected);
  setCurrentTarget(resolved);
  return resolved;
}

async function resolveTargetForScreenshot(
  selection: ScreenshotParams,
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  const appQuery = trimOrUndefined(selection.app);
  const launchId = trimOrUndefined(selection.launchId);
  const windowTitleQuery = trimOrUndefined(selection.windowTitle);
  const pidQueryRaw =
    typeof selection.pid === "number" && Number.isFinite(selection.pid) ? Math.trunc(selection.pid) : NaN;
  const windowIdQueryRaw =
    typeof selection.windowId === "number" && Number.isFinite(selection.windowId)
      ? Math.trunc(selection.windowId)
      : NaN;
  const pidQuery = pidQueryRaw > 0 ? pidQueryRaw : undefined;
  const windowIdQuery = windowIdQueryRaw > 0 ? windowIdQueryRaw : undefined;

  if (pidQuery) {
    const apps = await listApps(signal);
    const appFromPid = apps.find((candidate) => candidate.pid === pidQuery);
    const app = appFromPid ?? {
      appName: appQuery ?? runtimeState.currentTarget?.appName ?? "Unknown App",
      pid: pidQuery,
    };
    const windows = await listWindows(pidQuery, signal);
    if (!windows.length) {
      throw new Error(`No controllable window was found for pid '${pidQuery}'.`);
    }

    const preferredByWindowId =
      windowIdQuery !== undefined
        ? windows.find((window) => window.windowId !== undefined && window.windowId === windowIdQuery)
        : undefined;
    if (preferredByWindowId) {
      const resolved = toResolvedTarget(app, preferredByWindowId);
      setCurrentTarget(resolved);
      return resolved;
    }

    if (windowTitleQuery) {
      const preferredByTitle = chooseWindowByTitle(windows, windowTitleQuery, app.appName);
      const resolved = toResolvedTarget(app, preferredByTitle);
      setCurrentTarget(resolved);
      return resolved;
    }

    const preferredWindow = choosePreferredWindow(windows, app.appName);
    const resolved = toResolvedTarget(app, preferredWindow);
    setCurrentTarget(resolved);
    return resolved;
  }

  if (!appQuery && !windowTitleQuery) {
    if (launchId) {
      const apps = await listApps(signal);
      const app = chooseAppByLaunchId(apps, launchId);
      if (app) {
        const windows = await listWindows(app.pid, signal);
        if (windows.length) {
          const preferredWindow = choosePreferredWindow(windows, app.appName);
          const resolved = toResolvedTarget(app, preferredWindow);
          setCurrentTarget(resolved);
          return resolved;
        }
      }
    }
    if (runtimeState.currentTarget) {
      return await resolveCurrentTarget(signal);
    }
    return await resolveFrontmostTarget(signal);
  }

  const apps = await listApps(signal);

  if (appQuery) {
    const app = launchId
      ? chooseAppByLaunchId(apps, launchId) ?? chooseAppByQuery(apps, appQuery)
      : chooseAppByQuery(apps, appQuery);
    const windows = await listWindows(app.pid, signal);
    if (!windows.length) {
      throw new Error(`No controllable window was found in app '${app.appName}'.`);
    }

    const window = windowTitleQuery
      ? chooseWindowByTitle(windows, windowTitleQuery, app.appName)
      : choosePreferredWindow(windows, app.appName);

    const resolved = toResolvedTarget(app, window);
    setCurrentTarget(resolved);
    return resolved;
  }

  const query = windowTitleQuery!;
  if (launchId) {
    const app = chooseAppByLaunchId(apps, launchId);
    if (!app) {
      throw new Error(`No running app matched launchId '${launchId}'.`);
    }
    const windows = await listWindows(app.pid, signal);
    if (!windows.length) {
      throw new Error(`No controllable window was found for launchId '${launchId}'.`);
    }

    const window = chooseWindowByTitle(windows, query, app.appName);
    const resolved = toResolvedTarget(app, window);
    setCurrentTarget(resolved);
    return resolved;
  }

  const exactMatches: Array<{ app: HelperApp; window: HelperWindow }> = [];
  const partialMatches: Array<{ app: HelperApp; window: HelperWindow }> = [];

  for (const app of apps) {
    const windows = await listWindows(app.pid, signal);
    for (const window of windows) {
      const title = normalizeText(window.title);
      if (!title) continue;
      if (title === normalizeText(query)) {
        exactMatches.push({ app, window });
      } else if (title.includes(normalizeText(query))) {
        partialMatches.push({ app, window });
      }
    }
  }

  const matches = exactMatches.length > 0 ? exactMatches : partialMatches;
  if (matches.length === 0) {
    throw new Error(`Window '${query}' was not found in any running app.`);
  }
  if (matches.length > 1) {
    const options = matches
      .slice(0, 6)
      .map((match) => `${match.app.appName} — ${match.window.title || "(untitled)"}`)
      .join(", ");
    throw new Error(`Window title '${query}' is ambiguous (${options}). Specify app as well.`);
  }

  const resolved = toResolvedTarget(matches[0].app, matches[0].window);
  setCurrentTarget(resolved);
  return resolved;
}

async function ensureTargetWindowId(
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  if (target.windowId > 0) {
    return target;
  }

  const refreshed = await resolveCurrentTarget(signal);
  if (refreshed.windowId <= 0) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }
  return refreshed;
}

async function helperScreenshot(
  windowId: number,
  signal?: AbortSignal,
): Promise<ScreenshotPayload> {
  const result = await bridgeCommand<any>(
    "screenshot",
    { windowId },
    { timeoutMs: SCREENSHOT_TIMEOUT_MS, signal },
  );

  const base64 = toOptionalString(result?.pngBase64);
  if (!base64) {
    throw new Error("Helper returned an invalid screenshot payload.");
  }

  return {
    pngBase64: base64,
    width: Math.max(1, Math.trunc(toFiniteNumber(result?.width, 1))),
    height: Math.max(1, Math.trunc(toFiniteNumber(result?.height, 1))),
    scaleFactor: Math.max(1, toFiniteNumber(result?.scaleFactor, 1)),
  };
}

function windowsByCaptureRecoveryPriority(
  windows: HelperWindow[],
  target: ResolvedTarget,
  failureCode: string,
): HelperWindow[] {
  const sorted = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
  if (failureCode !== "screenshot_timeout") {
    return sorted;
  }

  const alternatives = sorted.filter((window) => window.windowId !== target.windowId);
  const original = sorted.filter((window) => window.windowId === target.windowId);
  return [...alternatives, ...original];
}

async function recoverCaptureFromHelperFailure(
  target: ResolvedTarget,
  error: HelperCommandError,
  signal?: AbortSignal,
): Promise<{ target: ResolvedTarget; image: ScreenshotPayload }> {
  const windows = await listWindows(target.pid, signal);
  if (!windows.length) {
    throw new Error(CURRENT_TARGET_GONE_ERROR);
  }

  const app: HelperApp = {
    appName: target.appName,
    bundleId: target.bundleId,
    pid: target.pid,
  };

  const orderedWindows = windowsByCaptureRecoveryPriority(windows, target, error.code ?? "");
  const candidates = orderedWindows
    .filter((window) => typeof window.windowId === "number" && window.windowId > 0)
    .slice(0, 3);
  if (!candidates.length) {
    throw normalizeError(error);
  }

  let lastError: Error = normalizeError(error);
  for (const candidateWindow of candidates) {
    const candidateTarget = toResolvedTarget(app, candidateWindow);
    try {
      const image = await helperScreenshot(candidateTarget.windowId, signal);
      return { target: candidateTarget, image };
    } catch (candidateError) {
      if (!isRecoverableScreenshotError(candidateError)) {
        throw normalizeError(candidateError);
      }
      lastError = normalizeError(candidateError);
    }
  }

  throw lastError;
}

interface CaptureResult {
  target: ResolvedTarget;
  capture: CurrentCapture;
  image: ScreenshotPayload;
  activation: ActivationFlags;
}

async function callDesktopBridge(method: string, params: Record<string, unknown>): Promise<void> {
  if (!DESKTOP_BRIDGE_URL || !DESKTOP_BRIDGE_TOKEN) {
    return;
  }

  await fetch(DESKTOP_BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-t3-browser-token": DESKTOP_BRIDGE_TOKEN,
    },
    body: JSON.stringify({ method, params }),
  }).catch(() => undefined);
}

function overlayCursorPosition(
  result: CaptureResult,
  ghostCursor: MousePositionResult | undefined,
): { x: number; y: number; visible?: boolean; intent?: "move" | "click" } | undefined {
  if (!ghostCursor) {
    return undefined;
  }

  return {
    x: ghostCursor.x / result.capture.scaleFactor,
    y: ghostCursor.y / result.capture.scaleFactor,
  };
}

function overlayLabel(tool: string, result: CaptureResult): string {
  return `${tool.replaceAll("_", " ")} • ${result.target.appName} — ${result.target.windowTitle}`;
}

function publishDesktopOverlay(
  tool: string,
  result: CaptureResult,
  ghostCursor: MousePositionResult | undefined,
): void {
  void callDesktopBridge("computer.show_overlay", {
    bounds: {
      x: result.target.framePoints.x,
      y: result.target.framePoints.y,
      width: result.target.framePoints.w,
      height: result.target.framePoints.h,
    },
    cursor: overlayCursorPosition(result, ghostCursor)
      ? {
          ...overlayCursorPosition(result, ghostCursor),
          visible: true,
          intent: tool === "click" || tool === "double_click" ? "click" : "move",
        }
      : { visible: false },
    label: overlayLabel(tool, result),
  });
}

async function captureCurrentTarget(
  signal?: AbortSignal,
  priorActivation = emptyActivation(),
): Promise<CaptureResult> {
  let target = await resolveCurrentTarget(signal);
  let activation = { ...priorActivation };

  target = await ensureTargetWindowId(target, signal);

  let screenshot: ScreenshotPayload;
  try {
    screenshot = await helperScreenshot(target.windowId, signal);
  } catch (error) {
    if (!isRecoverableScreenshotError(error)) {
      throw normalizeError(error);
    }

    const recovered = await recoverCaptureFromHelperFailure(target, error, signal);
    target = recovered.target;
    screenshot = recovered.image;
  }

  const capture: CurrentCapture = {
    captureId: randomCaptureId(),
    width: screenshot.width,
    height: screenshot.height,
    scaleFactor: screenshot.scaleFactor,
    timestamp: Date.now(),
  };

  setCurrentTarget(target);
  runtimeState.currentCapture = capture;

  return {
    target,
    capture,
    image: screenshot,
    activation,
  };
}

function buildToolResult(
  tool: string,
  summary: string,
  result: CaptureResult,
): AgentToolResult<ComputerUseDetails> {
  publishDesktopOverlay(tool, result, runtimeState.ghostCursor);
  const details: ComputerUseDetails = {
    tool,
    session: {
      sessionId: runtimeState.currentSessionId ?? sessionIdForTarget(result.target),
      inputMode: runtimeState.sessionInputMode ?? "semantic",
      fallbackRequired: runtimeState.fallbackRequired,
      appScoped: true,
    },
    target: {
      app: result.target.appName,
      bundleId: result.target.bundleId,
      pid: result.target.pid,
      windowTitle: result.target.windowTitle,
      windowId: result.target.windowId,
    },
    capture: {
      captureId: result.capture.captureId,
      width: result.capture.width,
      height: result.capture.height,
      scaleFactor: result.capture.scaleFactor,
      timestamp: result.capture.timestamp,
      coordinateSpace: "window-relative-screenshot-pixels",
    },
    activation: result.activation,
    ghostCursor: runtimeState.ghostCursor
      ? {
          x: runtimeState.ghostCursor.x,
          y: runtimeState.ghostCursor.y,
          coordinateSpace: "window-relative-screenshot-pixels",
        }
      : undefined,
  };
  runtimeState.fallbackRequired = false;

  return {
    content: [
      { type: "text", text: summary },
      { type: "image", data: result.image.pngBase64, mimeType: "image/png" },
    ],
    details,
  };
}

function buildSemanticTargetInfo(target: ResolvedTarget): SemanticWindowTargetInfo {
  return {
    app: target.appName,
    bundleId: target.bundleId,
    pid: target.pid,
    windowTitle: target.windowTitle,
    windowId: target.windowId,
  };
}

function currentSessionStateForRuntime(): ComputerUseDetails["session"] | null {
  if (!runtimeState.currentTarget || !runtimeState.currentSessionId) {
    return null;
  }
  return {
    sessionId: runtimeState.currentSessionId,
    inputMode: runtimeState.sessionInputMode ?? "semantic",
    fallbackRequired: runtimeState.fallbackRequired,
    appScoped: true,
  };
}

function currentCaptureStateForRuntime(): Pick<
  ComputerUseDetails["capture"],
  "captureId" | "width" | "height" | "scaleFactor" | "timestamp" | "coordinateSpace"
> | null {
  if (!runtimeState.currentCapture) {
    return null;
  }
  return {
    captureId: runtimeState.currentCapture.captureId,
    width: runtimeState.currentCapture.width,
    height: runtimeState.currentCapture.height,
    scaleFactor: runtimeState.currentCapture.scaleFactor,
    timestamp: runtimeState.currentCapture.timestamp,
    coordinateSpace: "window-relative-screenshot-pixels",
  };
}

function summarizeElements(elements: SemanticElementInfo[], actionableOnly: boolean): string {
  if (!elements.length) {
    return actionableOnly
      ? "No actionable semantic elements were found in the current controlled window."
      : "No semantic elements were found in the current controlled window.";
  }

  const lines = elements.slice(0, 20).map((element) => {
    const label = element.name || element.text || element.role || "element";
    return `- ${element.elementRef}: ${label} (${element.role}) @ ${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height} score=${element.actionScore}`;
  });

  if (elements.length > 20) {
    lines.push(`- ... ${elements.length - 20} more elements omitted`);
  }

  return `Found ${elements.length} semantic elements in the current controlled window.\n${lines.join("\n")}`;
}

function summarizeVisibleText(text: string, count: number): string {
  if (count <= 0 || !text.trim()) {
    return "No visible text was extracted from the current controlled window.";
  }

  const normalized = text.trim();
  const preview = normalized.length > 1200 ? `${normalized.slice(0, 1197)}...` : normalized;
  return `Extracted ${count} visible text items from the current controlled window.\n${preview}`;
}

async function runCoordinateAction(
  tool: string,
  capture: CurrentCapture,
  signal: AbortSignal | undefined,
  dispatch: (target: ResolvedTarget) => Promise<void>,
  summaryFactory: (target: ResolvedTarget) => string,
  ghostCursor?: MousePositionResult,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const currentTarget = await resolveCurrentTarget(signal);
  let activation = emptyActivation();
  let stateMayHaveChanged = false;

  try {
    const readyTarget = await ensureTargetWindowId(currentTarget, signal);
    if (ghostCursor) {
      updateGhostCursor(ghostCursor);
    }
    await dispatch(readyTarget);
    stateMayHaveChanged = true;

    await sleep(ACTION_SETTLE_MS, signal);
    const captureResult = await captureCurrentTarget(signal, activation);
    return buildToolResult(tool, summaryFactory(captureResult.target), captureResult);
  } catch (error) {
    if (stateMayHaveChanged) {
      throw addRefreshHint(error);
    }
    throw normalizeError(error);
  }
}

async function performScreenshot(
  params: ScreenshotParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const selection = {
    pid: Math.trunc(toFiniteNumber(params.pid, Number.NaN)),
    windowId: Math.trunc(toFiniteNumber(params.windowId, Number.NaN)),
    app: trimOrUndefined(params.app),
    launchId: trimOrUndefined(params.launchId),
    windowTitle: trimOrUndefined(params.windowTitle),
  };

  await resolveTargetForScreenshot(selection, signal);
  runtimeState.sessionInputMode = "semantic";
  runtimeState.fallbackRequired = false;
  const captureResult = await captureCurrentTarget(signal);
  const summary = `Captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned updated screenshot. Coordinates are window-relative screenshot pixels.`;
  return buildToolResult("screenshot", summary, captureResult);
}

async function performClick(
  params: ClickParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const capture = validateCaptureId(params.captureId);
  ensurePointIsInCapture(params.x, params.y, capture);
  const button = params.button ?? "left";

  return await runCoordinateAction(
    "click",
    capture,
    signal,
    async (target) => {
      let clickedViaAX = false;
      if (button === "left") {
        try {
          const axResult = await bridgeCommand<AxPressAtPointResult>(
            "axPressAtPoint",
            {
              windowId: target.windowId,
              pid: target.pid,
              x: params.x,
              y: params.y,
              captureWidth: capture.width,
              captureHeight: capture.height,
            },
            { signal, timeoutMs: COMMAND_TIMEOUT_MS },
          );
          clickedViaAX = toBoolean(axResult?.pressed);
        } catch {
          clickedViaAX = false;
        }
      }

      if (!clickedViaAX) {
        requireGlobalInputAllowed(params);
        runtimeState.sessionInputMode = "global-input";
        await bridgeCommand(
          "mouseClick",
          {
            windowId: target.windowId,
            pid: target.pid,
            x: params.x,
            y: params.y,
            button,
            clicks: 1,
            captureWidth: capture.width,
            captureHeight: capture.height,
          },
          { signal, timeoutMs: COMMAND_TIMEOUT_MS },
        );
      }
    },
    (target) =>
      `Clicked at (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned updated screenshot. Coordinates are window-relative screenshot pixels.`,
    { x: params.x, y: params.y },
  );
}

async function performDoubleClick(
  params: DoubleClickParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const capture = validateCaptureId(params.captureId);
  ensurePointIsInCapture(params.x, params.y, capture);

  return await runCoordinateAction(
    "double_click",
    capture,
    signal,
    async (target) => {
      requireGlobalInputAllowed(params);
      runtimeState.sessionInputMode = "global-input";
      await bridgeCommand(
        "mouseClick",
        {
          windowId: target.windowId,
          pid: target.pid,
          x: params.x,
          y: params.y,
          button: "left",
          clicks: 2,
          captureWidth: capture.width,
          captureHeight: capture.height,
        },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      );
    },
    (target) =>
      `Double-clicked at (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned updated screenshot. Coordinates are window-relative screenshot pixels.`,
    { x: params.x, y: params.y },
  );
}

async function performMoveMouse(
  params: MoveMouseParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const capture = validateCaptureId(params.captureId);
  ensurePointIsInCapture(params.x, params.y, capture);

  if (!allowsGlobalInput(params)) {
    updateGhostCursor({ x: params.x, y: params.y });
    const captureResult = await captureCurrentTarget(signal);
    const summary = `Moved the T3 agent cursor to (${Math.round(params.x)},${Math.round(params.y)}) in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. The user's real pointer was not moved.`;
    return buildToolResult("move_mouse", summary, captureResult);
  }

  return await runCoordinateAction(
    "move_mouse",
    capture,
    signal,
    async (target) => {
      runtimeState.sessionInputMode = "global-input";
      await bridgeCommand(
        "mouseMove",
        {
          windowId: target.windowId,
          pid: target.pid,
          x: params.x,
          y: params.y,
          captureWidth: capture.width,
          captureHeight: capture.height,
        },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      );
    },
    (target) =>
      `Moved mouse to (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned updated screenshot.`,
    { x: params.x, y: params.y },
  );
}

async function performDrag(
  params: DragParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  if (!Array.isArray(params.path) || params.path.length < 2) {
    throw new Error("Drag path must contain at least two points.");
  }

  const capture = validateCaptureId(params.captureId);
  for (const [index, point] of params.path.entries()) {
    ensurePointIsInCapture(point.x, point.y, capture, `Drag path point ${index + 1}`);
  }

  return await runCoordinateAction(
    "drag",
    capture,
    signal,
    async (target) => {
      requireGlobalInputAllowed(params);
      runtimeState.sessionInputMode = "global-input";
      await bridgeCommand(
        "mouseDrag",
        {
          windowId: target.windowId,
          pid: target.pid,
          path: params.path,
          captureWidth: capture.width,
          captureHeight: capture.height,
        },
        { signal, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, params.path.length * 120) },
      );
    },
    (target) =>
      `Dragged across ${params.path.length} points in ${target.appName} — ${target.windowTitle}. Returned updated screenshot.`,
    { x: params.path[params.path.length - 1].x, y: params.path[params.path.length - 1].y },
  );
}

async function performScroll(
  params: ScrollParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const capture = validateCaptureId(params.captureId);
  ensurePointIsInCapture(params.x, params.y, capture);

  if (!Number.isFinite(params.scrollX) || !Number.isFinite(params.scrollY)) {
    throw new Error("scrollX and scrollY must be finite numbers.");
  }

  return await runCoordinateAction(
    "scroll",
    capture,
    signal,
    async (target) => {
      requireGlobalInputAllowed(params);
      runtimeState.sessionInputMode = "global-input";
      await bridgeCommand(
        "mouseScroll",
        {
          windowId: target.windowId,
          pid: target.pid,
          x: params.x,
          y: params.y,
          scrollX: params.scrollX,
          scrollY: params.scrollY,
          captureWidth: capture.width,
          captureHeight: capture.height,
        },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      );
    },
    (target) =>
      `Scrolled at (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned updated screenshot.`,
    { x: params.x, y: params.y },
  );
}

function clipboardPasteKeys(): string[] {
  return process.platform === "win32" ? ["CTRL", "V"] : ["CMD", "V"];
}

function normalizeFocusedTextValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function didTextEntrySucceed(
  before: FocusedElementResult,
  after: FocusedElementResult,
  text: string,
): boolean {
  if (!after.exists || !after.isTextInput) {
    return false;
  }

  if (after.isSecure) {
    return true;
  }

  const normalizedText = normalizeFocusedTextValue(text) ?? "";
  const beforeValue = normalizeFocusedTextValue(before.value);
  const afterValue = normalizeFocusedTextValue(after.value);

  if (afterValue !== undefined) {
    if (afterValue === normalizedText) {
      return true;
    }
    if (beforeValue !== undefined && afterValue === `${beforeValue}${normalizedText}`) {
      return true;
    }
    if (normalizedText.length > 0 && afterValue.includes(normalizedText)) {
      return true;
    }
  }

  if (typeof before.valueLength === "number" && typeof after.valueLength === "number") {
    return after.valueLength >= before.valueLength + normalizedText.length;
  }

  if (typeof after.valueLength === "number") {
    return after.valueLength >= normalizedText.length;
  }

  return false;
}

async function tryClipboardTextEntry(
  text: string,
  before: FocusedElementResult,
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<boolean> {
  const clipboardResult = await bridgeCommand<any>(
    "getClipboard",
    {},
    { signal, timeoutMs: COMMAND_TIMEOUT_MS },
  ).catch(() => undefined);
  const previousClipboard = toOptionalString(clipboardResult?.value);
  let clipboardChanged = false;

  try {
    await bridgeCommand("setClipboard", { value: text }, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
    clipboardChanged = true;
    await bridgeCommand(
      "keypress",
      { keys: clipboardPasteKeys(), pid: target.pid, windowId: target.windowId },
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    const afterPaste = await bridgeCommand<FocusedElementResult>(
      "focusedElement",
      { pid: target.pid, windowId: target.windowId },
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    ).catch(() => ({ exists: false }));
    return didTextEntrySucceed(before, afterPaste, text);
  } catch {
    return false;
  } finally {
    if (clipboardChanged && previousClipboard !== undefined) {
      await bridgeCommand(
        "setClipboard",
        { value: previousClipboard },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      ).catch(() => undefined);
    }
  }
}

async function tryRawTypeTextEntry(
  text: string,
  before: FocusedElementResult,
  target: ResolvedTarget,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await bridgeCommand(
      "typeText",
      { text, pid: target.pid },
      {
        signal,
        timeoutMs: Math.min(90_000, Math.max(COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)),
      },
    );
    const afterRawType = await bridgeCommand<FocusedElementResult>(
      "focusedElement",
      { pid: target.pid, windowId: target.windowId },
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    ).catch(() => ({ exists: false }));
    if (didTextEntrySucceed(before, afterRawType, text)) {
      return true;
    }

    return process.platform === "win32" && before.exists && before.isTextInput === true;
  } catch {
    return false;
  }
}

async function performTypeText(
  params: TypeTextParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const text = typeof params.text === "string" ? params.text : "";
  const currentTarget = await resolveCurrentTarget(signal);
  let activation = emptyActivation();
  let stateMayHaveChanged = false;

  try {
    const readyTarget = await ensureTargetWindowId(currentTarget, signal);

    let typed = false;

    if (process.platform === "win32") {
      const focused = await bridgeCommand<FocusedElementResult>(
        "focusedElement",
        { pid: readyTarget.pid, windowId: readyTarget.windowId },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      ).catch(() => ({ exists: false }));

      if (focused.exists && focused.isTextInput && focused.canSetValue && focused.elementRef) {
        try {
          await bridgeCommand(
            "setValue",
            {
              elementRef: focused.elementRef,
              value: text,
            },
            { signal, timeoutMs: COMMAND_TIMEOUT_MS },
          );
          runtimeState.sessionInputMode = "semantic";
          runtimeState.fallbackRequired = false;
          typed = true;
        } catch {
          typed = false;
        }
      }

      if (!typed) {
        requireGlobalInputAllowed(params);
        runtimeState.sessionInputMode = "global-input";
      }

      try {
        if (!typed) {
          const nativeTextEntry = await bridgeCommand<NativeTextEntryResult>(
            "textEntry",
            { text, pid: readyTarget.pid, windowId: readyTarget.windowId },
            {
              signal,
              timeoutMs: Math.min(90_000, Math.max(COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)),
            },
          );
          typed = toBoolean(nativeTextEntry?.done);
        }
      } catch {
        typed = false;
      }

      if (!typed) {
        throw new Error(
          "The native Windows text entry helper could not type the text. Click the intended field and try again.",
        );
      }
    } else {
      let focused: FocusedElementResult = { exists: false };

      focused = await bridgeCommand<FocusedElementResult>(
        "focusedElement",
        { pid: readyTarget.pid, windowId: readyTarget.windowId },
        { signal, timeoutMs: COMMAND_TIMEOUT_MS },
      ).catch(() => ({ exists: false }));

      if (focused.exists && focused.isTextInput && focused.canSetValue && focused.elementRef) {
        try {
          await bridgeCommand(
            "setValue",
            {
              elementRef: focused.elementRef,
              value: text,
            },
            { signal, timeoutMs: COMMAND_TIMEOUT_MS },
          );
          typed = true;
        } catch {
          // fall through to clipboard/raw typing path
        }
      }

      if (!typed) {
        requireGlobalInputAllowed(params);
        runtimeState.sessionInputMode = "global-input";
        typed = await tryClipboardTextEntry(text, focused, readyTarget, signal);
      }

      if (!typed) {
        requireGlobalInputAllowed(params);
        runtimeState.sessionInputMode = "global-input";
        typed = await tryRawTypeTextEntry(text, focused, readyTarget, signal);
      }

      if (!typed) {
        throw new Error(
          "Typing failed through AX text setting, clipboard paste, and raw key events. Click the intended field and try again.",
        );
      }
    }

    stateMayHaveChanged = true;
    await sleep(ACTION_SETTLE_MS, signal);
    const captureResult = await captureCurrentTarget(signal, activation);
    const inputMode =
      runtimeState.sessionInputMode === "global-input" ? "global input" : "UI Automation";
    const summary = `Typed text in ${captureResult.target.appName} — ${captureResult.target.windowTitle} via ${inputMode}. Returned updated screenshot.`;
    return buildToolResult("type_text", summary, captureResult);
  } catch (error) {
    if (stateMayHaveChanged) {
      throw addRefreshHint(error);
    }
    throw normalizeError(error);
  }
}

async function performListElements(
  params: ListElementsParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ListElementsDetails>> {
  currentTargetOrThrow();
  const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
  const actionableOnly = params.actionableOnly !== false;
  const maxItems = Math.max(1, Math.min(500, Math.trunc(toFiniteNumber(params.maxItems, 120))));
  const maxDepth = Math.max(1, Math.min(24, Math.trunc(toFiniteNumber(params.maxDepth, 10))));

  const result = await bridgeCommand<any>(
    "listElements",
    { windowId: target.windowId, pid: target.pid, actionableOnly, maxItems, maxDepth },
    { signal, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  runtimeState.sessionInputMode = "semantic";
  runtimeState.fallbackRequired = false;

  const elements = Array.isArray(result?.elements)
    ? (result.elements as SemanticElementInfo[])
    : [];
  const count = Math.max(
    elements.length,
    Math.trunc(toFiniteNumber(result?.count, elements.length)),
  );

  return {
    content: [{ type: "text", text: summarizeElements(elements, actionableOnly) }],
    details: {
      tool: "list_elements",
      target: buildSemanticTargetInfo(target),
      count,
      actionableOnly,
      elements,
      ...(currentSessionStateForRuntime()
        ? {
            session: currentSessionStateForRuntime()!,
            capture: currentCaptureStateForRuntime() ?? undefined,
          }
        : {}),
    },
  };
}

async function performGetVisibleText(
  params: GetVisibleTextParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<VisibleTextDetails>> {
  currentTargetOrThrow();
  const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
  const maxItems = Math.max(1, Math.min(500, Math.trunc(toFiniteNumber(params.maxItems, 160))));
  const maxDepth = Math.max(1, Math.min(24, Math.trunc(toFiniteNumber(params.maxDepth, 12))));

  const result = await bridgeCommand<any>(
    "getVisibleText",
    { windowId: target.windowId, pid: target.pid, maxItems, maxDepth },
    { signal, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  runtimeState.sessionInputMode = "semantic";
  runtimeState.fallbackRequired = false;

  const text = typeof result?.text === "string" ? result.text : "";
  const items = Array.isArray(result?.items) ? (result.items as VisibleTextItem[]) : [];
  const count = Math.max(items.length, Math.trunc(toFiniteNumber(result?.count, items.length)));

  return {
    content: [{ type: "text", text: summarizeVisibleText(text, count) }],
    details: {
      tool: "get_visible_text",
      target: buildSemanticTargetInfo(target),
      count,
      text,
      items,
      ...(currentSessionStateForRuntime()
        ? {
            session: currentSessionStateForRuntime()!,
            capture: currentCaptureStateForRuntime() ?? undefined,
          }
        : {}),
    },
  };
}

async function performActivateElement(
  params: ActivateElementParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  if (typeof params.elementRef !== "string" || params.elementRef.trim().length === 0) {
    throw new Error("activate_element requires a non-empty elementRef.");
  }

  const currentTarget = await resolveCurrentTarget(signal);
  let activation = emptyActivation();
  let stateMayHaveChanged = false;

  try {
    const readyTarget = await ensureTargetWindowId(currentTarget, signal);
    const action =
      typeof params.action === "string" && params.action.trim().length > 0
        ? params.action.trim().toLowerCase()
        : undefined;

    const result = await bridgeCommand<any>(
      "activateElement",
      {
        elementRef: params.elementRef,
        action,
        windowId: readyTarget.windowId,
        pid: readyTarget.pid,
      },
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    );

    runtimeState.sessionInputMode = "semantic";
    runtimeState.fallbackRequired = false;
    stateMayHaveChanged = true;
    await sleep(ACTION_SETTLE_MS, signal);
    const captureResult = await captureCurrentTarget(signal, activation);
    const method = typeof result?.method === "string" ? result.method : "default";
    const summary = `Activated element ${params.elementRef} via ${method} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned updated screenshot.`;
    return buildToolResult("activate_element", summary, captureResult);
  } catch (error) {
    if (stateMayHaveChanged) {
      throw addRefreshHint(error);
    }
    throw normalizeError(error);
  }
}

function normalizeKeyToken(token: string): string {
  const normalized = token.trim().toUpperCase();
  switch (normalized) {
    case "COMMAND":
    case "CMD":
    case "META":
      return "CMD";
    case "CONTROL":
    case "CTRL":
      return "CTRL";
    case "ALT":
    case "OPTION":
    case "OPT":
      return "ALT";
    case "RETURN":
      return "ENTER";
    case "ESC":
      return "ESCAPE";
    default:
      return normalized;
  }
}

function splitShortcut(text: string): string[] {
  return text
    .split(/[+,]/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function normalizeKeysInput(input: string[] | string): string[] {
  const tokens: string[] = [];
  if (typeof input === "string") {
    tokens.push(...splitShortcut(input));
  } else {
    for (const item of input) {
      if (typeof item !== "string") continue;
      if (item.includes("+") || item.includes(",")) {
        tokens.push(...splitShortcut(item));
      } else {
        tokens.push(item.trim());
      }
    }
  }

  const normalized = tokens.map(normalizeKeyToken).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("keys must contain at least one key.");
  }
  return normalized;
}

export function prepareKeypressArguments(args: unknown): { keys: string[] } {
  const raw = typeof args === "object" && args !== null ? (args as any).keys : undefined;
  if (Array.isArray(raw)) {
    return { keys: normalizeKeysInput(raw) };
  }
  if (typeof raw === "string") {
    return { keys: normalizeKeysInput(raw) };
  }
  if (typeof args === "string") {
    return { keys: normalizeKeysInput(args) };
  }
  throw new Error("keypress expects { keys: string[] } or shortcut text like 'cmd+l'.");
}

async function performKeypress(
  params: KeypressParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  const keys = normalizeKeysInput(params.keys);
  const currentTarget = await resolveCurrentTarget(signal);
  let activation = emptyActivation();
  let stateMayHaveChanged = false;

  try {
    const readyTarget = await ensureTargetWindowId(currentTarget, signal);

    requireGlobalInputAllowed(params);
    runtimeState.sessionInputMode = "global-input";
    await bridgeCommand(
      "keypress",
      { keys, pid: readyTarget.pid, windowId: readyTarget.windowId },
      { signal, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    stateMayHaveChanged = true;

    await sleep(ACTION_SETTLE_MS, signal);
    const captureResult = await captureCurrentTarget(signal, activation);
    const summary = `Pressed ${keys.join("+")} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned updated screenshot.`;
    return buildToolResult("keypress", summary, captureResult);
  } catch (error) {
    if (stateMayHaveChanged) {
      throw addRefreshHint(error);
    }
    throw normalizeError(error);
  }
}

async function performWait(
  params: WaitParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails>> {
  if (!runtimeState.currentTarget) {
    throw new Error(MISSING_TARGET_ERROR);
  }

  const msRaw = params.ms ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(msRaw) || msRaw < 0) {
    throw new Error("wait.ms must be a non-negative number.");
  }

  const ms = Math.min(60_000, Math.round(msRaw));
  await sleep(ms, signal);
  runtimeState.fallbackRequired = false;
  const captureResult = await captureCurrentTarget(signal);
  const summary = `Waited ${ms}ms in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned updated screenshot.`;
  return buildToolResult("wait", summary, captureResult);
}

async function executeTool<T>(
  ctx: ExtensionContextLike,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await withRuntimeLock(async () => {
    await ensureReady(ctx, signal);
    throwIfAborted(signal);

    return await run();
  });
}

export async function executeScreenshot(
  _toolCallId: string,
  params: ScreenshotParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performScreenshot(params, signal));
}

export async function executeClick(
  _toolCallId: string,
  params: ClickParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performClick(params, signal));
}

export async function executeDoubleClick(
  _toolCallId: string,
  params: DoubleClickParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performDoubleClick(params, signal));
}

export async function executeMoveMouse(
  _toolCallId: string,
  params: MoveMouseParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performMoveMouse(params, signal));
}

export async function executeDrag(
  _toolCallId: string,
  params: DragParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performDrag(params, signal));
}

export async function executeScroll(
  _toolCallId: string,
  params: ScrollParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performScroll(params, signal));
}

export async function executeTypeText(
  _toolCallId: string,
  params: TypeTextParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performTypeText(params, signal));
}

export async function executeListElements(
  _toolCallId: string,
  params: ListElementsParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ListElementsDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ListElementsDetails>> {
  return await executeTool(ctx, signal, () => performListElements(params, signal));
}

export async function executeGetVisibleText(
  _toolCallId: string,
  params: GetVisibleTextParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<VisibleTextDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<VisibleTextDetails>> {
  return await executeTool(ctx, signal, () => performGetVisibleText(params, signal));
}

export async function executeActivateElement(
  _toolCallId: string,
  params: ActivateElementParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performActivateElement(params, signal));
}

export async function executeKeypress(
  _toolCallId: string,
  params: KeypressParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performKeypress(params, signal));
}

export async function executeWait(
  _toolCallId: string,
  params: WaitParams,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<ComputerUseDetails> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<ComputerUseDetails>> {
  return await executeTool(ctx, signal, () => performWait(params, signal));
}

export async function executeListRunningApps(
  _toolCallId: string,
  _params: Record<string, never>,
  signal: AbortSignal | undefined,
  _onUpdate: AgentToolUpdateCallback<{ tool: "list_apps"; apps: HelperApp[] }> | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<{ tool: "list_apps"; apps: HelperApp[] }>> {
  return await executeTool(ctx, signal, async () => {
    const apps = await listApps(signal);
    return {
      content: [
        {
          type: "text",
          text: apps
            .map((app) => `${app.isFrontmost ? "* " : "- "}${app.appName} (pid ${app.pid})`)
            .join("\n"),
        },
      ],
      details: { tool: "list_apps", apps },
    };
  });
}

export async function executeListAppWindows(
  _toolCallId: string,
  params: { pid: number },
  signal: AbortSignal | undefined,
  _onUpdate:
    | AgentToolUpdateCallback<{ tool: "list_windows"; pid: number; windows: HelperWindow[] }>
    | undefined,
  ctx: ExtensionContextLike,
): Promise<AgentToolResult<{ tool: "list_windows"; pid: number; windows: HelperWindow[] }>> {
  return await executeTool(ctx, signal, async () => {
    const pid = Math.trunc(toFiniteNumber(params.pid, NaN));
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error("list_windows requires a positive pid.");
    }
    const windows = await listWindows(pid, signal);
    return {
      content: [
        {
          type: "text",
          text: windows
            .map((window) => `- ${window.title || "(untitled)"} (${window.windowId ?? "no id"})`)
            .join("\n"),
        },
      ],
      details: { tool: "list_windows", pid, windows },
    };
  });
}

export function reconstructStateFromBranch(ctx: ExtensionContextLike): void {
  runtimeState.currentTarget = undefined;
  runtimeState.currentCapture = undefined;
  runtimeState.currentSessionId = undefined;
  runtimeState.ghostCursor = undefined;
  runtimeState.sessionInputMode = undefined;
  runtimeState.fallbackRequired = false;

  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if ((entry as any)?.type !== "message") continue;
    const message = (entry as any).message;
    if (!message || message.role !== "toolResult") continue;
    if (!TOOL_NAMES.has(message.toolName)) continue;

    const details = message.details as Partial<ComputerUseDetails> | undefined;
    if (!details?.target || !details?.capture) continue;

    const app =
      typeof details.target.app === "string"
        ? details.target.app
        : typeof (details.target as any).appName === "string"
          ? (details.target as any).appName
          : undefined;

    if (!app) continue;
    if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
    if (typeof details.capture.captureId !== "string") continue;

    runtimeState.currentTarget = {
      appName: app,
      bundleId: details.target.bundleId,
      pid: Math.trunc(details.target.pid),
      windowTitle: details.target.windowTitle ?? "(untitled)",
      windowId: Math.trunc(details.target.windowId),
    };
    runtimeState.currentSessionId =
      details.session?.sessionId ?? sessionIdForTarget(runtimeState.currentTarget);
    runtimeState.sessionInputMode = details.session?.inputMode ?? "semantic";
    runtimeState.fallbackRequired = details.session?.fallbackRequired === true;

    runtimeState.currentCapture = {
      captureId: details.capture.captureId,
      width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
      height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
      scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
      timestamp: Number.isFinite(details.capture.timestamp)
        ? details.capture.timestamp
        : Date.now(),
    };

    if (details.ghostCursor) {
      runtimeState.ghostCursor = {
        x: Math.max(0, Math.round(toFiniteNumber(details.ghostCursor.x, 0))),
        y: Math.max(0, Math.round(toFiniteNumber(details.ghostCursor.y, 0))),
      };
    }
    break;
  }
}

export function stopBridge(): void {
  rejectAllPending(new HelperTransportError("Computer-use helper stopped."));
  void callDesktopBridge("computer.hide_overlay", {});

  const helper = runtimeState.helper;
  runtimeState.helper = undefined;
  runtimeState.helperStdoutBuffer = "";
  runtimeState.ghostCursor = undefined;
  runtimeState.currentSessionId = undefined;
  runtimeState.sessionInputMode = undefined;
  runtimeState.fallbackRequired = false;

  if (helper && helper.exitCode === null && !helper.killed) {
    helper.kill("SIGTERM");
  }
}
