import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function resolveSiblingRuntimePath(baseName: string): string {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = Path.dirname(modulePath);
  const candidates = [
    Path.join(moduleDir, `${baseName}.mjs`),
    Path.join(moduleDir, "..", "dist", `${baseName}.mjs`),
    Path.join(moduleDir, `${baseName}.ts`),
  ];
  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }
  return Path.join(moduleDir, `${baseName}.ts`);
}

function resolveBrowserMcpServerPath(): string {
  return resolveSiblingRuntimePath("browserMcpServer");
}

function resolveComputerMcpServerPath(): string {
  return resolveSiblingRuntimePath("computerMcpServer");
}

function runtimeCommandForMcpServer(serverPath: string): string {
  const runtimeName = Path.basename(process.execPath).toLowerCase();
  if (serverPath.endsWith(".mjs") && runtimeName.startsWith("bun")) {
    return resolveNodeCommand();
  }
  return process.execPath;
}

function resolveNodeCommand(): string {
  const currentRuntimeName = Path.basename(process.execPath).toLowerCase();
  if (currentRuntimeName === "node.exe" || currentRuntimeName === "node") {
    return process.execPath;
  }

  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  const pathExts = process.platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node"];
  for (const dir of pathValue.split(Path.delimiter)) {
    const trimmedDir = dir.trim();
    if (!trimmedDir) {
      continue;
    }
    for (const executableName of pathExts) {
      const candidate = Path.join(trimmedDir, executableName);
      if (FS.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const windowsCandidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
  ];
  for (const candidate of windowsCandidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return "node";
}

function resolveBaseCodexHome(preferredHomePath?: string): string {
  const normalizedPreferred = preferredHomePath?.trim();
  if (normalizedPreferred) {
    return normalizedPreferred;
  }
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    return envHome;
  }
  return Path.join(OS.homedir(), ".codex");
}

function isInsideCodexPluginCacheLatest(srcPath: string, baseHomePath: string): boolean {
  const relativePath = Path.relative(baseHomePath, srcPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${Path.sep}`) ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    Path.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return (
    segments.length >= 4 &&
    segments[0] === "plugins" &&
    segments[1] === "cache" &&
    segments[segments.length - 1] === "latest"
  );
}

const CODEX_HOME_VOLATILE_ROOT_ENTRIES = new Set([
  ".sandbox",
  ".sandbox-bin",
  ".sandbox-secrets",
  ".tmp",
  "archived_sessions",
  "browser",
  "cache",
  "chats",
  "generated_images",
  "log",
  "logs",
  "memories",
  "node_repl",
  "pets",
  "sessions",
  "sqlite",
  "tmp",
  "vendor_imports",
  "worktrees",
]);

const CODEX_HOME_VOLATILE_ROOT_FILE_PATTERNS = [
  /^\.*codex-global-state\.json(?:\..*)?$/i,
  /^cap_sid$/i,
  /^history\.jsonl$/i,
  /^installation_id$/i,
  /^logs(?:_\d+)?\.sqlite(?:-(?:shm|wal))?$/i,
  /^models_cache\.json$/i,
  /^sandbox\.log$/i,
  /^session_index\.jsonl$/i,
  /^state(?:_\d+)?\.sqlite(?:-(?:shm|wal))?$/i,
  /^transcription-history\.jsonl$/i,
  /^version\.json$/i,
];

function isVolatileCodexHomeEntry(srcPath: string, baseHomePath: string): boolean {
  const relativePath = Path.relative(baseHomePath, srcPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${Path.sep}`) ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    Path.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split(/[\\/]+/);
  const rootSegment = segments[0]?.toLowerCase();
  if (!rootSegment) {
    return false;
  }
  if (CODEX_HOME_VOLATILE_ROOT_ENTRIES.has(rootSegment)) {
    return true;
  }
  if (segments.length === 1) {
    return CODEX_HOME_VOLATILE_ROOT_FILE_PATTERNS.some((pattern) => pattern.test(segments[0]!));
  }
  return false;
}

export function shouldCopyCodexHomeEntry(srcPath: string, baseHomePath: string): boolean {
  if (isVolatileCodexHomeEntry(srcPath, baseHomePath)) {
    return false;
  }
  if (isInsideCodexPluginCacheLatest(srcPath, baseHomePath)) {
    return false;
  }
  try {
    return !FS.lstatSync(srcPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyCodexHomeEntry(srcPath: string, destPath: string, baseHomePath: string): void {
  if (!shouldCopyCodexHomeEntry(srcPath, baseHomePath)) {
    return;
  }

  const stat = FS.lstatSync(srcPath);
  if (stat.isDirectory()) {
    FS.mkdirSync(destPath, { recursive: true });
    for (const entry of FS.readdirSync(srcPath)) {
      copyCodexHomeEntry(Path.join(srcPath, entry), Path.join(destPath, entry), baseHomePath);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  FS.mkdirSync(Path.dirname(destPath), { recursive: true });
  FS.copyFileSync(srcPath, destPath);
}

function buildBrowserMcpBlock(input: {
  bridgeUrl: string;
  bridgeToken: string;
  projectId: ProjectId;
  threadId: ThreadId;
}): string {
  return [
    "",
    "[mcp_servers.t3_browser]",
    `command = "${escapeTomlString(process.execPath)}"`,
    `args = ["${escapeTomlString(resolveBrowserMcpServerPath())}"]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    "[mcp_servers.t3_browser.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    `T3_BROWSER_BRIDGE_URL = "${escapeTomlString(input.bridgeUrl)}"`,
    `T3_BROWSER_BRIDGE_TOKEN = "${escapeTomlString(input.bridgeToken)}"`,
    `T3_BROWSER_PROJECT_ID = "${escapeTomlString(String(input.projectId))}"`,
    `T3_BROWSER_THREAD_ID = "${escapeTomlString(String(input.threadId))}"`,
    "",
  ].join("\n");
}

function buildComputerMcpBlock(input: {
  projectId: ProjectId;
  threadId: ThreadId;
  stateDir: string;
}): string {
  const serverPath = resolveComputerMcpServerPath();
  return [
    "",
    "[mcp_servers.t3_computer]",
    `command = "${escapeTomlString(runtimeCommandForMcpServer(serverPath))}"`,
    `args = ["${escapeTomlString(serverPath)}"]`,
    `cwd = "${escapeTomlString(process.cwd())}"`,
    "required = true",
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 120",
    "[mcp_servers.t3_computer.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    `T3CODE_STATE_DIR = "${escapeTomlString(input.stateDir)}"`,
    `T3_COMPUTER_PROJECT_ID = "${escapeTomlString(String(input.projectId))}"`,
    `T3_COMPUTER_THREAD_ID = "${escapeTomlString(String(input.threadId))}"`,
    "",
  ].join("\n");
}

export interface CodexHomeOverlayInput {
  threadId: ThreadId;
  projectId: ProjectId;
  runtimeMode: RuntimeMode;
  stateDir: string;
  preferredHomePath?: string | undefined;
  bridgeUrl?: string | undefined;
  bridgeToken?: string | undefined;
}

export function createCodexHomeOverlay(input: CodexHomeOverlayInput): string | undefined {
  const bridgeUrl = input.bridgeUrl?.trim();
  const bridgeToken = input.bridgeToken?.trim();
  const includeBrowserMcp = input.runtimeMode === "full-access" && Boolean(bridgeUrl && bridgeToken);

  const baseHomePath = resolveBaseCodexHome(input.preferredHomePath);
  const overlayDir = Path.join(
    input.stateDir,
    "codex-home-overlays",
    `${sanitizeSegment(String(input.threadId))}-${Date.now()}`,
  );
  FS.mkdirSync(overlayDir, { recursive: true });

  if (FS.existsSync(baseHomePath)) {
    copyCodexHomeEntry(baseHomePath, overlayDir, baseHomePath);
  }

  const configPath = Path.join(overlayDir, "config.toml");
  const existingConfig = FS.existsSync(configPath) ? FS.readFileSync(configPath, "utf8") : "";
  const nextConfig = `${existingConfig.trimEnd()}${
    includeBrowserMcp
      ? buildBrowserMcpBlock({
          bridgeUrl: bridgeUrl!,
          bridgeToken: bridgeToken!,
          projectId: input.projectId,
          threadId: input.threadId,
        })
      : ""
  }${buildComputerMcpBlock({
    projectId: input.projectId,
    threadId: input.threadId,
    stateDir: input.stateDir,
  })}`;
  FS.writeFileSync(configPath, nextConfig, "utf8");
  return overlayDir;
}
