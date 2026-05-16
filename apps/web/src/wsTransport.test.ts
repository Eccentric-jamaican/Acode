import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(_url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

beforeEach(() => {
  sockets.length = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("refuses to fall back to env url when desktop bridge does not provide ws url", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { hostname: "localhost", port: "3020" },
        desktopBridge: {
          getWsUrl: () => null,
        },
      },
    });

    expect(() => new WsTransport()).toThrow(
      "Desktop bridge is available but did not provide a WebSocket URL.",
    );
    expect(sockets).toHaveLength(0);
  });

  it("waits for an HTTP readiness probe before opening an auto-derived websocket", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const transport = new WsTransport();

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);

    transport.dispose();
  });

  it("routes valid push envelopes to channel listeners", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe("providers.event", listener);

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "providers.event",
        data: { status: "ok" },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: "ok" });

    transport.dispose();
  });

  it("resolves pending requests for valid response envelopes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected request envelope to be sent");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });

    transport.dispose();
  });

  it("drops malformed envelopes without crashing transport", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe("providers.event", listener);

    socket.serverMessage("{ invalid-json");
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: 42,
        data: { bad: true },
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "providers.event",
        data: { ok: true },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Dropped inbound WebSocket envelope", {
      reason: "decode-failed",
      issue: expect.stringContaining(
        "SchemaError: SyntaxError: Expected property name or '}' in JSON at position 2",
      ),
      raw: "{ invalid-json",
    });
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Dropped inbound WebSocket envelope", {
      reason: "decode-failed",
      issue: expect.stringContaining("SchemaError: Expected string, got 42"),
      raw: '{"type":"push","channel":42,"data":{"bad":true}}',
    });

    transport.dispose();
  });

  it("rejects pending requests when the socket closes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    socket.close();

    await expect(requestPromise).rejects.toThrow("Connection to the T3 Code server was lost.");
  });

  it("keeps unsent requests pending across reconnect after initial connection refusal", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const firstSocket = getSocket();

    const requestPromise = transport.request("projects.list");
    expect(firstSocket.sent).toHaveLength(0);

    firstSocket.close();
    await vi.advanceTimersByTimeAsync(500);

    expect(sockets).toHaveLength(2);
    const secondSocket = getSocket();
    secondSocket.open();

    await vi.advanceTimersByTimeAsync(50);
    expect(secondSocket.sent).toHaveLength(1);

    const requestEnvelope = JSON.parse(secondSocket.sent[0] ?? "{}") as { id: string };
    secondSocket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });
    transport.dispose();
  });

  it("retries dispatch command request once after timeout", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.create",
        commandId: "cmd-retry-1",
      },
    });

    expect(socket.sent).toHaveLength(1);
    const firstRequestEnvelope = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.sent).toHaveLength(2);

    const secondRequestEnvelope = JSON.parse(socket.sent[1] ?? "{}") as { id: string };
    expect(secondRequestEnvelope.id).not.toBe(firstRequestEnvelope.id);

    socket.serverMessage(
      JSON.stringify({
        id: secondRequestEnvelope.id,
        result: { ok: true },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ ok: true });
    transport.dispose();
  });

  it("resolves dispatch as success when matching domain event ack is seen", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId: "cmd-ack-1",
      },
    });

    expect(socket.sent).toHaveLength(1);

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "orchestration.domainEvent",
        data: {
          sequence: 123,
          commandId: "cmd-ack-1",
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ sequence: 123 });
    expect(socket.sent).toHaveLength(1);
    transport.dispose();
  });

  it("uses cached domain event ack as timeout fallback for dispatch command", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        channel: "orchestration.domainEvent",
        data: {
          sequence: 456,
          commandId: "cmd-ack-cache-1",
        },
      }),
    );

    const requestPromise = transport.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId: "cmd-ack-cache-1",
      },
    });

    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(requestPromise).resolves.toEqual({ sequence: 456 });
    transport.dispose();
  });

  it("uses persisted command receipt as timeout fallback for dispatch command", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId: "cmd-receipt-1",
      },
    });

    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(250);

    expect(socket.sent).toHaveLength(2);
    const retryEnvelope = JSON.parse(socket.sent[1] ?? "{}") as {
      id: string;
      body?: { _tag?: string; commandId?: string };
    };
    expect(retryEnvelope.body?._tag).toBe("orchestration.dispatchCommand");
    expect(retryEnvelope.body?.commandId).toBeUndefined();

    await vi.advanceTimersByTimeAsync(300_000);

    expect(socket.sent).toHaveLength(3);
    const receiptEnvelope = JSON.parse(socket.sent[2] ?? "{}") as {
      id: string;
      body?: { _tag?: string; commandId?: string };
    };
    expect(receiptEnvelope.body?._tag).toBe("orchestration.getCommandReceipt");
    expect(receiptEnvelope.body?.commandId).toBe("cmd-receipt-1");

    socket.serverMessage(
      JSON.stringify({
        id: receiptEnvelope.id,
        result: {
          status: "accepted",
          resultSequence: 789,
          error: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ sequence: 789 });
    transport.dispose();
  });

  it("surfaces rejected persisted command receipts after dispatch timeout", async () => {
    vi.useFakeTimers();
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId: "cmd-receipt-rejected-1",
      },
    });

    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(250);

    expect(socket.sent).toHaveLength(2);
    const retryEnvelope = JSON.parse(socket.sent[1] ?? "{}") as {
      body?: { _tag?: string };
    };
    expect(retryEnvelope.body?._tag).toBe("orchestration.dispatchCommand");

    await vi.advanceTimersByTimeAsync(300_000);

    expect(socket.sent).toHaveLength(3);
    const receiptEnvelope = JSON.parse(socket.sent[2] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: receiptEnvelope.id,
        result: {
          status: "rejected",
          resultSequence: 790,
          error: "Previously rejected.",
        },
      }),
    );

    await expect(requestPromise).rejects.toThrow("Previously rejected.");
    transport.dispose();
  });
});
