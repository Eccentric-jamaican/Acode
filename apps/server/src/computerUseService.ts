import type {
  ComputerUseAppCategory,
  ComputerUseAppSummary,
  ComputerUseListAppsResult,
} from "@t3tools/contracts";
import { execFile } from "node:child_process";

import {
  executeListAppWindows,
  executeListRunningApps,
  type HelperApp,
  type HelperWindow,
} from "./computerUse/bridge";
import type { ExtensionContextLike } from "./computerUse/tool-contract";

const NON_INTERACTIVE_CONTEXT: ExtensionContextLike = {
  hasUI: false,
  ui: {
    async select() {
      return undefined;
    },
    notify() {},
  },
  sessionManager: {
    getBranch() {
      return [];
    },
  },
};

interface InstalledWindowsApp {
  readonly name: string;
  readonly appId: string;
}

interface LaunchedComputerUseApp {
  readonly appName: string;
  readonly launchId: string;
  readonly attached: boolean;
  readonly pid?: number;
  readonly windowId?: number;
  readonly windowTitle?: string;
}

interface ComputerUseWindowQuery {
  readonly appName?: string;
  readonly launchId?: string;
  readonly pid?: number;
  readonly windowId?: number;
  readonly windowTitle?: string;
}

interface BoundedComputerUseWindow {
  readonly appName: string;
  readonly launchId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly windowTitle: string;
  readonly isFocused: boolean;
  readonly isMinimized: boolean;
  readonly isOnscreen: boolean;
  readonly isMain: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ManagedComputerUseWindowResult {
  readonly appName: string;
  readonly launchId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly windowTitle: string;
  readonly focused: boolean;
}

interface TopLevelWindowCandidate {
  readonly pid: number;
  readonly processName: string;
  readonly title: string;
  readonly processPath?: string;
  readonly windowId?: number;
}

export const COMPUTER_USE_APP_ICON_ROUTE_PATH = "/computer-use/app-icon";

const appIconCache = new Map<string, Buffer | null>();
const recentComputerUseLaunches = new Map<string, number>();
const COMPUTER_USE_LAUNCH_COOLDOWN_MS = 8_000;

async function focusAndResizeComputerUseWindow(input: {
  readonly pid: number;
  readonly windowId?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly focus?: boolean | undefined;
}): Promise<void> {
  if (process.platform !== "win32" || !Number.isFinite(input.pid) || input.pid <= 0) {
    return;
  }

  const width =
    typeof input.width === "number" && Number.isFinite(input.width) && input.width > 0
      ? Math.round(input.width)
      : null;
  const height =
    typeof input.height === "number" && Number.isFinite(input.height) && input.height > 0
      ? Math.round(input.height)
      : null;
  const x =
    typeof input.x === "number" && Number.isFinite(input.x)
      ? Math.round(input.x)
      : null;
  const y =
    typeof input.y === "number" && Number.isFinite(input.y)
      ? Math.round(input.y)
      : null;
  const focus = input.focus !== false;
  const windowId =
    typeof input.windowId === "number" && Number.isFinite(input.windowId) && input.windowId > 0
      ? Math.trunc(input.windowId)
      : null;

  const payload = Buffer.from(
    JSON.stringify({ pid: input.pid, windowId, x, y, width, height, focus }),
    "utf8",
  ).toString("base64");
  await runPowerShellJson(
    `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class T3WindowOps {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellStringLiteral(payload)})) | ConvertFrom-Json
$proc = Get-Process -Id ([int]$payload.pid) -ErrorAction Stop | Select-Object -First 1
$hwnd = [IntPtr]::Zero
if ($payload.windowId -ne $null) {
  $candidateHwnd = [IntPtr]([int64]$payload.windowId)
  if ([T3WindowOps]::IsWindow($candidateHwnd)) {
    $hwnd = $candidateHwnd
  }
}
if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [IntPtr]$proc.MainWindowHandle
}
if ($hwnd -eq [IntPtr]::Zero) {
  return @{ focused = $false; resized = $false; reason = 'no_main_window' } | ConvertTo-Json -Compress
}
$focused = $false
$moved = $false
$resized = $false
$focusRequested = [bool]$payload.focus
if ($focusRequested) {
  [void][T3WindowOps]::ShowWindowAsync($hwnd, 9)
  Start-Sleep -Milliseconds 120
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate([int]$proc.Id)
  Start-Sleep -Milliseconds 120
  $focused = [T3WindowOps]::SetForegroundWindow($hwnd)
}
if ($payload.x -ne $null -or $payload.y -ne $null -or $payload.width -ne $null -or $payload.height -ne $null) {
  [void][T3WindowOps]::ShowWindowAsync($hwnd, 9)
  $rect = New-Object T3WindowOps+RECT
  [void][T3WindowOps]::GetWindowRect($hwnd, [ref]$rect)
  $nextX = if ($payload.x -ne $null) { [int]$payload.x } else { [int]$rect.Left }
  $nextY = if ($payload.y -ne $null) { [int]$payload.y } else { [int]$rect.Top }
  $nextWidth = if ($payload.width -ne $null) { [int]$payload.width } else { [int]($rect.Right - $rect.Left) }
  $nextHeight = if ($payload.height -ne $null) { [int]$payload.height } else { [int]($rect.Bottom - $rect.Top) }
  $moved = [T3WindowOps]::MoveWindow($hwnd, $nextX, $nextY, $nextWidth, $nextHeight, $true)
  if ($payload.width -ne $null -or $payload.height -ne $null) {
    $resized = $true
  }
}
@{
  focused = [bool]$focused
  moved = [bool]$moved
  resized = [bool]$resized
} | ConvertTo-Json -Compress
`,
    5_000,
  ).catch(() => undefined);
}

function normalizeAppName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function appCatalogIdForLaunchId(launchId: string): string {
  return `win32-app:${launchId}`;
}

const SYSTEM_APP_NAME_PATTERNS = [
  "3d viewer",
  "application verifier",
  "calculator",
  "camera",
  "character map",
  "clock",
  "command prompt",
  "component services",
  "computer management",
  "control panel",
  "defender",
  "device manager",
  "disk cleanup",
  "event viewer",
  "feedback hub",
  "file explorer",
  "firewall",
  "get help",
  "magnifier",
  "media player",
  "microsoft store",
  "notepad",
  "odbc",
  "paint",
  "performance monitor",
  "photos",
  "power automate",
  "powershell",
  "print management",
  "quick assist",
  "registry editor",
  "remote desktop connection",
  "resource monitor",
  "security",
  "services",
  "settings",
  "snipping tool",
  "steps recorder",
  "system configuration",
  "system information",
  "task manager",
  "terminal",
  "windows defender",
  "windows security",
  "windows tools",
  "wordpad",
  "xbox",
];

const SYSTEM_APP_ID_PATTERNS = [
  "microsoft.windows",
  "windows.",
  "system32",
  "appresolverux",
  "controlpanel",
  "immersivecontrolpanel",
];

const BACKGROUND_APP_NAME_PATTERNS = [
  "crashpad",
  "helper",
  "service",
  "updater",
  "update service",
  "webview",
  "webview2",
];

const BACKGROUND_APP_ID_PATTERNS = [
  "backgroundtaskhost",
  "runtimebroker",
  "searchhost",
  "shellexperiencehost",
  "startmenuexperiencehost",
  "textinputhost",
];

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

export function classifyComputerUseApp(input: {
  readonly name: string;
  readonly appId: string;
  readonly launchId?: string | undefined;
  readonly isRunning: boolean;
  readonly windowCount: number;
}): ComputerUseAppCategory {
  const name = input.name.toLowerCase();
  const searchable = `${input.appId} ${input.launchId ?? ""}`.toLowerCase();
  if (
    matchesAnyPattern(name, SYSTEM_APP_NAME_PATTERNS) ||
    matchesAnyPattern(searchable, SYSTEM_APP_ID_PATTERNS)
  ) {
    return "system";
  }
  if (
    matchesAnyPattern(name, BACKGROUND_APP_NAME_PATTERNS) ||
    matchesAnyPattern(searchable, BACKGROUND_APP_ID_PATTERNS)
  ) {
    return "background";
  }
  if (!input.launchId && input.isRunning && input.windowCount === 0) {
    return "background";
  }
  if (input.launchId) {
    return "desktop";
  }
  return input.isRunning ? "background" : "other";
}

function appIdFor(app: HelperApp): string {
  const base =
    app.bundleId?.trim() ||
    app.appName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");
  return `win32:${base || app.pid}:${app.pid}`;
}

function toWindowSummary(window: HelperWindow): ComputerUseAppSummary["windows"][number] {
  return {
    windowId: window.windowId ?? null,
    title: window.title,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    isFocused: window.isFocused,
  };
}

function unavailableResult(error: unknown): ComputerUseListAppsResult {
  const detail = error instanceof Error ? error.message : String(error);
  const missingDotnet =
    detail.includes("exit code 131") ||
    detail.includes("-2147450749") ||
    detail.toLowerCase().includes(".net");
  return {
    apps: [],
    status: {
      available: false,
      reason: missingDotnet ? "missing-dotnet-runtime" : "helper-unavailable",
      detail: missingDotnet
        ? "The Windows T3 Computer Use helper requires the .NET 8 Desktop Runtime unless it is packaged as a self-contained helper."
        : detail,
    },
  };
}

function runPowerShellJson(command: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function computerUseAppIconUrl(input: {
  readonly iconBaseUrl?: string | undefined;
  readonly name: string;
  readonly pid: number;
  readonly launchId?: string | undefined;
}): string | null {
  if (!input.iconBaseUrl) return null;
  const params = new URLSearchParams();
  params.set("name", input.name);
  if (input.pid > 0) params.set("pid", String(input.pid));
  if (input.launchId) params.set("launchId", input.launchId);
  return `${input.iconBaseUrl}${COMPUTER_USE_APP_ICON_ROUTE_PATH}?${params.toString()}`;
}

function powershellStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function appIconCacheKey(input: {
  readonly name?: string | undefined;
  readonly pid?: number | undefined;
  readonly launchId?: string | undefined;
}): string {
  return JSON.stringify({
    launchId: input.launchId ?? "",
    name: input.name ?? "",
    pid: input.pid ?? 0,
  });
}

export async function resolveComputerUseAppIcon(input: {
  readonly name?: string | undefined;
  readonly pid?: number | undefined;
  readonly launchId?: string | undefined;
}): Promise<Buffer | null> {
  if (process.platform !== "win32") return null;
  const cacheKey = appIconCacheKey(input);
  if (appIconCache.has(cacheKey)) {
    return appIconCache.get(cacheKey) ?? null;
  }

  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  const raw = await runPowerShellJson(
    `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellStringLiteral(payload)})) | ConvertFrom-Json
$paths = New-Object System.Collections.Generic.List[string]
$knownFolderPaths = @{
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}' = [Environment]::SystemDirectory
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}' = \${env:ProgramFiles(x86)}
  '{6D809377-6AF0-444B-8957-A3773F02200E}' = $env:ProgramFiles
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}' = $env:LOCALAPPDATA
}
if ($payload.pid -and [int]$payload.pid -gt 0) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($payload.pid)"
  if ($proc -and $proc.ExecutablePath) { $paths.Add([string]$proc.ExecutablePath) }
}
if ($payload.launchId) {
  $launchText = [string]$payload.launchId
  if ($launchText -match '^({[0-9A-Fa-f-]+})\\(.+)$') {
    $root = $knownFolderPaths[$Matches[1].ToUpperInvariant()]
    if ($root) {
      $knownPath = Join-Path $root $Matches[2]
      if (Test-Path $knownPath) { $paths.Add($knownPath) }
      if ([IO.Path]::GetExtension($knownPath) -ieq '.msc') {
        $mmcPath = Join-Path ([Environment]::SystemDirectory) 'mmc.exe'
        if (Test-Path $mmcPath) { $paths.Add($mmcPath) }
      }
    }
  } elseif (Test-Path $launchText) {
    $paths.Add($launchText)
  }
}
if ($payload.launchId -and ([string]$payload.launchId).Contains('!')) {
  $launchParts = ([string]$payload.launchId).Split('!', 2)
  $packageFamilyName = $launchParts[0]
  $applicationId = $launchParts[1]
  $package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -ieq $packageFamilyName } | Select-Object -First 1
  if ($package -and $package.InstallLocation) {
    $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
    if (Test-Path $manifestPath) {
      [xml]$manifest = Get-Content -LiteralPath $manifestPath
      foreach ($application in $manifest.Package.Applications.Application) {
        if ($applicationId -and ([string]$application.Id) -ine $applicationId) { continue }
        $visualElements = $application.VisualElements
        $logoRelativePath = $visualElements.Square44x44Logo
        if (!$logoRelativePath) { $logoRelativePath = $visualElements.Logo }
        if (!$logoRelativePath) { continue }
        $logoPath = Join-Path $package.InstallLocation ([string]$logoRelativePath)
        if (Test-Path $logoPath) { $paths.Add($logoPath) }
        $logoDir = Split-Path $logoPath -Parent
        $logoBase = [IO.Path]::GetFileNameWithoutExtension($logoPath)
        $logoExt = [IO.Path]::GetExtension($logoPath)
        if ($logoDir -and (Test-Path $logoDir)) {
          foreach ($candidate in Get-ChildItem -LiteralPath $logoDir -Filter "$logoBase*$logoExt" -ErrorAction SilentlyContinue) {
            $paths.Add($candidate.FullName)
          }
        }
      }
    }
  }
}
$roots = @()
foreach ($startRoot in @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'))) {
  if ($startRoot) {
    $roots += $startRoot
    $roots += (Join-Path $startRoot 'Programs')
  }
}
$wsh = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (!(Test-Path $root)) { continue }
  foreach ($link in Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue) {
    $shortcut = $wsh.CreateShortcut($link.FullName)
    $linkName = [IO.Path]::GetFileNameWithoutExtension($link.Name)
    $nameMatch = $payload.name -and ($linkName -ieq [string]$payload.name)
    $launchMatch = $payload.launchId -and (
      ([string]$shortcut.TargetPath).IndexOf([string]$payload.launchId, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ([string]$shortcut.Arguments).IndexOf([string]$payload.launchId, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ([string]$shortcut.IconLocation).IndexOf([string]$payload.launchId, [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
    if (!$nameMatch -and !$launchMatch) { continue }
    if ($shortcut.IconLocation) {
      $iconPath = ([string]$shortcut.IconLocation).Split(',')[0]
      if ($iconPath -and (Test-Path $iconPath)) { $paths.Add($iconPath) }
    }
    if ($shortcut.TargetPath -and (Test-Path $shortcut.TargetPath)) { $paths.Add([string]$shortcut.TargetPath) }
  }
}
foreach ($path in $paths) {
  if (!(Test-Path $path)) { continue }
  if ([IO.Path]::GetExtension($path) -ieq '.png') {
    @{ base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) } | ConvertTo-Json -Compress
    exit 0
  }
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if (!$icon) { continue }
  $bitmap = $icon.ToBitmap()
  $stream = New-Object IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $result = @{ base64 = [Convert]::ToBase64String($stream.ToArray()) }
  $stream.Dispose()
  $bitmap.Dispose()
  $icon.Dispose()
  $result | ConvertTo-Json -Compress
  exit 0
}
@{ base64 = $null } | ConvertTo-Json -Compress
`,
    10_000,
  ).catch(() => ({ base64: null }));

  const base64 =
    raw && typeof raw === "object" && typeof (raw as { base64?: unknown }).base64 === "string"
      ? (raw as { base64: string }).base64
      : null;
  const bytes = base64 ? Buffer.from(base64, "base64") : null;
  if (bytes) {
    appIconCache.set(cacheKey, bytes);
  }
  return bytes;
}

async function listInstalledWindowsApps(): Promise<InstalledWindowsApp[]> {
  if (process.platform !== "win32") return [];
  const raw = await runPowerShellJson(
    "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
    10_000,
  );
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const seen = new Set<string>();
  const apps: InstalledWindowsApp[] = [];
  for (const entry of entries) {
    const name =
      typeof (entry as { Name?: unknown }).Name === "string"
        ? (entry as { Name: string }).Name.trim()
        : "";
    const appId =
      typeof (entry as { AppID?: unknown }).AppID === "string"
        ? (entry as { AppID: string }).AppID.trim()
        : "";
    if (!name || !appId || seen.has(appId)) continue;
    seen.add(appId);
    apps.push({ name, appId });
  }
  return apps;
}

export async function launchComputerUseApp(input: {
  readonly appName?: string | undefined;
  readonly launchId?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}): Promise<LaunchedComputerUseApp> {
  if (process.platform !== "win32") {
    throw new Error("Launching installed apps is currently implemented for Windows only.");
  }
  const installedApps = await listInstalledWindowsApps();
  const installedApp =
    installedApps.find((app) => app.appId === input.launchId?.trim()) ??
    installedApps.find((app) => normalizeAppName(app.name) === normalizeAppName(input.appName ?? ""));
  const launchId = input.launchId?.trim() || installedApp?.appId;
  if (!launchId) {
    throw new Error(`Unable to find installed app '${input.appName ?? ""}'.`);
  }
  const appName = installedApp?.name ?? input.appName?.trim() ?? launchId;
  const topLevelWindows = await listTopLevelWindows().catch(() => []);
  const runningBeforeLaunch = await listComputerUseApps().catch(() => null);
  const existingApp = findReusableRunningWindow(
    runningBeforeLaunch,
    topLevelWindows,
    appName,
    launchId,
  );
  if (existingApp?.isRunning && existingApp.windows.some(isAttachableWindow)) {
    const window = existingApp.windows.find(isAttachableWindow);
    await focusAndResizeComputerUseWindow({
      pid: existingApp.pid,
      windowId: window?.windowId ?? undefined,
      width: input.width,
      height: input.height,
    });
    return {
      appName: existingApp.name,
      launchId,
      attached: true,
      pid: existingApp.pid,
      ...(window?.windowId ? { windowId: window.windowId } : {}),
      ...(window?.title ? { windowTitle: window.title } : {}),
    };
  }

  const topLevelReuseCandidate = findReusableRunningWindowByTopLevelWindow(
    topLevelWindows,
    launchId,
    appName,
  );
  if (topLevelReuseCandidate?.pid) {
    const attached = await canAttachToPid(
      topLevelReuseCandidate.pid,
      input.width,
      input.height,
    );
    if (attached) {
      const fallbackAppName =
        topLevelReuseCandidate.title.trim().length > 0 ? topLevelReuseCandidate.title : appName;
      return {
        appName: fallbackAppName,
        launchId,
        attached: true,
        pid: topLevelReuseCandidate.pid,
        ...(topLevelReuseCandidate.windowId ? { windowId: topLevelReuseCandidate.windowId } : {}),
        ...(topLevelReuseCandidate.title ? { windowTitle: topLevelReuseCandidate.title } : {}),
      };
    }
  }

  const recentLaunchAt = recentComputerUseLaunches.get(launchId) ?? 0;
  const shouldLaunch = Date.now() - recentLaunchAt > COMPUTER_USE_LAUNCH_COOLDOWN_MS;
  if (shouldLaunch) {
    recentComputerUseLaunches.set(launchId, Date.now());
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "explorer.exe",
        [`shell:AppsFolder\\${launchId}`],
        { windowsHide: true },
        (error) => {
          if (error) reject(error);
        },
      );
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const currentTopLevelWindows = await listTopLevelWindows().catch(() => topLevelWindows);
    const appsResult = await listComputerUseApps();
    const launchedApp = appsResult.apps.find(
      (app) =>
        app.launchId === launchId ||
        normalizeAppName(app.name) === normalizeAppName(appName),
    );
    const readyWindow = launchedApp?.windows.find(
      isAttachableWindow,
    );
    if (launchedApp?.isRunning && readyWindow) {
      await focusAndResizeComputerUseWindow({
        pid: launchedApp.pid,
        windowId: readyWindow.windowId ?? undefined,
        width: input.width,
        height: input.height,
      });
      return {
        appName: launchedApp.name,
        launchId,
        attached: true,
        pid: launchedApp.pid,
        ...(readyWindow.windowId ? { windowId: readyWindow.windowId } : {}),
        ...(readyWindow.title ? { windowTitle: readyWindow.title } : {}),
      };
    }
    const reusableTopLevelMatch = findReusableRunningWindow(
      appsResult,
      currentTopLevelWindows,
      appName,
      launchId,
    );
    if (reusableTopLevelMatch?.isRunning && reusableTopLevelMatch.windows.some(isAttachableWindow)) {
      const window = reusableTopLevelMatch.windows.find(isAttachableWindow);
      await focusAndResizeComputerUseWindow({
        pid: reusableTopLevelMatch.pid,
        windowId: window?.windowId ?? undefined,
        width: input.width,
        height: input.height,
      });
      return {
        appName: reusableTopLevelMatch.name,
        launchId,
        attached: true,
        pid: reusableTopLevelMatch.pid,
        ...(window?.windowId ? { windowId: window.windowId } : {}),
        ...(window?.title ? { windowTitle: window.title } : {}),
      };
    }
    const fallbackTopLevelMatch = findReusableRunningWindowByTopLevelWindow(
      currentTopLevelWindows,
      launchId,
      appName,
    );
    if (
      fallbackTopLevelMatch?.pid &&
      (await canAttachToPid(fallbackTopLevelMatch.pid, input.width, input.height))
    ) {
      const fallbackAppName =
        fallbackTopLevelMatch.title.trim().length > 0 ? fallbackTopLevelMatch.title : appName;
      return {
        appName: fallbackAppName,
        launchId,
        attached: true,
        pid: fallbackTopLevelMatch.pid,
        ...(fallbackTopLevelMatch.windowId ? { windowId: fallbackTopLevelMatch.windowId } : {}),
        ...(fallbackTopLevelMatch.title ? { windowTitle: fallbackTopLevelMatch.title } : {}),
      };
    }
    await delay(400);
  }

  return { appName, launchId, attached: false };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAttachableWindow(window: ComputerUseAppSummary["windows"][number]): boolean {
  return window.isOnscreen && !window.isMinimized;
}

async function listTopLevelWindows(): Promise<ReadonlyArray<TopLevelWindowCandidate>> {
  if (process.platform !== "win32") {
    return [];
  }

  const raw = await runPowerShellJson(
    `
$windows = Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |
  ForEach-Object {
    $processId = [int]$_.Id
    $processPath = $null
    try {
      $processPath = (
        Get-CimInstance -Class Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      ).ExecutablePath
    } catch {
      $processPath = $null
    }
    [PSCustomObject]@{
      pid = $processId
      processName = $_.ProcessName
      title = $_.MainWindowTitle
      windowId = [int64]$_.MainWindowHandle
      processPath = $processPath
    }
  }
$windows | ConvertTo-Json -Compress
`,
    5_000,
  ).catch(() => []);

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): TopLevelWindowCandidate[] => {
    const pid = typeof entry?.pid === "number" ? entry.pid : Number(entry?.pid);
    const title = typeof entry?.title === "string" ? entry.title : "";
    if (!Number.isFinite(pid) || pid <= 0 || title.trim().length === 0) {
      return [];
    }
    const processPath =
      typeof entry?.processPath === "string" && entry.processPath.trim().length > 0
        ? entry.processPath
        : undefined;
    const windowId =
      typeof entry?.windowId === "number" ? entry.windowId : Number(entry?.windowId);
    return [
      {
        pid,
        processName: typeof entry?.processName === "string" ? entry.processName : "",
        title,
        ...(processPath ? { processPath } : {}),
        ...(Number.isFinite(windowId) && windowId > 0 ? { windowId } : {}),
      },
    ];
  });
}

