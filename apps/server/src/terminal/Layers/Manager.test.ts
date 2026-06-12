import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { __terminalManagerInternals, TerminalManagerRuntime } from "./Manager";
import { Effect, Encoding } from "effect";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(
    historyLineLimit = 5,
    options: {
      shellResolver?: () => string;
      subprocessChecker?: (terminalPid: number) => Promise<boolean>;
      externalServerDiscoverer?: (filter: { projectRoot?: string; cwd?: string }) => Promise<
        Array<{
          pid: number;
          port: number;
          address: string;
          name: string | null;
          commandLine: string | null;
          parentPid: number | null;
          createdAt: string | null;
        }>
      >;
      externalProcessKiller?: (pid: number) => Promise<void>;
      subprocessPollIntervalMs?: number;
      processKillGraceMs?: number;
      maxRetainedInactiveSessions?: number;
      ptyAdapter?: FakePtyAdapter;
    } = {},
  ) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-"));
    tempDirs.push(logsDir);
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter,
      historyLineLimit,
      shellResolver: options.shellResolver ?? (() => "/bin/bash"),
      ...(options.subprocessChecker ? { subprocessChecker: options.subprocessChecker } : {}),
      ...(options.externalServerDiscoverer
        ? { externalServerDiscoverer: options.externalServerDiscoverer }
        : {}),
      ...(options.externalProcessKiller
        ? { externalProcessKiller: options.externalProcessKiller }
        : {}),
      ...(options.subprocessPollIntervalMs
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs ? { processKillGraceMs: options.processKillGraceMs } : {}),
      ...(options.maxRetainedInactiveSessions
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
    });
    return { logsDir, ptyAdapter, manager };
  }

  it("matches command lines for project roots that contain spaces", () => {
    const commandLine =
      'node "C:\\Users\\First Last\\source\\repos\\t3code-main\\apps\\web\\node_modules\\vite\\bin\\vite.js"';
    const result = __terminalManagerInternals.commandMatchesProjectRoot(commandLine, [
      "C:\\Users\\First Last\\source\\repos\\t3code-main",
    ]);

    expect(result).toBe(true);
  });

  it("does not match project roots by substring collision", () => {
    const commandLine =
      'node "C:\\Users\\Addis\\source\\repos\\t3code-main-2\\apps\\web\\node_modules\\vite\\bin\\vite.js"';
    const result = __terminalManagerInternals.commandMatchesProjectRoot(commandLine, [
      "C:\\Users\\Addis\\source\\repos\\t3code-main",
    ]);

    expect(result).toBe(false);
  });

  it("matches external servers through parent process commands", () => {
    const result = __terminalManagerInternals.externalServerMatchesProjectRoot(
      {
        pid: 42,
        port: 5733,
        address: "127.0.0.1",
        name: "node.exe",
        commandLine: '"C:\\Program Files\\nodejs\\node.exe" vite.js --host 127.0.0.1',
        parentCommandLine: 'bun run dev --cwd "C:\\Users\\Addis\\source\\repos\\t3code-main"',
        parentPid: 41,
        createdAt: null,
      },
      ["C:\\Users\\Addis\\source\\repos\\t3code-main"],
    );

    expect(result).toBe(true);
  });

  it("expands nested project folders to the repository root for external discovery", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-terminal-repo-"));
    const nestedProject = path.join(repoRoot, "apps", "server");
    try {
      fs.mkdirSync(path.join(repoRoot, ".git"));
      fs.mkdirSync(nestedProject, { recursive: true });

      const result = __terminalManagerInternals.projectRootCandidatesForExternalDiscovery({
        projectRoot: nestedProject,
      });

      expect(result).toContain(nestedProject.replaceAll("\\", "/").toLowerCase());
      expect(result).toContain(repoRoot.replaceAll("\\", "/").toLowerCase());
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("uses the current workspace as a fallback when no project root is provided", () => {
    const result = __terminalManagerInternals.projectRootCandidatesForExternalDiscovery({});

    expect(result).toContain(process.cwd().replaceAll("\\", "/").toLowerCase());
  });

  it("parses local TCP listeners from netstat output", () => {
    const result = __terminalManagerInternals.parseNetstatTcpListeners(`
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:5733         0.0.0.0:0              LISTENING       123
  TCP    [::1]:5733             [::]:0                 LISTENING       123
  TCP    [::1]:5734             [::]:0                 LISTENING       124
  TCP    192.168.1.12:9000      0.0.0.0:0              LISTENING       125
`);

    expect(result).toEqual([
      { address: "127.0.0.1", port: 5733, pid: 123 },
      { address: "::1", port: 5734, pid: 124 },
    ]);
  });

  it("parses IPv6 loopback listeners from unfiltered netstat output", () => {
    const result = __terminalManagerInternals.parseNetstatTcpListeners(`
  Proto  Local Address          Foreign Address        State           PID
  TCP    [::1]:5733             [::]:0                 LISTENING       123
  UDP    [::1]:1900             *:*                                    456
  TCP    192.168.1.12:9000      0.0.0.0:0              LISTENING       789
`);

    expect(result).toEqual([{ address: "::1", port: 5733, pid: 123 }]);
  });

  it("does not block terminal listing on external server discovery", async () => {
    let discoveryResolved = false;
    const discoveryGate = deferred();
    const { manager } = makeManager(5, {
      externalServerDiscoverer: async () => {
        await discoveryGate.promise;
        discoveryResolved = true;
        return [
          {
            pid: 51515,
            port: 5733,
            address: "127.0.0.1",
            name: "node.exe",
            commandLine: "node vite.js",
            parentPid: null,
            createdAt: null,
          },
        ];
      },
    });

    const first = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(first.sessions).toEqual([]);
    expect(discoveryResolved).toBe(false);

    discoveryGate.resolve();
    await waitFor(() => discoveryResolved);

    const second = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.terminalId).toBe("external:51515");

    manager.dispose();
  });

  it("keeps external servers visible through transient empty discovery results", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let discoveryCount = 0;
    const server = {
      pid: 51515,
      port: 5733,
      address: "127.0.0.1",
      name: "node.exe",
      commandLine: "node vite.js",
      parentPid: null,
      createdAt: null,
    };
    const { manager } = makeManager(5, {
      externalServerDiscoverer: async () => {
        discoveryCount += 1;
        return discoveryCount === 1 ? [server] : [];
      },
    });

    const initial = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(initial.sessions).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();

    const discovered = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(discovered.sessions).toHaveLength(1);

    now += 5_001;
    const staleWhileRefreshing = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(staleWhileRefreshing.sessions).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();

    const retainedAfterEmptyScan = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(retainedAfterEmptyScan.sessions).toHaveLength(1);

    now += 35_001;
    const retainedWhileGraceExpires = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(retainedWhileGraceExpires.sessions).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();

    const clearedAfterGrace = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(clearedAfterGrace.sessions).toEqual([]);

    manager.dispose();
  });

  it("removes stopped external servers from the cache immediately", async () => {
    const killedPids: number[] = [];
    const { manager } = makeManager(5, {
      externalServerDiscoverer: async () => [
        {
          pid: 51515,
          port: 5733,
          address: "127.0.0.1",
          name: "node.exe",
          commandLine: "node vite.js",
          parentPid: null,
          createdAt: null,
        },
      ],
      externalProcessKiller: async (pid) => {
        killedPids.push(pid);
      },
    });

    await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    await Promise.resolve();
    await Promise.resolve();

    const beforeStop = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(beforeStop.sessions).toHaveLength(1);

    await manager.close({
      threadId: "thread-1",
      terminalId: "external:51515",
    });

    const afterStop = await manager.list({
      threadId: "thread-1",
      projectRoot: "/tmp/project",
    });
    expect(killedPids).toEqual([51515]);
    expect(afterStop.sessions).toEqual([]);

    manager.dispose();
  });

  it("rejects stopping external pids that were not registered for the thread", async () => {
    const killedPids: number[] = [];
    const { manager } = makeManager(5, {
      externalProcessKiller: async (pid) => {
        killedPids.push(pid);
      },
    });

    await expect(
      manager.close({
        threadId: "thread-1",
        terminalId: "external:51515",
      }),
    ).rejects.toThrow(/not registered for thread/i);
    expect(killedPids).toEqual([]);

    manager.dispose();
  });

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([
      manager.open(openInput()),
      manager.open(openInput()),
    ]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    manager.dispose();
  });

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter } = makeManager(5, { ptyAdapter: new FakePtyAdapter("async") });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);

    manager.dispose();
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    manager.dispose();
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.open(openInput({ cols: 140, rows: 40 }));

    expect(process.resizeCalls).toEqual([{ cols: 140, rows: 40 }]);

    manager.dispose();
  });

  it("preserves existing terminal size on open when size is omitted", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const ptyProcess = ptyAdapter.processes[0];
    expect(ptyProcess).toBeDefined();
    if (!ptyProcess) return;

    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    expect(ptyProcess.resizeCalls).toEqual([]);

    ptyProcess.emitExit({ exitCode: 0, signal: 0 });
    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    const resumedSpawn = ptyAdapter.spawnInputs[1];
    expect(resumedSpawn).toBeDefined();
    if (!resumedSpawn) return;
    expect(resumedSpawn.cols).toBe(100);
    expect(resumedSpawn.rows).toBe(24);

    manager.dispose();
  });

  it("uses default dimensions when opening a new terminal without size hints", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open({
      threadId: "thread-1",
      cwd: process.cwd(),
    });

    const spawned = ptyAdapter.spawnInputs[0];
    expect(spawned).toBeDefined();
    if (!spawned) return;
    expect(spawned.cols).toBe(120);
    expect(spawned.rows).toBe(30);

    manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    manager.dispose();
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(openInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    manager.dispose();
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(manager.write({ threadId: "thread-1", data: "\r" })).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);

    manager.dispose();
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => hasRunningSubprocess,
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => events.some((event) => event.type === "started"));
    expect(events.some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
      1_200,
    );

    manager.dispose();
  }, 30_000);

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    manager.dispose();
  }, 15_000);

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    try {
      await manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      await waitFor(() => fs.existsSync(historyLogPath(logsDir)), 10_000);

      await manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);
    } finally {
      manager.dispose();
    }
  }, 15_000);

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    try {
      await manager.open(openInput({ terminalId: "default" }));
      await manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      await waitFor(
        () => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")),
        10_000,
      );
      await waitFor(
        () => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")),
        10_000,
      );

      await manager.close({ threadId: "thread-1", deleteHistory: true });

      expect(defaultProcess.killed).toBe(true);
      expect(sidecarProcess.killed).toBe(true);
      expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(
        false,
      );
      expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(
        false,
      );
    } finally {
      manager.dispose();
    }
  }, 30_000);

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    try {
      await manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      await manager.close({ threadId: "thread-1" });
      await waitFor(() => process.killSignals.includes("SIGKILL"), 10_000);

      expect(process.killSignals[0]).toBe("SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    } finally {
      manager.dispose();
    }
  }, 15_000);

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter } = makeManager(5, { maxRetainedInactiveSessions: 1 });

    await manager.open(openInput({ threadId: "thread-1" }));
    await manager.open(openInput({ threadId: "thread-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => {
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      return sessions.size === 1;
    }, 10_000);

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const keys = [...sessions.keys()];
    expect(keys).toEqual(["thread-2\u0000default"]);

    manager.dispose();
  }, 15_000);

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const history = await (
      manager as unknown as {
        readHistory(threadId: string, terminalId: string): Promise<string>;
      }
    ).readHistory("thread-1", "default");

    expect(history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);

    manager.dispose();
  }, 15_000);

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

    if (process.platform === "win32") {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["cmd.exe", "powershell.exe"].includes(path.basename(input.shell).toLowerCase()),
        ),
      ).toBe(true);
    } else {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(input.shell),
        ),
      ).toBe(true);
    }

    manager.dispose();
  }, 15_000);

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("T3CODE_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter } = makeManager(5, {
        subprocessChecker: async () => false,
      });
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");

      manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(
      openInput({
        env: {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/repo/worktree-a",
          CUSTOM_FLAG: "1",
        },
      }),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.T3CODE_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");

    manager.dispose();
  });

  it("starts zsh with prompt spacer disabled to avoid `%` end markers", async () => {
    if (process.platform === "win32") return;
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/bin/zsh",
    });
    await manager.open(openInput());
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.shell).toBe("/bin/zsh");
    expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);

    manager.dispose();
  });
});
