import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalListInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionMetadata,
  TerminalWriteInput,
  type TerminalEvent,
  type TerminalListResult,
  type TerminalSessionSummary,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect, Encoding, Layer, Path, Schema } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { runProcess } from "../../processRunner";
import { ServerConfig } from "../../config";
import {
  ShellCandidate,
  TerminalError,
  TerminalManager,
  TerminalManagerShape,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const DEFAULT_RECENT_OUTPUT_LINE_LIMIT = 160;
const DEFAULT_RECENT_OUTPUT_CHAR_LIMIT = 24_000;
const DEFAULT_EXTERNAL_SERVER_SCAN_TIMEOUT_MS = 6_000;
const DEFAULT_EXTERNAL_SERVER_METADATA_TIMEOUT_MS = 5_000;
const DEFAULT_EXTERNAL_SERVER_SCAN_BUFFER_BYTES = 2_000_000;
const EXTERNAL_SERVER_CACHE_TTL_MS = 5_000;
const EXTERNAL_SERVER_MISSING_GRACE_MS = 30_000;
const EXTERNAL_TERMINAL_ID_PREFIX = "external:";
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);
const decodeTerminalListInput = Schema.decodeUnknownSync(TerminalListInput);
const decodeTerminalSessionMetadata = Schema.decodeUnknownSync(TerminalSessionMetadata);

type TerminalSubprocessChecker = (terminalPid: number) => Promise<boolean>;

interface ExternalServerFilter {
  projectRoot?: string;
  cwd?: string;
}

interface ExternalServerDescriptor {
  pid: number;
  port: number;
  address: string;
  name: string | null;
  commandLine: string | null;
  parentCommandLine?: string | null;
  parentPid: number | null;
  createdAt: string | null;
}

type ExternalServerDiscoverer = (
  filter: ExternalServerFilter,
) => Promise<ExternalServerDescriptor[]>;
type ExternalProcessKiller = (pid: number) => Promise<void>;

interface ExternalServerCacheEntry {
  servers: ExternalServerDescriptor[];
  updatedAtMs: number;
  refreshPromise: Promise<ExternalServerDescriptor[]> | null;
  missingSinceByKey: Map<string, number>;
}

interface WindowsTcpListener {
  pid: number;
  port: number;
  address: string;
}