function matchesInstalledAppWindow(installedAppName: string, candidate: TopLevelWindowCandidate): boolean {
  const installed = normalizeAppName(installedAppName);
  const title = normalizeAppName(candidate.title);
  const processName = normalizeAppName(candidate.processName);
  const processPath = normalizeAppName(candidate.processPath ?? "");
  const installedTokens = installedAppNameCandidates(installed);

  if (processPath && installed && processPath.includes(installed)) {
    return true;
  }
  if (processName && installed && processName.includes(installed)) {
    return true;
  }
  if (title && installed && (title.includes(installed) || installed.includes(title))) {
    return true;
  }
  const candidateTokens = [title, processName, processPath].filter(Boolean);
  if (
    installedTokens.some((token) =>
      candidateTokens.some(
        (candidateToken) => candidateToken.includes(token) || token.includes(candidateToken),
      ),
    )
  ) {
    return true;
  }
  return false;
}

function installedAppMatchesLaunchLikeValue(
  installed: InstalledWindowsApp,
  value: string | undefined,
): boolean {
  const normalizedInstalledId = normalizeAppName(installed.appId);
  const normalizedValue = normalizeAppName(value ?? "");
  if (!normalizedInstalledId || !normalizedValue) return false;
  return (
    normalizedValue.includes(normalizedInstalledId) ||
    normalizedInstalledId.includes(normalizedValue) ||
    installedAppNameCandidates(installed.appId).some(
      (token) => normalizedValue.includes(token) || token.includes(normalizedValue),
    )
  );
}

