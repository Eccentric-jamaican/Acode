import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";
import { getDesktopWindowChromeMetrics } from "./windowChromeMetrics";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const NOTIFICATIONS_IS_SUPPORTED_CHANNEL = "desktop:notifications-is-supported";
const NOTIFICATIONS_SHOW_CHANNEL = "desktop:notifications-show";
const BROWSER_GET_STATE_CHANNEL = "desktop:browser-get-state";
const BROWSER_OPEN_CHANNEL = "desktop:browser-open";
const BROWSER_CLOSE_PANE_CHANNEL = "desktop:browser-close-pane";
const BROWSER_NEW_TAB_CHANNEL = "desktop:browser-new-tab";
const BROWSER_ACTIVATE_TAB_CHANNEL = "desktop:browser-activate-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "desktop:browser-close-tab";
const BROWSER_NAVIGATE_CHANNEL = "desktop:browser-navigate";
const BROWSER_BACK_CHANNEL = "desktop:browser-back";
const BROWSER_FORWARD_CHANNEL = "desktop:browser-forward";
const BROWSER_RELOAD_CHANNEL = "desktop:browser-reload";
const BROWSER_KILL_CHANNEL = "desktop:browser-kill";
const BROWSER_SET_INSPECT_MODE_CHANNEL = "desktop:browser-set-inspect-mode";
const BROWSER_CAPTURE_INSPECT_SELECTION_CHANNEL = "desktop:browser-capture-inspect-selection";
const BROWSER_EVENT_CHANNEL = "desktop:browser-event";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  getWindowChromeMetrics: () => getDesktopWindowChromeMetrics(process.platform),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(NOTIFICATIONS_IS_SUPPORTED_CHANNEL),
    show: (input) => ipcRenderer.invoke(NOTIFICATIONS_SHOW_CHANNEL, input),
  },
  browser: {
    getState: (input) => ipcRenderer.invoke(BROWSER_GET_STATE_CHANNEL, input),
    open: (input) => ipcRenderer.invoke(BROWSER_OPEN_CHANNEL, input),
    closePane: () => ipcRenderer.invoke(BROWSER_CLOSE_PANE_CHANNEL),
    newTab: (input) => ipcRenderer.invoke(BROWSER_NEW_TAB_CHANNEL, input),
    activateTab: (input) => ipcRenderer.invoke(BROWSER_ACTIVATE_TAB_CHANNEL, input),
    closeTab: (input) => ipcRenderer.invoke(BROWSER_CLOSE_TAB_CHANNEL, input),
    navigate: (input) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, input),
    back: (input) => ipcRenderer.invoke(BROWSER_BACK_CHANNEL, input),
    forward: (input) => ipcRenderer.invoke(BROWSER_FORWARD_CHANNEL, input),
    reload: (input) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, input),
    kill: (input) => ipcRenderer.invoke(BROWSER_KILL_CHANNEL, input),
    setInspectMode: (input) => ipcRenderer.invoke(BROWSER_SET_INSPECT_MODE_CHANNEL, input),
    captureInspectSelection: (input) =>
      ipcRenderer.invoke(BROWSER_CAPTURE_INSPECT_SELECTION_CHANNEL, input),
    onEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        listener(payload as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(BROWSER_EVENT_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(BROWSER_EVENT_CHANNEL, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
