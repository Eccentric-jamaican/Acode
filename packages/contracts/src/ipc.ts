import type {
  GitCloneInput,
  GitCloneResult,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  BrowserActivateTabInput,
  BrowserCloseTabInput,
  BrowserCreateTabInput,
  BrowserInspectCapture,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserProjectInput,
  BrowserRuntimeEvent,
  BrowserSessionSnapshot,
  BrowserSetInspectModeInput,
} from "./browser";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ServerCancelProviderLoginInput,
  ServerCancelProviderLoginResult,
  ServerConfig,
  ServerErrorInboxUpdatedPayload,
  ServerGetErrorInboxResult,
  ServerLogoutProviderInput,
  ServerLogoutProviderResult,
  ServerSuggestNewThreadTasksInput,
  ServerSuggestNewThreadTasksResult,
  ServerPromoteErrorInboxEntryToTaskInput,
  ServerPromoteErrorInboxEntryToTaskResult,
  ServerReportClientDiagnosticInput,
  ServerReportClientDiagnosticResult,
  ServerSetErrorInboxEntryResolutionInput,
  ServerSetErrorInboxEntryResolutionResult,
  ServerStartProviderLoginInput,
  ServerStartProviderLoginResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput, ServerUpsertKeybindingResult } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import { EditorId } from "./editor";
import type {
  ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from "./providerDiscovery";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopWindowChromeMetrics {
  platform: "darwin" | "win32" | "linux";
  titlebarHeightPx: number;
  leadingInsetPx: number;
  trailingInsetPx: number;
  captionButtonLaneWidthPx: number;
}

export interface DesktopNotificationInput {
  title: string;
  body: string;
  silent?: boolean;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getWindowChromeMetrics: () => DesktopWindowChromeMetrics;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  notifications: {
    isSupported: () => Promise<boolean>;
    show: (input: DesktopNotificationInput) => Promise<boolean>;
  };
  browser: {
    getState: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    open: (input: BrowserOpenInput) => Promise<BrowserSessionSnapshot>;
    closePane: () => Promise<void>;
    newTab: (input: BrowserCreateTabInput) => Promise<BrowserSessionSnapshot>;
    activateTab: (input: BrowserActivateTabInput) => Promise<BrowserSessionSnapshot>;
    closeTab: (input: BrowserCloseTabInput) => Promise<BrowserSessionSnapshot>;
    navigate: (input: BrowserNavigateInput) => Promise<BrowserSessionSnapshot>;
    back: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    forward: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    reload: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    kill: (input: BrowserProjectInput) => Promise<void>;
    setInspectMode: (input: BrowserSetInspectModeInput) => Promise<BrowserSessionSnapshot>;
    captureInspectSelection: (input: BrowserProjectInput) => Promise<BrowserInspectCapture | null>;
    onEvent: (listener: (event: BrowserRuntimeEvent) => void) => () => void;
  };
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    clone: (input: GitCloneInput) => Promise<GitCloneResult>;
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getErrorInbox: () => Promise<ServerGetErrorInboxResult>;
    reportClientDiagnostic: (
      input: ServerReportClientDiagnosticInput,
    ) => Promise<ServerReportClientDiagnosticResult>;
    setErrorInboxEntryResolution: (
      input: ServerSetErrorInboxEntryResolutionInput,
    ) => Promise<ServerSetErrorInboxEntryResolutionResult>;
    promoteErrorInboxEntryToTask: (
      input: ServerPromoteErrorInboxEntryToTaskInput,
    ) => Promise<ServerPromoteErrorInboxEntryToTaskResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    startProviderLogin: (
      input: ServerStartProviderLoginInput,
    ) => Promise<ServerStartProviderLoginResult>;
    cancelProviderLogin: (
      input: ServerCancelProviderLoginInput,
    ) => Promise<ServerCancelProviderLoginResult>;
    logoutProvider: (input: ServerLogoutProviderInput) => Promise<ServerLogoutProviderResult>;
    suggestNewThreadTasks: (
      input: ServerSuggestNewThreadTasksInput,
    ) => Promise<ServerSuggestNewThreadTasksResult>;
    onErrorInboxUpdated: (callback: (payload: ServerErrorInboxUpdatedPayload) => void) => () => void;
  };
  provider: {
    getComposerCapabilities: (
      input: ProviderGetComposerCapabilitiesInput,
    ) => Promise<ProviderComposerCapabilities>;
    listCommands: (input: ProviderListCommandsInput) => Promise<ProviderListCommandsResult>;
    listSkills: (input: ProviderListSkillsInput) => Promise<ProviderListSkillsResult>;
    listPlugins: (input: ProviderListPluginsInput) => Promise<ProviderListPluginsResult>;
    readPlugin: (input: ProviderReadPluginInput) => Promise<ProviderReadPluginResult>;
    listModels: (input: ProviderListModelsInput) => Promise<ProviderListModelsResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
  browser: {
    getState: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    open: (input: BrowserOpenInput) => Promise<BrowserSessionSnapshot>;
    closePane: () => Promise<void>;
    newTab: (input: BrowserCreateTabInput) => Promise<BrowserSessionSnapshot>;
    activateTab: (input: BrowserActivateTabInput) => Promise<BrowserSessionSnapshot>;
    closeTab: (input: BrowserCloseTabInput) => Promise<BrowserSessionSnapshot>;
    navigate: (input: BrowserNavigateInput) => Promise<BrowserSessionSnapshot>;
    back: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    forward: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    reload: (input: BrowserProjectInput) => Promise<BrowserSessionSnapshot>;
    kill: (input: BrowserProjectInput) => Promise<void>;
    setInspectMode: (input: BrowserSetInspectModeInput) => Promise<BrowserSessionSnapshot>;
    captureInspectSelection: (input: BrowserProjectInput) => Promise<BrowserInspectCapture | null>;
    onEvent: (callback: (event: BrowserRuntimeEvent) => void) => () => void;
  };
}