function findInstalledAppForRunningApp(
  app: HelperApp,
  windows: ReadonlyArray<HelperWindow>,
  installedApps: ReadonlyArray<InstalledWindowsApp>,
  topLevelWindows: ReadonlyArray<TopLevelWindowCandidate>,
): InstalledWindowsApp | undefined {
  const exactName = installedApps.find(
    (installed) => normalizeAppName(installed.name) === normalizeAppName(app.appName),
  );
  if (exactName) return exactName;

  const topLevelForProcess = topLevelWindows.filter((candidate) => candidate.pid === app.pid);
  const byTopLevelIdentity = installedApps.find((installed) =>
    topLevelForProcess.some((candidate) => topLevelWindowMatchesInstalledApp(installed, candidate)),
  );
  if (byTopLevelIdentity) return byTopLevelIdentity;

  const byBundleId = installedApps.find((installed) =>
    installedAppMatchesLaunchLikeValue(installed, app.bundleId),
  );
  if (byBundleId) return byBundleId;

  return installedApps.find((installed) =>
    windows.some((window) =>
      matchesInstalledAppWindow(installed.name, {
        pid: app.pid,
        processName: app.appName,
        title: window.title,
        ...(typeof window.windowId === "number" ? { windowId: window.windowId } : {}),
      }),
    ),
  );
}