interface WindowsProcessMetadata {
  processId: number;
  parentProcessId: number | null;
  name: string | null;
  commandLine: string | null;
  createdAt: string | null;
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const quotedMatch = /^"([^"]+)"|^'([^']+)'/.exec(trimmed);
  if (quotedMatch) {
    return (quotedMatch[1] ?? quotedMatch[2] ?? "").trim() || null;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

async function checkWindowsSubprocessActivity(terminalPid: number): Promise<boolean> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function checkPosixSubprocessActivity(terminalPid: number): Promise<boolean> {
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 0) {
      return pgrepResult.stdout.trim().length > 0;
    }
    if (pgrepResult.code === 1) {
      return false;
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return false;
    }

    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (ppid === terminalPid) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function defaultSubprocessChecker(terminalPid: number): Promise<boolean> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return checkWindowsSubprocessActivity(terminalPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function tailTerminalOutput(history: string): string {
  if (history.length === 0) return history;
  const lines = history.split(/\r?\n/g);
  const recentLines = lines.slice(Math.max(0, lines.length - DEFAULT_RECENT_OUTPUT_LINE_LIMIT));
  const recent = recentLines.join("\n");
  if (recent.length <= DEFAULT_RECENT_OUTPUT_CHAR_LIMIT) {
    return recent;
  }
  return recent.slice(recent.length - DEFAULT_RECENT_OUTPUT_CHAR_LIMIT);
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function pathContains(parent: string, child: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function normalizeTerminalMetadata(
  metadata: TerminalSessionMetadata | undefined,
  runtimeEnv: Record<string, string> | undefined,
): TerminalSessionMetadata | null {
  const candidate = {
    ...(runtimeEnv?.T3CODE_PROJECT_ROOT ? { projectRoot: runtimeEnv.T3CODE_PROJECT_ROOT } : {}),
    ...metadata,
  };
  if (Object.keys(candidate).length === 0) {
    return null;
  }
  return decodeTerminalSessionMetadata(candidate);
}

function encodePowershellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeProjectRootForMatch(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function parseJsonArrayOrObject<T>(value: string): T[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeExternalServerAddress(address: string, port: number): string {
  const normalizedAddress = address.trim();
  if (
    normalizedAddress === "127.0.0.1" ||
    normalizedAddress === "::1" ||
    normalizedAddress === "[::1]" ||
    normalizedAddress === "0.0.0.0" ||
    normalizedAddress === "::" ||
    normalizedAddress === "[::]"
  ) {
    return `localhost:${port}`;
  }
  return `${normalizedAddress}:${port}`;
}

function findNearestGitRoot(value: string): string | null {
  let current = path.resolve(value);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function projectRootCandidatesForExternalDiscovery(filter: ExternalServerFilter): string[] {
  const candidates = new Set<string>();
  const values = [filter.projectRoot, filter.cwd].filter((value): value is string =>
    Boolean(value),
  );
  if (values.length === 0) {
    values.push(process.cwd());
  }

  for (const value of values) {
    candidates.add(normalizeProjectRootForMatch(value));
    const gitRoot = findNearestGitRoot(value);
    if (gitRoot) {
      candidates.add(normalizeProjectRootForMatch(gitRoot));
    }
  }
  return [...candidates];
}

function commandMatchesProjectRoot(
  commandLine: string | null,
  projectRoots: readonly string[],
): boolean {
  if (!commandLine) {
    return false;
  }
  const normalizedCommandLine = normalizeProjectRootForMatch(commandLine).replaceAll('"', "");
  return projectRoots.some((root) => {
    const normalizedRoot = normalizeProjectRootForMatch(root);
    const boundaryPattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedRoot)}(?:/|\\s|$)`, "i");
    return (
      normalizedCommandLine === normalizedRoot ||
      normalizedCommandLine.includes(`${normalizedRoot}/`) ||
      boundaryPattern.test(normalizedCommandLine)
    );
  });
}

function externalServerMatchesProjectRoot(
  server: ExternalServerDescriptor,
  projectRoots: readonly string[],
): boolean {
  return (
    commandMatchesProjectRoot(server.commandLine, projectRoots) ||
    commandMatchesProjectRoot(server.parentCommandLine ?? null, projectRoots)
  );
}

function externalServerCacheEntryKey(server: ExternalServerDescriptor): string {
  return `${String(server.pid)}:${String(server.port)}`;
}

function reconcileExternalServerCacheEntry(
  entry: ExternalServerCacheEntry,
  servers: ExternalServerDescriptor[],
  now: number,
): ExternalServerDescriptor[] {
  if (entry.servers.length === 0) {
    entry.missingSinceByKey.clear();
    return servers;
  }

  const discoveredByKey = new Map(
    servers.map((server) => [externalServerCacheEntryKey(server), server] as const),
  );
  for (const key of discoveredByKey.keys()) {
    entry.missingSinceByKey.delete(key);
  }

  const retainedServers: ExternalServerDescriptor[] = [];
  for (const server of entry.servers) {
    const key = externalServerCacheEntryKey(server);
    if (discoveredByKey.has(key)) {
      continue;
    }
    const missingSince = entry.missingSinceByKey.get(key) ?? now;
    entry.missingSinceByKey.set(key, missingSince);
    if (now - missingSince < EXTERNAL_SERVER_MISSING_GRACE_MS) {
      retainedServers.push(server);
      continue;
    }
    entry.missingSinceByKey.delete(key);
  }

  return [...servers, ...retainedServers];
}

function parseNetstatLocalAddress(value: string): { address: string; port: number } | null {
  const trimmed = value.trim();
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  if (bracketMatch?.[1] && bracketMatch[2]) {
    const port = Number(bracketMatch[2]);
    return Number.isInteger(port) && port > 0 ? { address: bracketMatch[1], port } : null;
  }

  const separatorIndex = trimmed.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const port = Number(trimmed.slice(separatorIndex + 1));
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  return { address: trimmed.slice(0, separatorIndex), port };
}

function isLocalListenAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "::"
  );
}

function parseNetstatTcpListeners(value: string): WindowsTcpListener[] {
  const listeners: WindowsTcpListener[] = [];
  const seenListeners = new Set<string>();
  for (const line of value.split(/\r?\n/g)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const localAddress = parseNetstatLocalAddress(match[1]);
    const pid = Number(match[2]);
    if (!localAddress || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (!isLocalListenAddress(localAddress.address)) {
      continue;
    }
    const listenerKey = `${String(pid)}:${String(localAddress.port)}`;
    if (seenListeners.has(listenerKey)) {
      continue;
    }
    seenListeners.add(listenerKey);
    listeners.push({ pid, port: localAddress.port, address: localAddress.address });
  }
  return listeners;
}

function extractRecentOutputPorts(value: string): Set<number> {
  const ports = new Set<number>();
  for (const match of value.matchAll(
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{2,5})/gi,
  )) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0) {
      ports.add(port);
    }
  }
  return ports;
}

async function discoverWindowsExternalServers(
  filter: ExternalServerFilter,
): Promise<ExternalServerDescriptor[]> {
  const projectRoots = projectRootCandidatesForExternalDiscovery(filter);
  if (projectRoots.length === 0) {
    return [];
  }

  const listeners = await discoverWindowsNetstatListeners();
  const processMetadata = await discoverWindowsProcessMetadata(
    listeners.map((listener) => listener.pid),
  );
  const descriptors = listeners.map((listener) => {
    const process = processMetadata.get(listener.pid) ?? null;
    const parent = process?.parentProcessId
      ? (processMetadata.get(process.parentProcessId) ?? null)
      : null;
    return {
      pid: listener.pid,
      port: listener.port,
      address: listener.address,
      name: process?.name ?? null,
      commandLine: process?.commandLine ?? null,
      parentCommandLine: parent?.commandLine ?? null,
      parentPid: process?.parentProcessId ?? null,
      createdAt: process?.createdAt ?? null,
    } satisfies ExternalServerDescriptor;
  });

  return descriptors.filter((server) => {
    if (server.commandLine || server.parentCommandLine) {
      return externalServerMatchesProjectRoot(server, projectRoots);
    }
    return false;
  });
}

async function discoverWindowsNetstatListeners(): Promise<WindowsTcpListener[]> {
  const result = await runProcess("netstat", ["-ano"], {
    timeoutMs: DEFAULT_EXTERNAL_SERVER_SCAN_TIMEOUT_MS,
    allowNonZeroExit: true,
    maxBufferBytes: DEFAULT_EXTERNAL_SERVER_SCAN_BUFFER_BYTES,
    outputMode: "truncate",
  }).catch(() => null);
  if (!result) {
    return [];
  }
  if (result.code !== 0) {
    return [];
  }
  return parseNetstatTcpListeners(result.stdout);
}

async function discoverWindowsProcessMetadata(
  processIds: readonly number[],
): Promise<Map<number, WindowsProcessMetadata>> {
  const filter = [...new Set(processIds)]
    .filter((processId) => Number.isInteger(processId) && processId > 0)
    .map((processId) => `ProcessId = ${String(processId)}`)
    .join(" OR ");
  if (filter.length === 0) {
    return new Map();
  }

  const command = [
    `$processes = @(Get-CimInstance Win32_Process -Filter '${filter}' -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -ErrorAction SilentlyContinue)`,
    "$parentIds = @($processes | Where-Object { $null -ne $_.ParentProcessId -and $_.ParentProcessId -gt 0 } | Select-Object -ExpandProperty ParentProcessId -Unique)",
    "$parents = @()",
    "if ($parentIds.Count -gt 0) {",
    "  $parentFilter = ($parentIds | ForEach-Object { \"ProcessId = $_\" }) -join \" OR \"",
    "  $parents = @(Get-CimInstance Win32_Process -Filter $parentFilter -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -ErrorAction SilentlyContinue)",
    "}",
    "@($processes + $parents) |",
    "  Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate |",
    "  ConvertTo-Json -Compress",
  ].join("\n");
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowershellCommand(command)],
    {
      timeoutMs: DEFAULT_EXTERNAL_SERVER_METADATA_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 512_000,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!result) {
    return new Map();
  }
  if (result.code !== 0) {
    return new Map();
  }

  const metadata = new Map<number, WindowsProcessMetadata>();
  for (const process of parseJsonArrayOrObject<{
    ProcessId?: unknown;
    ParentProcessId?: unknown;
    Name?: unknown;
    CommandLine?: unknown;
    CreationDate?: unknown;
  }>(result.stdout)) {
    const processId = Number(process.ProcessId);
    if (!Number.isInteger(processId) || processId <= 0) {
      continue;
    }
    const parentProcessId = Number(process.ParentProcessId);
    metadata.set(processId, {
      processId,
      parentProcessId:
        Number.isInteger(parentProcessId) && parentProcessId > 0 ? parentProcessId : null,
      name: typeof process.Name === "string" && process.Name.length > 0 ? process.Name : null,
      commandLine:
        typeof process.CommandLine === "string" && process.CommandLine.length > 0
          ? process.CommandLine
          : null,
      createdAt:
        typeof process.CreationDate === "string" && process.CreationDate.length > 0
          ? process.CreationDate
          : null,
    });
  }
  return metadata;
}

export const __terminalManagerInternals = {
  commandMatchesProjectRoot,
  discoverWindowsExternalServers,
  externalServerMatchesProjectRoot,
  parseNetstatTcpListeners,
  projectRootCandidatesForExternalDiscovery,
};

async function discoverPosixExternalServers(
  filter: ExternalServerFilter,
): Promise<ExternalServerDescriptor[]> {
  const projectRoots = projectRootCandidatesForExternalDiscovery(filter);
  if (projectRoots.length === 0) {
    return [];
  }

  let rawListeners = "";
  try {
    const result = await runProcess("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcPn"], {
      timeoutMs: DEFAULT_EXTERNAL_SERVER_SCAN_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 512_000,
      outputMode: "truncate",
    });
    rawListeners = result.stdout;
  } catch {
    return [];
  }

  const descriptors: ExternalServerDescriptor[] = [];
  let currentPid: number | null = null;
  let currentName: string | null = null;

  for (const line of rawListeners.split(/\r?\n/g)) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1).trim());
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      currentName = null;
      continue;
    }
    if (line.startsWith("c")) {
      currentName = line.slice(1).trim() || null;
      continue;
    }
    if (!line.startsWith("n") || currentPid === null) {
      continue;
    }

    const addressValue = line.slice(1).trim();
    const portMatch = /:(\d+)(?:->|$)/.exec(addressValue);
    const port = Number(portMatch?.[1] ?? NaN);
    if (!Number.isInteger(port) || port <= 0) {
      continue;
    }

    let commandLine = "";
    let parentPid: number | null = null;
    try {
      const psResult = await runProcess("ps", ["-p", String(currentPid), "-o", "ppid=,command="], {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 65_536,
        outputMode: "truncate",
      });
      const raw = psResult.stdout.trim();
      const firstSpace = raw.search(/\s/);
      if (firstSpace > 0) {
        parentPid = Number(raw.slice(0, firstSpace).trim());
        commandLine = raw.slice(firstSpace).trim();
      } else {
        commandLine = raw;
      }
    } catch {
      commandLine = currentName ?? "";
    }

    descriptors.push({
      pid: currentPid,
      port,
      address: addressValue,
      name: currentName,
      commandLine,
      parentPid: Number.isInteger(parentPid) ? parentPid : null,
      createdAt: null,
    });
  }

  return descriptors.filter((server) =>
    commandMatchesProjectRoot(server.commandLine, projectRoots),
  );
}

async function defaultExternalServerDiscoverer(
  filter: ExternalServerFilter,
): Promise<ExternalServerDescriptor[]> {
  if (process.platform === "win32") {
    return discoverWindowsExternalServers(filter);
  }
  return discoverPosixExternalServers(filter);
}

async function defaultExternalProcessKiller(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    await runProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeoutMs: DEFAULT_EXTERNAL_SERVER_SCAN_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    return;
  }
  await runProcess("kill", ["-TERM", String(pid)], {
    timeoutMs: 1_500,
    allowNonZeroExit: true,
    maxBufferBytes: 32_768,
    outputMode: "truncate",
  });
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  externalServerDiscoverer?: ExternalServerDiscoverer;
  externalProcessKiller?: ExternalProcessKiller;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

export class TerminalManagerRuntime extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly externalServerPidsByThread = new Map<string, Set<number>>();
  private readonly externalServerCache = new Map<string, ExternalServerCacheEntry>();
  private readonly logsDir: string;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly externalServerDiscoverer: ExternalServerDiscoverer;
  private readonly externalProcessKiller: ExternalProcessKiller;
  private readonly subprocessPollIntervalMs: number;
  private readonly processKillGraceMs: number;
  private readonly maxRetainedInactiveSessions: number;
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private subprocessPollInFlight = false;
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    this.externalServerDiscoverer =
      options.externalServerDiscoverer ?? defaultExternalServerDiscoverer;
    this.externalProcessKiller = options.externalProcessKiller ?? defaultExternalProcessKiller;
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);
      const nextMetadata = normalizeTerminalMetadata(input.metadata, input.env);
      const metadataProvided = input.metadata !== undefined;

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          metadata: nextMetadata,
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, cols, rows }, "started");
        return this.snapshot(session);
      }

      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);
      if (metadataProvided || !existing.metadata) {
        existing.metadata = nextMetadata;
      }

      if (existing.cwd !== input.cwd || runtimeEnvChanged) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        if (!metadataProvided) {
          existing.metadata = nextMetadata;
        }
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.runtimeEnv = nextRuntimeEnv;
        if (!metadataProvided) {
          existing.metadata = nextMetadata;
        }
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
      } else if (currentRuntimeEnv !== nextRuntimeEnv) {
        existing.runtimeEnv = nextRuntimeEnv;
        if (!metadataProvided) {
          existing.metadata = nextMetadata;
        }
      }

      if (!existing.process) {
        await this.startSession(
          existing,
          { ...input, cols: targetCols, rows: targetRows },
          "started",
        );
        return this.snapshot(existing);
      }

      if (existing.cols !== targetCols || existing.rows !== targetRows) {
        existing.cols = targetCols;
        existing.rows = targetRows;
        existing.process.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
      }

      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = decodeTerminalWriteInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      if (session.status === "exited") {
        return;
      }
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = decodeTerminalResizeInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = decodeTerminalClearInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);
      const nextMetadata = normalizeTerminalMetadata(input.metadata, input.env);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
          metadata: nextMetadata,
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
        session.metadata = nextMetadata;
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.history = "";
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      await this.startSession(session, { ...input, cols, rows }, "restarted");
      return this.snapshot(session);
    });
  }

  async list(raw: TerminalListInput): Promise<TerminalListResult> {
    const input = decodeTerminalListInput(raw);
    const includeInactive = input.includeInactive === true;
    const managedSessions = [...this.sessions.values()]
      .filter((session) => includeInactive || session.status === "running")
      .filter((session) => !input.threadId || session.threadId === input.threadId)
      .filter((session) => !input.cwd || samePath(session.cwd, input.cwd))
      .filter(
        (session) =>
          !input.projectRoot || this.sessionMatchesProjectRoot(session, input.projectRoot),
      )
      .map((session) => this.summary(session))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const managedPorts = new Set<number>();
    for (const session of managedSessions) {
      for (const port of extractRecentOutputPorts(session.recentOutput)) {
        managedPorts.add(port);
      }
    }

    const externalSessions = await this.listExternalSessions(input, managedPorts);
    const sessions = [...managedSessions, ...externalSessions].toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return { sessions };
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = decodeTerminalCloseInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        const externalPid = this.externalPidFromTerminalId(input.terminalId);
        if (externalPid !== null) {
          const allowedPids = this.externalServerPidsByThread.get(input.threadId);
          if (!allowedPids?.has(externalPid)) {
            throw new Error(
              `External server is not registered for thread: ${input.threadId}, terminal: ${input.terminalId}`,
            );
          }
          await this.externalProcessKiller(externalPid);
          this.removeExternalServerFromCache(externalPid);
          allowedPids.delete(externalPid);
          if (allowedPids.size === 0) {
            this.externalServerPidsByThread.delete(input.threadId);
          }
          return;
        }
        await this.closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
      }
      this.updateSubprocessPollingState();
    });
  }

  dispose(): void {
    this.stopSubprocessPolling();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      this.stopProcess(session);
    }
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const timer of this.killEscalationTimers.values()) {
      clearTimeout(timer);
    }
    this.killEscalationTimers.clear();
    this.externalServerPidsByThread.clear();
    this.externalServerCache.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
  }

  private async startSession(
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ): Promise<void> {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv);
      let lastSpawnError: unknown = null;

      const spawnWithCandidate = (candidate: ShellCandidate) =>
        Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: candidate.shell,
            ...(candidate.args ? { args: candidate.args } : {}),
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            env: terminalEnv,
          }),
        );

      const trySpawn = async (
        candidates: ShellCandidate[],
        index = 0,
      ): Promise<{ process: PtyProcess; shellLabel: string } | null> => {
        if (index >= candidates.length) {
          return null;
        }
        const candidate = candidates[index];
        if (!candidate) {
          return null;
        }

        try {
          const process = await spawnWithCandidate(candidate);
          return { process, shellLabel: formatShellCandidate(candidate) };
        } catch (error) {
          lastSpawnError = error;
          if (!isRetryableShellSpawnError(error)) {
            throw error;
          }
          return trySpawn(candidates, index + 1);
        }
      };

      const spawnResult = await trySpawn(shellCandidates);
      if (spawnResult) {
        ptyProcess = spawnResult.process;
        startedShell = spawnResult.shellLabel;
      }

      if (!ptyProcess) {
        const detail =
          lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
    } catch (error) {
      if (ptyProcess) {
        this.killProcessWithEscalation(ptyProcess, session.threadId, session.terminalId);
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.threadId, session.terminalId, session.history);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    this.clearKillEscalationTimer(session.process);
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    this.killProcessWithEscalation(process, session.threadId, session.terminalId);
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const timer = this.killEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(
    process: PtyProcess,
    threadId: string,
    terminalId: string,
  ): void {
    this.clearKillEscalationTimer(process);
    try {
      process.kill("SIGTERM");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to kill terminal process", {
        threadId,
        terminalId,
        signal: "SIGTERM",
        error: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      this.killEscalationTimers.delete(process);
      try {
        process.kill("SIGKILL");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          error: message,
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(process, timer);
  }

  private evictInactiveSessionsIfNeeded(): void {
    const inactiveSessions = [...this.sessions.values()].filter(
      (session) => session.status !== "running",
    );
    if (inactiveSessions.length <= this.maxRetainedInactiveSessions) {
      return;
    }

    inactiveSessions.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    const toEvict = inactiveSessions.length - this.maxRetainedInactiveSessions;
    for (const session of inactiveSessions.slice(0, toEvict)) {
      const key = toSessionKey(session.threadId, session.terminalId);
      this.sessions.delete(key);
      this.clearPersistTimer(session.threadId, session.terminalId);
      this.pendingPersistHistory.delete(key);
      this.persistQueues.delete(key);
      this.clearKillEscalationTimer(session.process);
    }
  }

  private queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId, terminalId), history, "utf8");
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);

      // Prefer an atomic rename when the legacy contents can be preserved as-is.
      if (capped === raw) {
        try {
          await fs.promises.rename(legacyPath, nextPath);
          return capped;
        } catch (migrationError) {
          this.logger.warn("failed to rename legacy terminal history", {
            threadId,
            error:
              migrationError instanceof Error ? migrationError.message : String(migrationError),
          });
        }
      }

      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.unlink(legacyPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") {
          return capped;
        }
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [fs.promises.rm(this.historyPath(threadId, terminalId), { force: true })];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      void this.pollSubprocessActivity();
    }, this.subprocessPollIntervalMs);
    this.subprocessPollTimer.unref?.();
    void this.pollSubprocessActivity();
  }

  private stopSubprocessPolling(): void {
    if (!this.subprocessPollTimer) return;
    clearInterval(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          try {
            hasRunningSubprocess = await this.subprocessChecker(terminalPid);
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          if (liveSession.hasRunningSubprocess === hasRunningSubprocess) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.updatedAt = new Date().toISOString();
          this.emitEvent({
            type: "activity",
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            createdAt: new Date().toISOString(),
            hasRunningSubprocess,
          });
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private sessionMatchesProjectRoot(session: TerminalSessionState, projectRoot: string): boolean {
    const metadataRoot = session.metadata?.projectRoot ?? session.runtimeEnv?.T3CODE_PROJECT_ROOT;
    if (metadataRoot && samePath(metadataRoot, projectRoot)) {
      return true;
    }
    return pathContains(projectRoot, session.cwd);
  }

  private externalPidFromTerminalId(terminalId: string): number | null {
    if (!terminalId.startsWith(EXTERNAL_TERMINAL_ID_PREFIX)) {
      return null;
    }
    const pid = Number(terminalId.slice(EXTERNAL_TERMINAL_ID_PREFIX.length));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  private async listExternalSessions(
    input: TerminalListInput,
    managedPorts: ReadonlySet<number>,
  ): Promise<TerminalSessionSummary[]> {
    const filter: ExternalServerFilter = {
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const discovered = await this.discoverExternalServersWithCache(filter);

    const fallbackCwd = input.projectRoot ?? input.cwd ?? process.cwd();
    const threadId = input.threadId ?? "external-local-server";
    const seenPorts = new Set<number>();
    const sessions = discovered
      .filter((server) => !managedPorts.has(server.port))
      .filter((server) => !seenPorts.has(server.port) && seenPorts.add(server.port))
      .map((server) => this.externalSummary(server, threadId, fallbackCwd));

    this.externalServerPidsByThread.set(
      threadId,
      new Set(sessions.map((session) => session.pid).filter((pid): pid is number => pid !== null)),
    );

    return sessions;
  }

  private externalServerCacheKey(filter: ExternalServerFilter): string {
    return JSON.stringify({
      projectRoot: filter.projectRoot ? normalizeProjectRootForMatch(filter.projectRoot) : null,
      cwd: filter.cwd ? normalizeProjectRootForMatch(filter.cwd) : null,
    });
  }

  private removeExternalServerFromCache(pid: number): void {
    for (const entry of this.externalServerCache.values()) {
      entry.servers = entry.servers.filter((server) => server.pid !== pid);
      for (const key of entry.missingSinceByKey.keys()) {
        if (key.startsWith(`${String(pid)}:`)) {
          entry.missingSinceByKey.delete(key);
        }
      }
    }
  }

  private discoverExternalServersWithCache(
    filter: ExternalServerFilter,
  ): Promise<ExternalServerDescriptor[]> {
    const key = this.externalServerCacheKey(filter);
    const now = Date.now();
    const current = this.externalServerCache.get(key);
    const isFresh = current && now - current.updatedAtMs < EXTERNAL_SERVER_CACHE_TTL_MS;
    if (isFresh) {
      return Promise.resolve(current.servers);
    }

    if (current?.refreshPromise) {
      return Promise.resolve(current.servers);
    }

    const entry: ExternalServerCacheEntry = current ?? {
      servers: [],
      updatedAtMs: 0,
      missingSinceByKey: new Map(),
      refreshPromise: null,
    };
    const refreshPromise = this.externalServerDiscoverer(filter)
      .then((servers) => {
        const updatedAtMs = Date.now();
        entry.servers = reconcileExternalServerCacheEntry(entry, servers, updatedAtMs);
        entry.updatedAtMs = updatedAtMs;
        return entry.servers;
      })
      .catch((error) => {
        this.logger.warn("failed to discover external local servers", {
          error: error instanceof Error ? error.message : String(error),
          ...filter,
        });
        return entry.servers;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });
    entry.refreshPromise = refreshPromise;
    this.externalServerCache.set(key, entry);

    return Promise.resolve(entry.servers);
  }

  private summary(session: TerminalSessionState): TerminalSessionSummary {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      hasRunningSubprocess: session.hasRunningSubprocess,
      recentOutput: tailTerminalOutput(session.history),
      metadata: session.metadata,
      updatedAt: session.updatedAt,
    };
  }

  private externalSummary(
    server: ExternalServerDescriptor,
    threadId: string,
    cwd: string,
  ): TerminalSessionSummary {
    const title = normalizeExternalServerAddress(server.address, server.port);
    const command = server.commandLine?.trim() || server.name?.trim() || title;
    return {
      threadId,
      terminalId: `${EXTERNAL_TERMINAL_ID_PREFIX}${String(server.pid)}`,
      cwd,
      status: "running",
      pid: server.pid,
      hasRunningSubprocess: true,
      recentOutput: "",
      metadata: {
        title,
        command,
        ...(cwd.trim().length > 0 ? { projectRoot: cwd } : {}),
      },
      updatedAt: server.createdAt ?? new Date().toISOString(),
    };
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export const TerminalManagerLive = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const { join } = yield* Path.Path;
    const logsDir = join(stateDir, "logs", "terminals");

    const ptyAdapter = yield* PtyAdapter;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new TerminalManagerRuntime({ logsDir, ptyAdapter })),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      open: (input) =>
        Effect.tryPromise({
          try: () => runtime.open(input),
          catch: (cause) => new TerminalError({ message: "Failed to open terminal", cause }),
        }),
      write: (input) =>
        Effect.tryPromise({
          try: () => runtime.write(input),
          catch: (cause) => new TerminalError({ message: "Failed to write to terminal", cause }),
        }),
      resize: (input) =>
        Effect.tryPromise({
          try: () => runtime.resize(input),
          catch: (cause) => new TerminalError({ message: "Failed to resize terminal", cause }),
        }),
      clear: (input) =>
        Effect.tryPromise({
          try: () => runtime.clear(input),
          catch: (cause) => new TerminalError({ message: "Failed to clear terminal", cause }),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: () => runtime.restart(input),
          catch: (cause) => new TerminalError({ message: "Failed to restart terminal", cause }),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: () => runtime.close(input),
          catch: (cause) => new TerminalError({ message: "Failed to close terminal", cause }),
        }),
      list: (input) =>
        Effect.tryPromise({
          try: () => runtime.list(input),
          catch: (cause) => new TerminalError({ message: "Failed to list terminals", cause }),
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies TerminalManagerShape;
  }),
);
