/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as Path from "node:path";

import type {
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import { resolveClaudeCodeExecutablePath } from "../claudeExecutable";

const DEFAULT_TIMEOUT_MS = 4_000;
const OPENCODE_TIMEOUT_MS = 12_000;
const CODEX_PROVIDER = "codex" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown, command: string): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes(`command not found: ${command}`) ||
    lower.includes(`spawn ${command} enoent`) ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function withProviderDefaults(
  provider: ServerProviderStatus["provider"],
  input: Omit<ServerProviderStatus, "provider" | "enabled" | "installed" | "version" | "models"> & {
    readonly installed?: boolean;
    readonly version?: string | null;
  },
): ServerProviderStatus {
  return {
    provider,
    enabled: true,
    installed: input.installed ?? input.available,
    version: input.version ?? null,
    models: [],
    ...input,
  };
}

function extractCliVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/i);
  return match?.[1] ?? null;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Claude authentication status command is unavailable in this Claude version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude auth login`") ||
    lowerOutput.includes("run claude auth login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function quoteForCmd(argument: string): string {
  if (argument.length === 0) {
    return '""';
  }
  if (!/[ \t"&|<>^]/.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/"/g, '\\"')}"`;
}

function resolveCommandInvocation(
  commandName: string,
  args: ReadonlyArray<string>,
): { command: string; args: ReadonlyArray<string>; shell: boolean } {
  if (
    process.platform !== "win32" ||
    (Path.isAbsolute(commandName) && Path.extname(commandName).toLowerCase() === ".exe")
  ) {
    return { command: commandName, args, shell: false };
  }
  const commandLine = [commandName, ...args].map(quoteForCmd).join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
    shell: false,
  };
}

const runCommand = (commandName: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const invocation = resolveCommandInvocation(commandName, args);
    const command = ChildProcess.make(invocation.command, [...invocation.args], {
      shell: invocation.shell,
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCommand("codex", ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return withProviderDefaults(CODEX_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error, "codex")
        ? "Codex CLI (`codex`) is not installed or not on PATH."
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return withProviderDefaults(CODEX_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI is installed but failed to run. Timed out while running command.",
    });
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return withProviderDefaults(CODEX_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Codex CLI is installed but failed to run. ${detail}`
        : "Codex CLI is installed but failed to run.",
    });
  }
  const parsedVersion = extractCliVersion(`${version.stdout}\n${version.stderr}`);

  // Probe 2: `codex login status` — is the user authenticated?
  const authProbe = yield* runCommand("codex", ["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return withProviderDefaults(CODEX_PROVIDER, {
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      version: parsedVersion,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    });
  }

  if (Option.isNone(authProbe.success)) {
    return withProviderDefaults(CODEX_PROVIDER, {
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      version: parsedVersion,
      message: "Could not verify Codex authentication status. Timed out while running command.",
    });
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  return withProviderDefaults(CODEX_PROVIDER, {
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    version: parsedVersion,
    ...(parsed.message ? { message: parsed.message } : {}),
  });
});

export const checkOpencodeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  const versionProbe = yield* runCommand("opencode", ["--version"]).pipe(
    Effect.timeoutOption(OPENCODE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return withProviderDefaults(OPENCODE_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error, "opencode")
        ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
        : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return withProviderDefaults(OPENCODE_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "OpenCode CLI is installed but failed to run. Timed out while running command.",
    });
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return withProviderDefaults(OPENCODE_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `OpenCode CLI is installed but failed to run. ${detail}`
        : "OpenCode CLI is installed but failed to run.",
    });
  }
  const parsedVersion = extractCliVersion(`${version.stdout}\n${version.stderr}`);

  return withProviderDefaults(OPENCODE_PROVIDER, {
    status: "ready",
    available: true,
    authStatus: "unknown",
    checkedAt,
    version: parsedVersion,
    message: "OpenCode authentication status is managed externally in v1.",
  });
});

export const checkClaudeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();
  const claudeExecutable = resolveClaudeCodeExecutablePath(undefined);

  const versionProbe = yield* runCommand(claudeExecutable, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error, claudeExecutable)
        ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
        : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Claude Agent CLI is installed but failed to run. Timed out while running command.",
    });
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Claude Agent CLI is installed but failed to run. ${detail}`
        : "Claude Agent CLI is installed but failed to run.",
    });
  }
  const parsedVersion = extractCliVersion(`${version.stdout}\n${version.stderr}`);

  const authProbe = yield* runCommand(claudeExecutable, ["auth", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      version: parsedVersion,
      message:
        error instanceof Error
          ? `Could not verify Claude authentication status: ${error.message}.`
          : "Could not verify Claude authentication status.",
    });
  }

  if (Option.isNone(authProbe.success)) {
    return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      version: parsedVersion,
      message: "Could not verify Claude authentication status. Timed out while running command.",
    });
  }

  const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
  return withProviderDefaults(CLAUDE_AGENT_PROVIDER, {
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    version: parsedVersion,
    ...(parsed.message ? { message: parsed.message } : {}),
  });
});

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const codexStatus = yield* checkCodexProviderStatus;
    const opencodeStatus = yield* checkOpencodeProviderStatus;
    const claudeStatus = yield* checkClaudeProviderStatus;
    return {
      getStatuses: Effect.succeed([codexStatus, opencodeStatus, claudeStatus]),
    } satisfies ProviderHealthShape;
  }),
);