function installedAppNameCandidates(launchId: string): ReadonlyArray<string> {
  const normalizedLaunchId = normalizeAppName(launchId);
  if (!normalizedLaunchId) return [];
  const [packageFamily] = launchId.split("!");
  const appToken = packageFamily ?? "";
  const candidates = new Set<string>([
    normalizeAppName(appToken),
    normalizeAppName(launchId),
    normalizedLaunchId,
  ]);
  candidates.delete("");
  return [...candidates];
}

function topLevelWindowMatchesInstalledApp(
  installedApp: InstalledWindowsApp,
  candidate: TopLevelWindowCandidate,
): boolean {
  if (matchesInstalledAppWindow(installedApp.name, candidate)) {
    return true;
  }
  const candidateWindowTitle = normalizeAppName(candidate.title);
  const processName = normalizeAppName(candidate.processName);
  const processPath = normalizeAppName(candidate.processPath ?? "");
  const candidateTokens: string[] = [];
  for (const token of [processName, processPath, candidateWindowTitle]) {
    if (!token) continue;
    candidateTokens.push(token);
    candidateTokens.push(...installedAppNameCandidates(token));
  }
  return installedAppNameCandidates(installedApp.appId).some((token) =>
    candidateTokens.some((candidateToken) =>
      candidateToken.includes(token) || token.includes(candidateToken),
    ),
  );
}

