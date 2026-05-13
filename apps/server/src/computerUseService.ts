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

export const COMPUTER_USE_APP_ICON_ROUTE_PATH = "/computer-use/app-icon";

const appIconCache = new Map<string, Buffer | null>();

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
}): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Launching installed apps is currently implemented for Windows only.");
  }
  const launchId =
    input.launchId?.trim() ||
    (await listInstalledWindowsApps()).find(
      (app) => normalizeAppName(app.name) === normalizeAppName(input.appName ?? ""),
    )?.appId;
  if (!launchId) {
    throw new Error(`Unable to find installed app '${input.appName ?? ""}'.`);
  }
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
  const appsByName = new Map<string, ComputerUseAppSummary>();
  for (const app of result.details.apps.slice(0, 24)) {
    const windows = await listWindowsForApp(app);
    const installedMatch = installedApps.find(
      (installed) => normalizeAppName(installed.name) === normalizeAppName(app.appName),
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
  const apps = [...appsByName.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  return { apps, status: { available: true } };
}
