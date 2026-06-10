import {
  type ClientOrchestrationCommand,
  OrchestrationEvent,
  type OrchestrationCommandReceiptResult,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  ServerErrorInboxUpdatedPayload,
  ServerProviderStateUpdatedPayload,
  ServerProviderUpdateStatusPayload,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WsWelcomePayload,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";

import { showContextMenuFallback } from "./contextMenuFallback";
import { reportClientDiagnostic, setClientDiagnosticReporter } from "./errorInboxReporter";
import { WsTransport, type WsAuthProvider } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const serverErrorInboxUpdatedListeners = new Set<
  (payload: ServerErrorInboxUpdatedPayload) => void
>();
const serverProviderStateUpdatedListeners = new Set<
  (payload: ServerProviderStateUpdatedPayload) => void
>();
const serverProviderUpdateStatusListeners = new Set<
  (payload: ServerProviderUpdateStatusPayload) => void
>();
let lastWelcome: WsWelcomePayload | null = null;
let lastServerConfigUpdated: ServerConfigUpdatedPayload | null = null;
let lastServerProviderStateUpdated: ServerProviderStateUpdatedPayload | null = null;

export function resetWsNativeApi(): void {
  instance?.transport.dispose();
  instance = null;
  lastWelcome = null;
  lastServerConfigUpdated = null;
  lastServerProviderStateUpdated = null;
}

const decodeAndWarnOnFailure = <T>(
  schema: Schema.Schema<T> & { readonly DecodingServices: never },
  raw: unknown,
): T | null => {
  const decoded = Schema.decodeUnknownExit(schema)(raw);
  if (decoded._tag === "Failure") {
    console.warn("Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw,
      issue: Cause.pretty(decoded.cause),
    });
    reportClientDiagnostic({
      source: "websocket",
      category: "websocket",
      severity: "warning",
      summary: "Dropped inbound WebSocket push payload",
      detail: Cause.pretty(decoded.cause),
      context: {
        raw,
        stack: Cause.pretty(decoded.cause),
      },
    });
    return null;
  }
  return decoded.value;
};

function desktopBrowserUnavailable(): never {
  throw new Error("Integrated browser is only available in the desktop app.");
}

function isDispatchCommandTimeout(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message === `Request timed out: ${ORCHESTRATION_WS_METHODS.dispatchCommand}`
  );
}