function topLevelWindowMatchesRequest(
  appName: string,
  launchId: string | undefined,
  candidate: TopLevelWindowCandidate,
): boolean {
  const normalizedAppName = normalizeAppName(appName);
  const requestTokens = [
    ...installedAppNameCandidates(launchId ?? ""),
    ...installedAppNameCandidates(normalizedAppName),
    ...(launchId ? [normalizeAppName(launchId)] : []),
  ].filter(Boolean);
  const normalizedTitle = normalizeAppName(candidate.title);
  const normalizedPath = normalizeAppName(candidate.processPath ?? "");
  const normalizedProcess = normalizeAppName(candidate.processName);
  const processIdText = String(candidate.pid);
  const candidateTokens = [normalizedTitle, normalizedPath, normalizedProcess, processIdText].filter(
    Boolean,
  );

  return requestTokens.some(
    (requestToken) =>
      requestToken.length > 0 &&
      candidateTokens.some(
        (candidateToken) =>
          candidateToken.includes(requestToken) || requestToken.includes(candidateToken),
      ),
  );
}

function bestTopLevelWindowMatch(
  topLevelWindows: ReadonlyArray<TopLevelWindowCandidate>,
  appName: string,
  launchId?: string,
): TopLevelWindowCandidate | undefined {
  const normalizedAppName = normalizeAppName(appName);
  if (!normalizedAppName && !launchId) {
    return undefined;
  }
  const directLaunchMatch = topLevelWindows.find((candidate) => {
    const launchPathMatch = installedAppNameCandidates(launchId ?? "")
      .map(normalizeAppName)
      .some((token) => token && normalizeAppName(candidate.processPath ?? "").includes(token));
    return launchPathMatch;
  });
  if (directLaunchMatch) return directLaunchMatch;
  return topLevelWindows.find((candidate) =>
    topLevelWindowMatchesRequest(normalizedAppName, launchId, candidate),
  );
}

function findAttachedSummaryForWindow(
  appsResult: ComputerUseListAppsResult,
  topLevelWindow: TopLevelWindowCandidate | undefined,
): ComputerUseAppSummary | undefined {
  if (!topLevelWindow) return undefined;
  return appsResult.apps.find(
    (app) => app.pid === topLevelWindow.pid && app.windows.some(isAttachableWindow),
  );
}

