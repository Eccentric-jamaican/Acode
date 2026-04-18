import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface JsonRpcError {
  code?: number;
  message?: string;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerTransportEvents {
  error: [error: Error];
  exit: [details: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
  notification: [notification: JsonRpcNotification];
  request: [request: JsonRpcRequest];
  stderr: [line: string];
}

export interface CodexAppServerTransportOptions {
  readonly binaryPath?: string;
  readonly cwd: string;
  readonly homePath?: string;
}

export class CodexAppServerTransport extends EventEmitter<CodexAppServerTransportEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: readline.Interface;
  private readonly pending = new Map<PendingRequestKey, PendingRequest>();
  private nextRequestId = 1;
  private stopping = false;

  constructor(options: CodexAppServerTransportOptions) {
    super();
    this.child = spawn(options.binaryPath ?? "codex", ["app-server"], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.homePath ? { CODEX_HOME: options.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    this.output = readline.createInterface({ input: this.child.stdout });
    this.attachListeners();
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  async request<TResponse>(method: string, params: unknown, timeoutMs = 20_000): Promise<TResponse> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = String(id);

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.pending.set(key, {
        method,
        timeout,
        resolve,
        reject,
      });
      try {
        this.writeMessage({
          method,
          id,
          params,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(key);
        reject(toError(error, `Failed to send ${method} request to codex app-server.`));
      }
    });

    return result as TResponse;
  }

  notify(method: string, params?: unknown): void {
    try {
      this.writeMessage(params === undefined ? { method } : { method, params });
    } catch (error) {
      this.emit("error", toError(error, `Failed to send ${method} notification to codex app-server.`));
    }
  }

  respond(requestId: string | number, response: { result?: unknown; error?: JsonRpcError }): void {
    try {
      this.writeMessage({
        id: requestId,
        ...(response.result !== undefined ? { result: response.result } : {}),
        ...(response.error !== undefined ? { error: response.error } : {}),
      });
    } catch (error) {
      this.emit("error", toError(error, "Failed to send response to codex app-server."));
    }
  }

  close(): void {
    this.stopping = true;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    this.pending.clear();

    this.output.close();

    if (!this.child.killed) {
      killChildTree(this.child);
    }
  }

  private attachListeners(): void {
    this.output.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }
        this.emit("stderr", line);
      }
    });

    this.child.stdin.on("error", (error) => {
      this.handleStdinError(error);
    });

    this.child.on("error", (error) => {
      this.rejectPendingRequests("codex app-server process errored before completing requests.");
      this.emit("error", error);
    });

    this.child.on("exit", (code, signal) => {
      this.rejectPendingRequests(
        `codex app-server exited before completing requests (code=${code ?? "null"}, signal=${
          signal ?? "null"
        }).`,
      );
      this.emit("exit", {
        code,
        signal,
        expected: this.stopping,
      });
    });
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit("error", new Error("Received invalid JSON from codex app-server."));
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emit("error", new Error("Received non-object protocol message."));
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.emit("request", parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.emit("notification", parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(parsed);
      return;
    }

    this.emit("error", new Error("Received protocol message in an unknown shape."));
  }

  private handleResponse(response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private writeMessage(message: unknown): void {
    if (this.stopping) {
      throw new Error("Cannot write to codex app-server stdin after transport shutdown.");
    }

    const encoded = JSON.stringify(message);
    if (!this.canWriteToStdin()) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    this.child.stdin.write(`${encoded}\n`, (error) => {
      if (error) {
        this.handleStdinError(error);
      }
    });
  }

  private canWriteToStdin(): boolean {
    return this.child.stdin.writable && !this.child.stdin.writableEnded && !this.child.stdin.destroyed;
  }

  private rejectPendingRequests(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private handleStdinError(cause: Error): void {
    if (this.stopping && isBenignBrokenPipeError(cause)) {
      return;
    }

    this.rejectPendingRequests("codex app-server stdin stream closed unexpectedly.");
    this.emit("error", toError(cause, "codex app-server stdin stream closed unexpectedly."));
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }
}

function isBenignBrokenPipeError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function toError(cause: unknown, prefix: string): Error {
  const message =
    cause instanceof Error ? `${prefix} ${cause.message}` : `${prefix} ${String(cause)}`;
  return new Error(message);
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill.
    }
  }
  child.kill();
}
