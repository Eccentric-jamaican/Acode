import {
  CommandId,
  type ContextMenuItem,
  MessageId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  type ServerProviderStatus,
  type ServerProviderStateUpdatedPayload,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const showContextMenuFallbackMock = vi.fn<
  <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>
>();
const channelListeners = new Map<string, Set<(data: unknown) => void>>();
const subscribeMock = vi.fn<(channel: string, listener: (data: unknown) => void) => () => void>(
  (channel, listener) => {
    const listeners = channelListeners.get(channel) ?? new Set<(data: unknown) => void>();
    listeners.add(listener);
    channelListeners.set(channel, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        channelListeners.delete(channel);
      }
    };
  },
);

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
    },
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitPush(channel: string, data: unknown): void {
  const listeners = channelListeners.get(channel);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(data);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

const defaultProviders: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

const defaultProviderStateUpdatedPayload: ServerProviderStateUpdatedPayload = {
  providers: defaultProviders,
  providerAccounts: [
    {
      provider: "codex",
      state: "authenticated",
      authMode: "chatgpt",
      requiresOpenaiAuth: false,
      account: {
        type: "chatgpt",
        email: "addis@example.com",
        planType: "pro",
      },
      rateLimits: [],
      login: {
        status: "idle",
        loginId: null,
        authUrl: null,
        error: null,
      },
      message: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  showContextMenuFallbackMock.mockReset();
  subscribeMock.mockClear();
  channelListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("delivers and caches valid server.welcome payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", projectName: "t3-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(payload));

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(expect.objectContaining(payload));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("preserves bootstrap ids from server.welcome payloads", async () => {
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, {
      cwd: "/tmp/workspace",
      projectName: "t3-code",
      bootstrapProjectId: "project-1",
      bootstrapThreadId: "thread-1",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        projectName: "t3-code",
        bootstrapProjectId: "project-1",
        bootstrapThreadId: "thread-1",
      }),
    );
  });

  it("ignores invalid server.welcome payloads and keeps subscription active", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, { cwd: 42, projectName: "t3-code" });
    emitPush(WS_CHANNELS.serverWelcome, { cwd: "/tmp/workspace", projectName: "t3-code" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/workspace", projectName: "t3-code" }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: { cwd: 42, projectName: "t3-code" },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("delivers and caches valid server.configUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    const payload = {
      issues: [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: "Entry at index 1 is invalid.",
        },
      ],
      providers: defaultProviders,
    } as const;
    emitPush(WS_CHANNELS.serverConfigUpdated, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerConfigUpdated(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed server.configUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerConfigUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerConfigUpdated(listener);

    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [{ kind: "keybindings.invalid-entry", message: "missing index" }],
      providers: defaultProviders,
    });
    emitPush(WS_CHANNELS.serverConfigUpdated, {
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: defaultProviders,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      issues: [{ kind: "keybindings.malformed-config", message: "bad json" }],
      providers: defaultProviders,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers and caches valid server.providerStateUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerProviderStateUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerProviderStateUpdated(listener);

    emitPush(WS_CHANNELS.serverProviderStateUpdated, defaultProviderStateUpdatedPayload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(defaultProviderStateUpdatedPayload);

    const lateListener = vi.fn();
    onServerProviderStateUpdated(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(defaultProviderStateUpdatedPayload);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed server.providerStateUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerProviderStateUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerProviderStateUpdated(listener);

    emitPush(WS_CHANNELS.serverProviderStateUpdated, {
      providers: defaultProviders,
      providerAccounts: [
        {
          provider: "codex",
          state: "authenticated",
          authMode: "chatgpt",
        },
      ],
    });

    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers server.errorInboxUpdated payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerErrorInboxUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerErrorInboxUpdated(listener);

    emitPush(WS_CHANNELS.serverErrorInboxUpdated, {
      reason: "upsert",
      entry: {
        id: "err-1",
        fingerprint: "fingerprint-1",
        source: "provider-runtime",
        category: "provider",
        severity: "error",
        projectId: "project-1",
        threadId: "thread-1",
        turnId: null,
        provider: "codex",
        summary: "Provider runtime error",
        detail: "spawn failed",
        latestContextJson: {
          method: "process/error",
        },
        firstSeenAt: "2026-03-22T19:00:00.000Z",
        lastSeenAt: "2026-03-22T19:01:00.000Z",
        occurrenceCount: 1,
        linkedTaskId: null,
        resolution: null,
      },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "upsert",
        entry: expect.objectContaining({
          summary: "Provider runtime error",
        }),
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports malformed server.errorInboxUpdated payloads through the error inbox reporter", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi, onServerErrorInboxUpdated } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerErrorInboxUpdated(listener);

    emitPush(WS_CHANNELS.serverErrorInboxUpdated, {
      reason: "upsert",
      entry: {
        id: "err-1",
      },
    });

    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      WS_METHODS.serverReportClientDiagnostic,
      expect.objectContaining({
        source: "websocket",
        category: "websocket",
        severity: "warning",
        summary: "Dropped inbound WebSocket push payload",
      }),
    );
  });

  it("forwards valid terminal and orchestration events", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitPush(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModel: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } as const;
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed terminal and orchestration push payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    emitPush(WS_CHANNELS.terminalEvent, {
      threadId: "thread-1",
      terminalId: "",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    });
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, {
      sequence: -1,
      type: "project.created",
    });

    expect(onTerminalEvent).not.toHaveBeenCalled();
    expect(onDomainEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        threadId: "thread-1",
        terminalId: "",
        createdAt: "2026-02-24T00:00:00.000Z",
        type: "output",
        data: "hello",
      },
      issue: expect.stringContaining("SchemaError"),
    });
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        sequence: -1,
        type: "project.created",
      },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("wraps orchestration dispatch commands in the command envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModel: "gpt-5-codex",
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("recovers dispatch commands from persisted receipts after a timeout", async () => {
    requestMock
      .mockRejectedValueOnce(
        new Error(`Request timed out: ${ORCHESTRATION_WS_METHODS.dispatchCommand}`),
      )
      .mockResolvedValueOnce({
        status: "accepted",
        resultSequence: 77,
        error: null,
      });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("cmd-timeout-recover-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-04-06T13:10:41.727Z",
      runtimeMode: "full-access",
      interactionMode: "default",
      assistantDeliveryMode: "buffered",
    } as const;

    await expect(api.orchestration.dispatchCommand(command)).resolves.toEqual({
      sequence: 77,
    });
    expect(requestMock).toHaveBeenNthCalledWith(1, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, ORCHESTRATION_WS_METHODS.getCommandReceipt, {
      commandId: command.commandId,
    });
  });

  it("surfaces rejected persisted command receipts after a timeout", async () => {
    requestMock
      .mockRejectedValueOnce(
        new Error(`Request timed out: ${ORCHESTRATION_WS_METHODS.dispatchCommand}`),
      )
      .mockResolvedValueOnce({
        status: "rejected",
        resultSequence: 78,
        error: "Previously rejected.",
      });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe("cmd-timeout-rejected-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      title: "hello",
    } as const;

    await expect(api.orchestration.dispatchCommand(command)).rejects.toThrow(
      "Previously rejected.",
    );
    expect(requestMock).toHaveBeenNthCalledWith(1, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, ORCHESTRATION_WS_METHODS.getCommandReceipt, {
      commandId: command.commandId,
    });
  });

  it("wraps thread pin updates in the orchestration dispatch envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe("cmd-pin-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      isPinned: true,
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("forwards error inbox server RPC methods", async () => {
    requestMock.mockResolvedValue({ ok: true });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await api.server.getErrorInbox();
    await api.server.reportClientDiagnostic({
      source: "browser-runtime",
      category: "browser",
      severity: "error",
      summary: "Unhandled runtime error",
      detail: "Cannot read properties of undefined",
      projectId: ProjectId.makeUnsafe("project-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      context: {
        route: "/thread-1",
      },
    });
    await api.server.setErrorInboxEntryResolution({
      entryId: "err-1",
      resolution: "resolved",
    });
    await api.server.promoteErrorInboxEntryToTask({
      entryId: "err-1",
      projectId: ProjectId.makeUnsafe("project-1"),
    });

    expect(requestMock).toHaveBeenNthCalledWith(1, WS_METHODS.serverGetErrorInbox);
    expect(requestMock).toHaveBeenNthCalledWith(2, WS_METHODS.serverReportClientDiagnostic, {
      source: "browser-runtime",
      category: "browser",
      severity: "error",
      summary: "Unhandled runtime error",
      detail: "Cannot read properties of undefined",
      projectId: ProjectId.makeUnsafe("project-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      context: {
        route: "/thread-1",
      },
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      WS_METHODS.serverSetErrorInboxEntryResolution,
      {
        entryId: "err-1",
        resolution: "resolved",
      },
    );
    expect(requestMock).toHaveBeenNthCalledWith(4, WS_METHODS.serverPromoteErrorInboxEntryToTask, {
      entryId: "err-1",
      projectId: ProjectId.makeUnsafe("project-1"),
    });
  });

  it("forwards workspace file writes to the websocket project method", async () => {
    requestMock.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(requestMock).toHaveBeenCalledWith(WS_METHODS.projectsWriteFile, {
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards full-thread diff requests to the orchestration websocket method", async () => {
    requestMock.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards context menu metadata to desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        showContextMenu,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: 200, y: 300 },
    );

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "rename", label: "Rename thread" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: 200, y: 300 },
    );
  });

  it("uses fallback context menu when desktop bridge is unavailable", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    await api.contextMenu.show(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );

    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(
      [{ id: "delete", label: "Delete", destructive: true }],
      { x: 20, y: 30 },
    );
  });

  it("forwards browser actions to the desktop bridge when available", async () => {
    const browserBridge = {
      getState: vi.fn().mockResolvedValue({ session: null }),
      open: vi.fn().mockResolvedValue({ session: null }),
      closePane: vi.fn().mockResolvedValue(undefined),
      newTab: vi.fn().mockResolvedValue({ session: null }),
      activateTab: vi.fn().mockResolvedValue({ session: null }),
      closeTab: vi.fn().mockResolvedValue({ session: null }),
      navigate: vi.fn().mockResolvedValue({ session: null }),
      back: vi.fn().mockResolvedValue({ session: null }),
      forward: vi.fn().mockResolvedValue({ session: null }),
      reload: vi.fn().mockResolvedValue({ session: null }),
      kill: vi.fn().mockResolvedValue(undefined),
      setInspectMode: vi.fn().mockResolvedValue({ session: null }),
      captureInspectSelection: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockReturnValue(() => {}),
    };
    Object.defineProperty(getWindowForTest(), "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        browser: browserBridge,
      },
    });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await api.browser.getState({ projectId: ProjectId.makeUnsafe("project-1") });
    await api.browser.open({
      projectId: ProjectId.makeUnsafe("project-1"),
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
    await api.browser.newTab({
      projectId: ProjectId.makeUnsafe("project-1"),
    });
    await api.browser.activateTab({
      projectId: ProjectId.makeUnsafe("project-1"),
      tabId: "tab-1",
    });
    await api.browser.closeTab({
      projectId: ProjectId.makeUnsafe("project-1"),
      tabId: "tab-1",
    });
    await api.browser.navigate({
      projectId: ProjectId.makeUnsafe("project-1"),
      url: "http://localhost:3000",
    });
    await api.browser.setInspectMode({
      projectId: ProjectId.makeUnsafe("project-1"),
      enabled: true,
    });
    const unsubscribe = api.browser.onEvent(vi.fn());
    await api.browser.closePane();

    expect(browserBridge.getState).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(browserBridge.open).toHaveBeenCalledWith({
      projectId: "project-1",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
    expect(browserBridge.newTab).toHaveBeenCalledWith({
      projectId: "project-1",
    });
    expect(browserBridge.activateTab).toHaveBeenCalledWith({
      projectId: "project-1",
      tabId: "tab-1",
    });
    expect(browserBridge.closeTab).toHaveBeenCalledWith({
      projectId: "project-1",
      tabId: "tab-1",
    });
    expect(browserBridge.navigate).toHaveBeenCalledWith({
      projectId: "project-1",
      url: "http://localhost:3000",
    });
    expect(browserBridge.setInspectMode).toHaveBeenCalledWith({
      projectId: "project-1",
      enabled: true,
    });
    expect(browserBridge.onEvent).toHaveBeenCalledTimes(1);
    expect(browserBridge.closePane).toHaveBeenCalledTimes(1);
    expect(typeof unsubscribe).toBe("function");
  });

  it("throws for browser actions when the desktop bridge is unavailable", async () => {
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await expect(
      api.browser.getState({ projectId: ProjectId.makeUnsafe("project-1") }),
    ).rejects.toThrow("Integrated browser is only available in the desktop app.");
  });
});