function appSummaryMatchesRequest(
  app: ComputerUseAppSummary,
  appName: string,
  launchId?: string,
): boolean {
  if (launchId && app.launchId === launchId) {
    return true;
  }
  const appMatchName = normalizeAppName(appName);
  const runningName = normalizeAppName(app.name);
  if (!appMatchName) {
    return false;
  }
  if (runningName && (runningName === appMatchName || runningName.includes(appMatchName))) {
    return true;
  }
  return installedAppNameCandidates(appMatchName).some((token) =>
    normalizeAppName(app.appId).includes(token) || token.includes(normalizeAppName(app.appId)),
  );
}

async function canAttachToPid(
  pid: number,
  width?: number,
  height?: number,
): Promise<boolean> {
  const app = {
    appName: "DesktopApp",
    pid,
  };
  const windows = await listWindowsForApp(app);
  const window = windows.find((candidate) => isAttachableWindow(toWindowSummary(candidate)));
  if (!window) {
    return false;
  }
  await focusAndResizeComputerUseWindow({ pid, windowId: window.windowId, width, height });
  return true;
}

function findTopLevelWindowForApp(
  topLevelWindows: ReadonlyArray<TopLevelWindowCandidate>,
  appName: string,
  launchId?: string,
): TopLevelWindowCandidate | undefined {
  return bestTopLevelWindowMatch(topLevelWindows, appName, launchId);
}

function findReusableRunningWindow(
  appsResult: ComputerUseListAppsResult | null,
  topLevelWindows: ReadonlyArray<TopLevelWindowCandidate>,
  appName: string,
  launchId?: string,
): ComputerUseAppSummary | null {
  const existing = appsResult?.apps.find((app) => appSummaryMatchesRequest(app, appName, launchId));
  if (existing && existing.windows.some(isAttachableWindow)) {
    return existing;
  }
  const topLevelMatch = findTopLevelWindowForApp(topLevelWindows, appName, launchId);
  const byWindow = topLevelMatch && appsResult ? findAttachedSummaryForWindow(appsResult, topLevelMatch) : null;
  if (!byWindow) {
    return null;
  }
  return byWindow;
}

