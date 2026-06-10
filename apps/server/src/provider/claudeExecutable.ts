import { spawnSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

const CLAUDE_COMMAND = "claude";
const CLAUDE_PACKAGE_BIN = Path.join(
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
);

function exists(path: string): boolean {
  try {
    return Fs.existsSync(path);
  } catch {
    return false;
  }
}

function quoteForCmdForLoop(path: string): string {
  return path.replace(/"/g, '""');
}

function toWindowsShortPath(path: string): string {
  if (!path.includes(" ")) {
    return path;
  }

  try {
    const result = spawnSync(
      "cmd.exe",
      ["/d", "/c", `for %I in ("${quoteForCmdForLoop(path)}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    );
    const shortPath = result.stdout.trim();
    return result.status === 0 && shortPath && exists(shortPath) ? shortPath : path;
  } catch {
    return path;
  }
}

function resolveWrapperTarget(wrapperPath: string): string | undefined {
  const extension = Path.extname(wrapperPath).toLowerCase();
  if (extension === ".exe" && exists(wrapperPath)) {
    return toWindowsShortPath(wrapperPath);
  }

  const target = Path.join(Path.dirname(wrapperPath), CLAUDE_PACKAGE_BIN);
  return exists(target) ? toWindowsShortPath(target) : undefined;
}

function candidateDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const dirs = new Set<string>();
  for (const entry of (env.PATH ?? "").split(Path.delimiter)) {
    if (entry.trim().length > 0) dirs.add(entry);
  }

  const appData = env.APPDATA;
  if (appData) dirs.add(Path.join(appData, "npm"));
  dirs.add(Path.join(Os.homedir(), "AppData", "Roaming", "npm"));

  return [...dirs];
}

export function resolveClaudeCodeExecutablePath(
  requestedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const requested = requestedPath?.trim() || CLAUDE_COMMAND;
  if (process.platform !== "win32") {
    return requested;
  }

  const hasDirectory = requested.includes("/") || requested.includes("\\");
  if (hasDirectory) {
    return resolveWrapperTarget(requested) ?? requested;
  }

  const names =
    requested.toLowerCase() === CLAUDE_COMMAND
      ? ["claude.exe", "claude.cmd", "claude.ps1", "claude"]
      : [requested];

  for (const dir of candidateDirectories(env)) {
    for (const name of names) {
      const resolved = resolveWrapperTarget(Path.join(dir, name));
      if (resolved) return resolved;
    }
  }

  return requested;
}

export function resolveClaudeCodeSdkExecutablePath(
  requestedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveClaudeCodeExecutablePath(requestedPath, env);
}