async function dispatchCommandWithReceiptRecovery(
  transport: WsTransport,
  command: ClientOrchestrationCommand,
): Promise<{ sequence: number }> {
  try {
    return await transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command });
  } catch (error) {
    if (!isDispatchCommandTimeout(error)) {
      throw error;
    }

    const receipt = await transport
      .request<OrchestrationCommandReceiptResult>(ORCHESTRATION_WS_METHODS.getCommandReceipt, {
        commandId: command.commandId,
      })
      .catch(() => null);

    if (receipt && receipt.status === "accepted") {
      return { sequence: receipt.resultSequence };
    }
    if (receipt && receipt.status === "rejected") {
      throw new Error(receipt.error ?? `Dispatch command was rejected: ${command.commandId}`, {
        cause: error,
      });
    }

    throw error;
  }
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  // Replay cached welcome for late subscribers
  if (lastWelcome) {
    try {
      listener(lastWelcome);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  if (lastServerConfigUpdated) {
    try {
      listener(lastServerConfigUpdated);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

export function onServerProviderStateUpdated(
  listener: (payload: ServerProviderStateUpdatedPayload) => void,
): () => void {
  serverProviderStateUpdatedListeners.add(listener);

  if (lastServerProviderStateUpdated) {
    try {
      listener(lastServerProviderStateUpdated);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    serverProviderStateUpdatedListeners.delete(listener);
  };
}

export function onServerProviderUpdateStatus(
  listener: (payload: ServerProviderUpdateStatusPayload) => void,
): () => void {
  serverProviderUpdateStatusListeners.add(listener);

  return () => {
    serverProviderUpdateStatusListeners.delete(listener);
  };
}

export function onServerErrorInboxUpdated(
  listener: (payload: ServerErrorInboxUpdatedPayload) => void,
): () => void {
  serverErrorInboxUpdatedListeners.add(listener);
  return () => {
    serverErrorInboxUpdatedListeners.delete(listener);
  };
}

export function createWsNativeApi(options?: {
  url?: string;
  authProvider?: WsAuthProvider | null;
}): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport(options?.url, options?.authProvider);

  // Listen for server welcome and forward to registered listeners.
  // Also cache it so late subscribers (React effects) get it immediately.
  transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
    const payload = decodeAndWarnOnFailure(WsWelcomePayload, data);
    if (!payload) return;
    lastWelcome = payload;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (data) => {
    const payload = decodeAndWarnOnFailure(ServerConfigUpdatedPayload, data);
    if (!payload) return;
    lastServerConfigUpdated = payload;
    for (const listener of serverConfigUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.serverProviderStateUpdated, (data) => {
    const payload = decodeAndWarnOnFailure(ServerProviderStateUpdatedPayload, data);
    if (!payload) return;
    lastServerProviderStateUpdated = payload;
    for (const listener of serverProviderStateUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.serverProviderUpdateStatus, (data) => {
    const payload = decodeAndWarnOnFailure(ServerProviderUpdateStatusPayload, data);
    if (!payload) return;
    for (const listener of serverProviderUpdateStatusListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => transport.request(WS_METHODS.terminalOpen, input),
      write: (input) => transport.request(WS_METHODS.terminalWrite, input),
      resize: (input) => transport.request(WS_METHODS.terminalResize, input),
      clear: (input) => transport.request(WS_METHODS.terminalClear, input),
      restart: (input) => transport.request(WS_METHODS.terminalRestart, input),
      close: (input) => transport.request(WS_METHODS.terminalClose, input),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.terminalEvent, (data) => {
          const payload = decodeAndWarnOnFailure(TerminalEvent, data);
          if (payload) callback(payload);
        }),
    },
    projects: {
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      listDirectory: (input) => transport.request(WS_METHODS.projectsListDirectory, input),
      listTree: (input) => transport.request(WS_METHODS.projectsListTree, input),
      fileMetadata: (input) => transport.request(WS_METHODS.projectsFileMetadata, input),
      readFile: (input) => transport.request(WS_METHODS.projectsReadFile, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
      createDirectory: (input) => transport.request(WS_METHODS.projectsCreateDirectory, input),
      renameEntry: (input) => transport.request(WS_METHODS.projectsRenameEntry, input),
      deleteEntry: (input) => transport.request(WS_METHODS.projectsDeleteEntry, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      clone: (input) => transport.request(WS_METHODS.gitClone, input),
      pull: (input) => transport.request(WS_METHODS.gitPull, input),
      status: (input) => transport.request(WS_METHODS.gitStatus, input),
      diff: (input) => transport.request(WS_METHODS.gitDiff, input),
      filePreview: (input) => transport.request(WS_METHODS.gitFilePreview, input),
      reviewAction: (input) => transport.request(WS_METHODS.gitReviewAction, input),
      runStackedAction: (input) => transport.request(WS_METHODS.gitRunStackedAction, input),
      listBranches: (input) => transport.request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => transport.request(WS_METHODS.gitCreateWorktree, input),
      removeWorktree: (input) => transport.request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => transport.request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => transport.request(WS_METHODS.gitCheckout, input),
      init: (input) => transport.request(WS_METHODS.gitInit, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge?.showContextMenu) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => transport.request(WS_METHODS.serverGetConfig),
      getSettings: () => transport.request(WS_METHODS.serverGetSettings),
      getErrorInbox: () => transport.request(WS_METHODS.serverGetErrorInbox),
      reportClientDiagnostic: (input) =>
        transport.request(WS_METHODS.serverReportClientDiagnostic, input),
      setErrorInboxEntryResolution: (input) =>
        transport.request(WS_METHODS.serverSetErrorInboxEntryResolution, input),
      promoteErrorInboxEntryToTask: (input) =>
        transport.request(WS_METHODS.serverPromoteErrorInboxEntryToTask, input),
      upsertKeybinding: (input) => transport.request(WS_METHODS.serverUpsertKeybinding, input),
      startProviderLogin: (input) => transport.request(WS_METHODS.serverStartProviderLogin, input),
      cancelProviderLogin: (input) =>
        transport.request(WS_METHODS.serverCancelProviderLogin, input),
      logoutProvider: (input) => transport.request(WS_METHODS.serverLogoutProvider, input),
      updateProvider: (input) => transport.request(WS_METHODS.serverUpdateProvider, input),
      suggestNewThreadTasks: (input) =>
        transport.request(WS_METHODS.serverSuggestNewThreadTasks, input),
      updateSettings: (input) => transport.request(WS_METHODS.serverUpdateSettings, input),
      onProviderUpdateStatus: (callback) => onServerProviderUpdateStatus(callback),
      onErrorInboxUpdated: (callback) => onServerErrorInboxUpdated(callback),
    },
    computerUse: {
      listApps: () => transport.request(WS_METHODS.computerUseListApps),
      getSettings: () => transport.request(WS_METHODS.computerUseGetSettings),
      updateSettings: (input) => transport.request(WS_METHODS.computerUseUpdateSettings, input),
    },
    remoteAccess: {
      getSnapshot: () => transport.request(WS_METHODS.remoteAccessGetSnapshot),
      createPairingLink: (input) =>
        transport.request(WS_METHODS.remoteAccessCreatePairingLink, input),
      revokePairingLink: (input) =>
        transport.request(WS_METHODS.remoteAccessRevokePairingLink, input),
      revokeClient: (input) => transport.request(WS_METHODS.remoteAccessRevokeClient, input),
      revokeOtherClients: () => transport.request(WS_METHODS.remoteAccessRevokeOtherClients),
      setNetworkAccess: (input) =>
        transport.request(WS_METHODS.remoteAccessSetNetworkAccess, input),
      setTailscaleHttps: (input) =>
        transport.request(WS_METHODS.remoteAccessSetTailscaleHttps, input),
    },
    provider: {
      getComposerCapabilities: (input) =>
        transport.request(WS_METHODS.providerGetComposerCapabilities, input),
      listCommands: (input) => transport.request(WS_METHODS.providerListCommands, input),
      listSkills: (input) => transport.request(WS_METHODS.providerListSkills, input),
      listPlugins: (input) => transport.request(WS_METHODS.providerListPlugins, input),
      readPlugin: (input) => transport.request(WS_METHODS.providerReadPlugin, input),
      listModels: (input) => transport.request(WS_METHODS.providerListModels, input),
      prewarmSession: (input) => transport.request(WS_METHODS.providerPrewarmSession, input),
    },
    orchestration: {
      getSnapshot: (input) => transport.request(ORCHESTRATION_WS_METHODS.getSnapshot, input),
      dispatchCommand: (command) => dispatchCommandWithReceiptRecovery(transport, command),
      getTurnDiff: (input) => transport.request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive) =>
        transport.request(ORCHESTRATION_WS_METHODS.replayEvents, { fromSequenceExclusive }),
      onDomainEvent: (callback) =>
        transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (data) => {
          const payload = decodeAndWarnOnFailure(OrchestrationEvent, data);
          if (payload) callback(payload);
        }),
    },
    browser: {
      getState: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.getState(input);
      },
      open: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.open(input);
      },
      closePane: async () => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.closePane();
      },
      newTab: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.newTab(input);
      },
      activateTab: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.activateTab(input);
      },
      closeTab: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.closeTab(input);
      },
      navigate: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.navigate(input);
      },
      back: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.back(input);
      },
      forward: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.forward(input);
      },
      reload: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.reload(input);
      },
      kill: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.kill(input);
      },
      getSettings: async () => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.getSettings();
      },
      updateSettings: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.updateSettings(input);
      },
      clearBrowsingData: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.clearBrowsingData(input);
      },
      setInspectMode: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.setInspectMode(input);
      },
      captureInspectSelection: async (input) => {
        if (!window.desktopBridge?.browser) {
          return desktopBrowserUnavailable();
        }
        return window.desktopBridge.browser.captureInspectSelection(input);
      },
      onEvent: (callback) => {
        if (!window.desktopBridge?.browser) {
          return () => {};
        }
        return window.desktopBridge.browser.onEvent(callback);
      },
    },
  };

  setClientDiagnosticReporter((input) => api.server.reportClientDiagnostic(input));

  transport.subscribe(WS_CHANNELS.serverErrorInboxUpdated, (data) => {
    const payload = decodeAndWarnOnFailure(ServerErrorInboxUpdatedPayload, data);
    if (!payload) return;
    for (const listener of serverErrorInboxUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  instance = { api, transport };
  return api;
}