function findReusableRunningWindowByTopLevelWindow(
  topLevelWindows: ReadonlyArray<TopLevelWindowCandidate>,
  launchId?: string,
  appName?: string,
): TopLevelWindowCandidate | null {
  if (!topLevelWindows.length) {
    return null;
  }
  if (!appName && !launchId) {
    return null;
  }

  const normalizedAppName = normalizeAppName(appName ?? "");
  const normalizedLaunchId = normalizeAppName(launchId ?? "");
  const tokens = new Set<string>(
    [...installedAppNameCandidates(normalizedAppName), ...installedAppNameCandidates(normalizedLaunchId)]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  if (!tokens.size) {
    return null;
  }

  const directWindowMatch = topLevelWindows.find((candidate) =>
    [...tokens].some((token) =>
      [candidate.title, candidate.processName, candidate.processPath ?? "", String(candidate.pid)]
        .map((value) => normalizeAppName(value))
        .filter((value) => value.length > 0)
        .some((candidateToken) => candidateToken.includes(token) || token.includes(candidateToken)),
    ),
  );
  if (directWindowMatch) {
    return directWindowMatch;
  }

  return findTopLevelWindowForApp(topLevelWindows, normalizedAppName, launchId) ?? null;
}

async function listWindowsForApp(app: HelperApp): Promise<HelperWindow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const result = await executeListAppWindows(
      `list_windows_${app.pid}`,
      { pid: app.pid },
      controller.signal,
      undefined,
      NON_INTERACTIVE_CONTEXT,
    );
    return result.details.windows;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function isAttachableHelperWindow(window: HelperWindow): boolean {
  return window.windowId !== undefined && window.windowId > 0 && window.isOnscreen && !window.isMinimized;
}

function chooseWindowCandidate(
  windows: ReadonlyArray<HelperWindow>,
  input: {
    readonly windowId?: number;
    readonly windowTitle?: string;
  },
  preferFocused = true,
): HelperWindow | undefined {
  const candidateWindowId = input.windowId;
  if (candidateWindowId && candidateWindowId > 0) {
    const exactWindow = windows.find((window) => window.windowId === candidateWindowId);
    if (exactWindow) return exactWindow;
  }

  const normalizedTitle =
    input.windowTitle ? normalizeAppName(input.windowTitle) : "";
  if (normalizedTitle) {
    const exactMatches = windows.filter(
      (window) => normalizeAppName(window.title) === normalizedTitle,
    );
    if (exactMatches.length > 0) {
      return exactMatches[0];
    }

    const partialMatches = windows.filter((window) =>
      normalizeAppName(window.title).includes(normalizedTitle),
    );
    if (partialMatches.length > 0) {
      return partialMatches[0];
    }
  }

  const attachable = windows.filter(isAttachableHelperWindow);
  const candidates = attachable.length > 0 ? attachable : windows;
  if (candidates.length === 0) return undefined;

  if (preferFocused) {
    return (
      candidates.find((window) => window.isFocused) ??
      candidates.find((window) => window.isMain) ??
      candidates[0]
    );
  }

  return candidates[0];
}

function boundedWindowFromSummary(
  app: {
    appName: string;
    launchId: string;
    pid: number;
  },
  window: HelperWindow,
): BoundedComputerUseWindow {
  const windowId = window.windowId;
  return {
    appName: app.appName,
    launchId: app.launchId,
    pid: app.pid,
    windowId: typeof windowId === "number" && Number.isFinite(windowId) ? Math.trunc(windowId) : 0,
    windowTitle: window.title.length > 0 ? window.title : "(untitled)",
    isFocused: window.isFocused,
    isMinimized: window.isMinimized,
    isOnscreen: window.isOnscreen,
    isMain: window.isMain,
    x: window.framePoints.x,
    y: window.framePoints.y,
    width: window.framePoints.w,
    height: window.framePoints.h,
  };
}

function managedWindowFromBounded(
  bounded: BoundedComputerUseWindow | null,
): ManagedComputerUseWindowResult | null {
  if (!bounded || bounded.windowId <= 0) {
    return null;
  }
  return {
    appName: bounded.appName,
    launchId: bounded.launchId,
    pid: bounded.pid,
    windowId: bounded.windowId,
    windowTitle: bounded.windowTitle,
    focused: bounded.isFocused,
  };
}

async function findBoundedWindowForPid(
  pid: number,
  input: Pick<ComputerUseWindowQuery, "windowId" | "windowTitle">,
): Promise<BoundedComputerUseWindow | null> {
  if (!pid || pid <= 0) return null;
  const appWindows = await listWindowsForApp({ appName: "Application", pid });
  if (!appWindows.length) return null;
  const window = chooseWindowCandidate(appWindows, input);
  if (!window || window.windowId === undefined || window.windowId <= 0) {
    return null;
  }

  const apps = await listComputerUseApps().catch(() => null);
  const app = apps?.apps.find((candidate) => candidate.pid === pid);
  const appName = app?.name ?? `Process ${pid}`;
  const launchId = app?.launchId ?? `win32:${pid}`;
  return boundedWindowFromSummary(
    { appName, launchId, pid },
    window,
  );
}

async function findBoundedWindowForQuery(
  input: ComputerUseWindowQuery,
): Promise<BoundedComputerUseWindow | null> {
  if (input.pid && input.pid > 0) {
    return findBoundedWindowForPid(input.pid, input);
  }

  const topLevelWindows = await listTopLevelWindows().catch(() => []);
  if (input.windowId && input.windowId > 0) {
    const byId = topLevelWindows.find((window) => window.windowId === input.windowId);
    if (byId) {
      return findBoundedWindowForPid(byId.pid, input);
    }
  }

  if (!input.appName && !input.launchId && !input.windowTitle) {
    return null;
  }

  const appResult = await listComputerUseApps();
  const byRequest = appResult.apps.find((app) =>
    appSummaryMatchesRequest(app, input.appName ?? "", input.launchId),
  );
  if (byRequest) {
    const requestWindows = await listWindowsForApp({
      appName: byRequest.name,
      pid: byRequest.pid,
    });
    const requestWindow = chooseWindowCandidate(requestWindows, input);
    if (requestWindow?.windowId && requestWindow.windowId > 0) {
      return boundedWindowFromSummary(
        {
          appName: byRequest.name,
          launchId: byRequest.launchId ?? `win32:${byRequest.pid}`,
          pid: byRequest.pid,
        },
        requestWindow,
      );
    }
  }

  if (!input.appName && !input.launchId) {
    return null;
  }

  const topLevelMatch = findReusableRunningWindowByTopLevelWindow(
    topLevelWindows,
    input.launchId,
    input.appName,
  );
  if (topLevelMatch?.pid) {
    return findBoundedWindowForPid(topLevelMatch.pid, input);
  }

  return null;
}

export async function resolveComputerUseWindow(input: {
  appName?: string;
  launchId?: string;
  pid?: number;
  windowId?: number;
  windowTitle?: string;
}): Promise<ManagedComputerUseWindowResult | null> {
  const window = await findBoundedWindowForQuery(input);
  return managedWindowFromBounded(window);
}

export async function attachComputerUseWindow(
  input: ComputerUseWindowQuery & {
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly focus?: boolean | undefined;
  },
): Promise<ManagedComputerUseWindowResult> {
  const managed = await resolveComputerUseWindow(input);
  if (!managed) {
    throw new Error("Could not resolve a target desktop window to attach.");
  }
  await focusAndResizeComputerUseWindow({
    pid: managed.pid,
    windowId: managed.windowId,
    focus: input.focus ?? false,
    width: input.width,
    height: input.height,
    x: input.x,
    y: input.y,
  });
  return managed;
}

export async function focusComputerUseWindow(
  input: ComputerUseWindowQuery,
): Promise<ManagedComputerUseWindowResult> {
  return attachComputerUseWindow({
    ...input,
    focus: true,
  });
}

export async function moveComputerUseWindow(
  input: ComputerUseWindowQuery & { readonly x: number; readonly y: number },
): Promise<ManagedComputerUseWindowResult> {
  const managed = await attachComputerUseWindow(input);
  await focusAndResizeComputerUseWindow({
    pid: managed.pid,
    windowId: managed.windowId,
    x: input.x,
    y: input.y,
    focus: false,
  });
  return managed;
}

export async function resizeComputerUseWindow(
  input: ComputerUseWindowQuery & { readonly width: number; readonly height: number },
): Promise<ManagedComputerUseWindowResult> {
  const managed = await attachComputerUseWindow(input);
  await focusAndResizeComputerUseWindow({
    pid: managed.pid,
    windowId: managed.windowId,
    width: input.width,
    height: input.height,
    focus: false,
  });
  return managed;
}

async function closeWindowByHandle(input: { readonly pid: number; readonly windowId?: number }): Promise<void> {
  const command = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  await runPowerShellJson(
    `
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellStringLiteral(command)})) | ConvertFrom-Json
$targetPid = [int]$payload.pid
$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
  @{ closed = $true; reason = 'not-running' } | ConvertTo-Json -Compress
  return
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class T3CloseWindowOps {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$hwnd = [IntPtr]::Zero
if ($payload.windowId -ne $null) {
  $candidateHwnd = [IntPtr]([int64]$payload.windowId)
  if ([T3CloseWindowOps]::IsWindow($candidateHwnd)) {
    $hwnd = $candidateHwnd
  }
}
if ($hwnd -ne [IntPtr]::Zero) {
  [void][T3CloseWindowOps]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
} elseif (-not $proc.CloseMainWindow()) {
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 350
if ($hwnd -ne [IntPtr]::Zero -and -not [T3CloseWindowOps]::IsWindow($hwnd)) {
  @{ closed = $true; reason = 'closed-window' } | ConvertTo-Json -Compress
  return
}
if ($hwnd -eq [IntPtr]::Zero -and (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 220
}
if ($hwnd -ne [IntPtr]::Zero -and [T3CloseWindowOps]::IsWindow($hwnd)) {
  throw "Unable to close window $($payload.windowId)"
}
$stillRunning = if ($hwnd -eq [IntPtr]::Zero) { Get-Process -Id $targetPid -ErrorAction SilentlyContinue } else { $null }
if ($stillRunning) {
  throw "Unable to close process $targetPid"
}
@{ closed = $true; reason = 'closed' } | ConvertTo-Json -Compress
`,
    6_000,
  ).catch(() => undefined);
}

export async function closeComputerUseWindow(
  input: ComputerUseWindowQuery,
): Promise<ManagedComputerUseWindowResult> {
  const managed = await attachComputerUseWindow(input);
  await closeWindowByHandle({ pid: managed.pid, windowId: managed.windowId });
  return managed;
}

export async function getActiveComputerUseWindow(): Promise<ManagedComputerUseWindowResult | null> {
  const appsResult = await listComputerUseApps();
  const activeApp = appsResult.apps.find((app) => app.isFrontmost) ?? appsResult.apps[0];
  if (!activeApp) return null;
  return resolveComputerUseWindow({
    appName: activeApp.name,
    ...(activeApp.launchId ? { launchId: activeApp.launchId } : {}),
    pid: activeApp.pid,
  });
}

export async function getComputerUseWindowBounds(input: {
  readonly appName?: string;
  readonly launchId?: string;
  readonly pid?: number;
  readonly windowId?: number;
  readonly windowTitle?: string;
}): Promise<BoundedComputerUseWindow | null> {
  return findBoundedWindowForQuery(input);
}

export async function listComputerUseApps(input: {
  readonly iconBaseUrl?: string | undefined;
} = {}): Promise<ComputerUseListAppsResult> {
  let result: Awaited<ReturnType<typeof executeListRunningApps>>;
  try {
    result = await executeListRunningApps(
      "list_apps",
      {},
      undefined,
      undefined,
      NON_INTERACTIVE_CONTEXT,
    );
  } catch (error) {
    return unavailableResult(error);
  }
  const installedApps = await listInstalledWindowsApps().catch(() => []);
  const topLevelWindows = await listTopLevelWindows().catch(() => []);
  const appsByName = new Map<string, ComputerUseAppSummary>();
  for (const app of result.details.apps.slice(0, 24)) {
    const windows = await listWindowsForApp(app);
    const installedMatch = findInstalledAppForRunningApp(
      app,
      windows,
      installedApps,
      topLevelWindows,
    );
    const summary = {
      appId: appIdFor(app),
      name: installedMatch?.name ?? app.appName,
      pid: app.pid,
      isRunning: true,
      isFrontmost: app.isFrontmost,
      category: classifyComputerUseApp({
        name: installedMatch?.name ?? app.appName,
        appId: appIdFor(app),
        launchId: installedMatch?.appId,
        isRunning: true,
        windowCount: windows.length,
      }),
      ...(installedMatch?.appId ? { launchId: installedMatch.appId } : {}),
      iconUrl: computerUseAppIconUrl({
        iconBaseUrl: input.iconBaseUrl,
        name: installedMatch?.name ?? app.appName,
        pid: app.pid,
        launchId: installedMatch?.appId,
      }),
      windows: windows.map(toWindowSummary),
    } satisfies ComputerUseAppSummary;
    appsByName.set(normalizeAppName(app.appName), summary);
    if (installedMatch) {
      appsByName.set(normalizeAppName(installedMatch.name), summary);
    }
  }
  for (const installed of installedApps) {
    const key = normalizeAppName(installed.name);
    const existing = appsByName.get(key);
    if (existing) {
      appsByName.set(key, {
        ...existing,
        name: installed.name,
        launchId: installed.appId,
      });
      continue;
    }
    const topLevelWindow = topLevelWindows.find((candidate) =>
      topLevelWindowMatchesInstalledApp(installed, candidate),
    );
    if (topLevelWindow) {
      const windows = await listWindowsForApp({
        appName: installed.name,
        pid: topLevelWindow.pid,
      });
      appsByName.set(key, {
        appId: appCatalogIdForLaunchId(installed.appId),
        name: installed.name,
        pid: topLevelWindow.pid,
        isRunning: true,
        category: classifyComputerUseApp({
          name: installed.name,
          appId: appCatalogIdForLaunchId(installed.appId),
          launchId: installed.appId,
          isRunning: true,
          windowCount: windows.length,
        }),
        launchId: installed.appId,
        iconUrl: computerUseAppIconUrl({
          iconBaseUrl: input.iconBaseUrl,
          name: installed.name,
          pid: topLevelWindow.pid,
          launchId: installed.appId,
        }),
        windows: windows.map(toWindowSummary),
      });
      continue;
    }
    appsByName.set(key, {
      appId: appCatalogIdForLaunchId(installed.appId),
      name: installed.name,
      pid: 0,
      isRunning: false,
      category: classifyComputerUseApp({
        name: installed.name,
        appId: appCatalogIdForLaunchId(installed.appId),
        launchId: installed.appId,
        isRunning: false,
        windowCount: 0,
      }),
      launchId: installed.appId,
      iconUrl: computerUseAppIconUrl({
        iconBaseUrl: input.iconBaseUrl,
        name: installed.name,
        pid: 0,
        launchId: installed.appId,
      }),
      windows: [],
    });
  }
  const appsByIdentity = new Map<string, ComputerUseAppSummary>();
  for (const app of appsByName.values()) {
    const windowIds = app.windows
      .map((window) => window.windowId)
      .filter((windowId): windowId is number => typeof windowId === "number" && windowId > 0)
      .toSorted((left, right) => left - right)
      .join(",");
    const key = [
      app.launchId ? normalizeAppName(app.launchId) : normalizeAppName(app.name),
      app.pid,
      windowIds,
    ].join(":");
    if (!appsByIdentity.has(key)) {
      appsByIdentity.set(key, app);
    }
  }
  const apps = [...appsByIdentity.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  return { apps, status: { available: true } };
}
