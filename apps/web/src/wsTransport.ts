import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WebSocketResponse,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";

type PushListener = (data: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
  dispatchCommandId: string | null;
  sent: boolean;
}

interface DispatchCommandAck {
  readonly commandId: string;
  readonly sequence: number;
  readonly seenAtMs: number;
}

interface DispatchCommandReceipt {
  readonly status: "accepted" | "rejected";
  readonly resultSequence: number;
  readonly error: string | null;
}

const REQUEST_TIMEOUT_MS = 60_000;
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
const ORCHESTRATION_DISPATCH_TIMEOUT_MS = 180_000;
const ORCHESTRATION_DISPATCH_THREAD_CREATE_TIMEOUT_MS = 300_000;
const ORCHESTRATION_DISPATCH_TURN_START_TIMEOUT_MS = 300_000;
const ORCHESTRATION_DISPATCH_RETRY_DELAY_MS = 250;
const ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_TIMEOUT_MS = 5_000;
const ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_ATTEMPTS = 3;
const ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_DELAY_MS = 500;
const COMMAND_ACK_CACHE_TTL_MS = 10 * 60_000;
const COMMAND_ACK_CACHE_MAX = 5_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const decodeWsResponseFromJson = Schema.decodeUnknownExit(Schema.fromJsonString(WsResponse));
const isWsPushEnvelope = Schema.is(WsPush);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

function readDispatchCommand(params: unknown): { type?: unknown; commandId?: unknown } | null {
  if (!params || typeof params !== "object") return null;
  const maybeCommand = (params as { command?: unknown }).command;
  if (!maybeCommand || typeof maybeCommand !== "object") return null;
  return maybeCommand as { type?: unknown; commandId?: unknown };
}

function readDispatchCommandId(params: unknown): string | null {
  const command = readDispatchCommand(params);
  if (typeof command?.commandId !== "string" || command.commandId.length === 0) {
    return null;
  }
  return command.commandId;
}

function requestTimeoutMs(method: string, params: unknown): number {
  if (method === WS_METHODS.gitClone) {
    return GIT_CLONE_TIMEOUT_MS;
  }
  if (method !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return REQUEST_TIMEOUT_MS;
  }
  const command = readDispatchCommand(params);
  if (command?.type === "thread.create") {
    return ORCHESTRATION_DISPATCH_THREAD_CREATE_TIMEOUT_MS;
  }
  if (command?.type === "thread.turn.start") {
    return ORCHESTRATION_DISPATCH_TURN_START_TIMEOUT_MS;
  }
  return ORCHESTRATION_DISPATCH_TIMEOUT_MS;
}

function shouldRetryDispatchTimeout(method: string, params: unknown): boolean {
  if (method !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return false;
  }
  const command = readDispatchCommand(params);
  return typeof command?.commandId === "string" && command.commandId.length > 0;
}

function isRequestTimeoutErrorForMethod(error: unknown, method: string): error is Error {
  return error instanceof Error && error.message === `Request timed out: ${method}`;
}

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingDispatchRequestByCommandId = new Map<string, string>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly commandAcks = new Map<string, DispatchCommandAck>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly url: string;

  constructor(url?: string) {
    const desktopBridge = window.desktopBridge;
    const hasDesktopBridge = typeof desktopBridge?.getWsUrl === "function";
    const bridgeUrl = hasDesktopBridge ? desktopBridge.getWsUrl() : null;
    // In dev mode, VITE_WS_URL points to the server's WebSocket endpoint.
    // In production, the page is served by the WS server on the same host:port.
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    if (url && url.length > 0) {
      this.url = url;
    } else if (hasDesktopBridge) {
      if (typeof bridgeUrl !== "string" || bridgeUrl.length === 0) {
        throw new Error(
          "Desktop bridge is available but did not provide a WebSocket URL. Refusing to fall back to VITE_WS_URL.",
        );
      }
      this.url = bridgeUrl;
    } else if (envUrl && envUrl.length > 0) {
      this.url = envUrl;
    } else {
      this.url = `ws://${window.location.hostname}:${window.location.port}`;
    }
    this.connect();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }
    const timeoutMs = requestTimeoutMs(method, params);
    const maxAttempts = shouldRetryDispatchTimeout(method, params) ? 2 : 1;
    const dispatchCommandId = readDispatchCommandId(params);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.performRequestAttempt<T>(method, params, timeoutMs);
      } catch (error) {
        const shouldRetry =
          attempt < maxAttempts && isRequestTimeoutErrorForMethod(error, method) && !this.disposed;
        if (!shouldRetry) {
          if (
            dispatchCommandId &&
            method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            isRequestTimeoutErrorForMethod(error, method)
          ) {
            const resolvedFromReceipt = await this.tryResolveTimedOutDispatchWithReceipt<T>(
              dispatchCommandId,
            );
            if (resolvedFromReceipt !== null) {
              return resolvedFromReceipt;
            }
          }
          throw error;
        }
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            resolve();
          }, ORCHESTRATION_DISPATCH_RETRY_DELAY_MS),
        );
      }
    }

    throw new Error(`Request failed unexpectedly: ${method}`);
  }

  private performRequestAttempt<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    const message: WsRequestEnvelope = { id, body };
    const dispatchCommandId = readDispatchCommandId(params);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        if (
          dispatchCommandId &&
          method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          this.pendingDispatchRequestByCommandId.get(dispatchCommandId) === id
        ) {
          this.pendingDispatchRequestByCommandId.delete(dispatchCommandId);
        }
        if (
          dispatchCommandId &&
          method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          this.tryResolveTimedOutDispatchWithAck(resolve, dispatchCommandId)
        ) {
          return;
        }
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
        method,
        dispatchCommandId,
        sent: false,
      });
      if (dispatchCommandId && method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
        this.pendingDispatchRequestByCommandId.set(dispatchCommandId, id);
      }

      this.send(message, timeoutMs);
    });
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    return () => {
      channelListeners!.delete(listener);
      if (channelListeners!.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport disposed"));
    }
    this.pending.clear();
    this.pendingDispatchRequestByCommandId.clear();
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;

    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this.ws = ws;
      this.reconnectAttempt = 0;
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.rejectPendingRequests("Connection to the T3 Code server was lost.", { onlySent: true });
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will fire after error
    });
  }

  private handleMessage(raw: unknown) {
    const exit = decodeWsResponseFromJson(raw);
    if (exit._tag === "Failure") {
      console.warn("Dropped inbound WebSocket envelope", {
        reason: "decode-failed",
        raw,
        issue: Cause.pretty(exit.cause),
      });
      return;
    }
    const message = exit.value;

    // Push event
    if (isWsPushEnvelope(message)) {
      this.recordDispatchCommandAckFromPush(message.channel, message.data);
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message.data);
          } catch {
            // Swallow listener errors
          }
        }
      }
      return;
    }

    // Response to a request
    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (
      pending.method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      pending.dispatchCommandId &&
      this.pendingDispatchRequestByCommandId.get(pending.dispatchCommandId) === message.id
    ) {
      this.pendingDispatchRequestByCommandId.delete(pending.dispatchCommandId);
    }

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private send(message: WsRequestEnvelope, timeoutMs: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      this.markPendingRequestSent(message.id);
      return;
    }

    // If not connected, wait for connection
    const waitForOpen = () => {
      const check = setInterval(() => {
        if (this.disposed) {
          clearInterval(check);
          return;
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          this.ws.send(JSON.stringify(message));
          this.markPendingRequestSent(message.id);
        }
      }, 50);

      // Give up after timeout (the pending request will time out on its own)
      setTimeout(() => clearInterval(check), timeoutMs);
    };
    waitForOpen();
  }

  private recordDispatchCommandAckFromPush(channel: string, data: unknown): void {
    if (channel !== "orchestration.domainEvent") {
      return;
    }
    if (!data || typeof data !== "object") {
      return;
    }

    const maybeCommandId = (data as { commandId?: unknown }).commandId;
    const maybeSequence = (data as { sequence?: unknown }).sequence;
    if (typeof maybeCommandId !== "string" || maybeCommandId.length === 0) {
      return;
    }
    if (typeof maybeSequence !== "number" || !Number.isFinite(maybeSequence)) {
      return;
    }

    const seenAtMs = Date.now();
    const previous = this.commandAcks.get(maybeCommandId);
    if (!previous || maybeSequence >= previous.sequence) {
      this.commandAcks.set(maybeCommandId, {
        commandId: maybeCommandId,
        sequence: maybeSequence,
        seenAtMs,
      });
    }
    this.resolvePendingDispatchRequestFromAck(maybeCommandId, maybeSequence);
    this.pruneCommandAcks(seenAtMs);
  }

  private resolvePendingDispatchRequestFromAck(commandId: string, sequence: number): void {
    const requestId = this.pendingDispatchRequestByCommandId.get(commandId);
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.pendingDispatchRequestByCommandId.delete(commandId);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    this.pendingDispatchRequestByCommandId.delete(commandId);
    pending.resolve({ sequence });
  }

  private pruneCommandAcks(nowMs: number): void {
    for (const [commandId, ack] of this.commandAcks) {
      if (nowMs - ack.seenAtMs > COMMAND_ACK_CACHE_TTL_MS) {
        this.commandAcks.delete(commandId);
      }
    }

    if (this.commandAcks.size <= COMMAND_ACK_CACHE_MAX) {
      return;
    }

    const ordered = [...this.commandAcks.values()].toSorted((left, right) => left.seenAtMs - right.seenAtMs);
    const excess = this.commandAcks.size - COMMAND_ACK_CACHE_MAX;
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index];
      if (!victim) break;
      this.commandAcks.delete(victim.commandId);
    }
  }

  private tryResolveTimedOutDispatchWithAck<T>(
    resolve: (value: T | PromiseLike<T>) => void,
    commandId: string,
  ): boolean {
    const ack = this.commandAcks.get(commandId);
    if (!ack) {
      return false;
    }
    resolve({ sequence: ack.sequence } as T);
    return true;
  }

  private async tryResolveTimedOutDispatchWithReceipt<T>(commandId: string): Promise<T | null> {
    const receipt = await this.lookupDispatchReceipt(commandId);
    if (receipt === null) {
      return null;
    }
    if (receipt.status === "rejected") {
      throw new Error(receipt.error ?? `Dispatch command was rejected: ${commandId}`);
    }
    return { sequence: receipt.resultSequence } as T;
  }

  private async lookupDispatchReceipt(commandId: string): Promise<DispatchCommandReceipt | null> {
    for (
      let attempt = 1;
      attempt <= ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const receipt = await this.performRequestAttempt<DispatchCommandReceipt | null>(
          ORCHESTRATION_WS_METHODS.getCommandReceipt,
          { commandId },
          ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_TIMEOUT_MS,
        );
        if (receipt !== null) {
          return receipt;
        }
      } catch (error) {
        if (this.disposed) {
          throw error;
        }
      }

      if (attempt < ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_ATTEMPTS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, ORCHESTRATION_COMMAND_RECEIPT_LOOKUP_DELAY_MS),
        );
      }
    }

    return null;
  }

  private markPendingRequestSent(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    pending.sent = true;
  }

  private rejectPendingRequests(message: string, options?: { onlySent?: boolean }) {
    const onlySent = options?.onlySent ?? false;
    for (const [id, pending] of this.pending) {
      if (onlySent && !pending.sent) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(id);
      if (
        pending.method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
        pending.dispatchCommandId &&
        this.pendingDispatchRequestByCommandId.get(pending.dispatchCommandId) === id
      ) {
        this.pendingDispatchRequestByCommandId.delete(pending.dispatchCommandId);
      }
    }
  }

  private scheduleReconnect() {
    if (this.disposed) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
