import type {
  GitCloneInput,
  GitCloneResult,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDiffInput,
  GitDiffResult,
  GitFilePreviewInput,
  GitFilePreviewResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitReviewActionInput,
  GitReviewActionResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  BrowserActivateTabInput,
  BrowserClearBrowsingDataInput,
  BrowserCloseTabInput,
  BrowserCreateTabInput,
  BrowserInspectCapture,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserProjectInput,
  BrowserRuntimeEvent,
  BrowserSessionSnapshot,
  BrowserSetInspectModeInput,
  BrowserUseSettings,
  BrowserUseSettingsPatch,
} from "./browser";
import type {
  ComputerUseListAppsResult,
  ComputerUseSettings,
  ComputerUseSettingsPatch,
} from "./computerUse";
import type {
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectListTreeInput,
  ProjectListTreeResult,
  ProjectFileMetadataInput,
  ProjectFileMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
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
  ServerGetSettingsResult,
  ServerLogoutProviderInput,
  ServerLogoutProviderResult,
  ServerProviderUpdateStatusPayload,
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
  ServerUpdateProviderInput,
  ServerUpdateProviderResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalListInput,
  TerminalListResult,
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
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProviderApprovalDecision,
} from "./orchestration";
import type { ApprovalRequestId, ProjectId, ThreadId } from "./baseSchemas";
import type { UserInputQuestion } from "./providerRuntime";
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
import type { ProviderPrewarmSessionInput, ProviderPrewarmSessionResult } from "./provider";
import type {
  RemoteAccessCreatePairingLinkInput,
  RemoteAccessCreatePairingLinkResult,
  RemoteAccessRevokeClientInput,
  RemoteAccessRevokePairingLinkInput,
  RemoteAccessSetNetworkAccessInput,
  RemoteAccessSetTailscaleHttpsInput,
  RemoteAccessSnapshot,
} from "./remoteAccess";

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
  kind: "turn_completed" | "user_input_required" | "approval_required";
  notificationId: string;
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  body: string;
  silent?: boolean;
}

export interface DesktopNotificationQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface DesktopNotificationQuestion extends Omit<UserInputQuestion, "options"> {
  options: ReadonlyArray<DesktopNotificationQuestionOption>;
}

export interface DesktopTurnCompletedNotificationInput extends DesktopNotificationInput {
  kind: "turn_completed";
}

export interface DesktopApprovalRequiredNotificationInput extends DesktopNotificationInput {
  kind: "approval_required";
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  detail?: string;
}

export interface DesktopUserInputRequiredNotificationInput extends DesktopNotificationInput {
  kind: "user_input_required";
  requestId: ApprovalRequestId;
  questions: ReadonlyArray<DesktopNotificationQuestion>;
}

export type DesktopNotificationPayload =
  | DesktopTurnCompletedNotificationInput
  | DesktopApprovalRequiredNotificationInput
  | DesktopUserInputRequiredNotificationInput;

export type DesktopNotificationAction =
  | {
      kind: "open_thread";
      notificationId: string;
      threadId: ThreadId;
      projectId: ProjectId;
    }
  | {
      kind: "approval_response";
      notificationId: string;
      threadId: ThreadId;
      projectId: ProjectId;
      requestId: ApprovalRequestId;
      decision: ProviderApprovalDecision;
    }
  | {
      kind: "user_input_response";
      notificationId: string;
      threadId: ThreadId;
      projectId: ProjectId;
      requestId: ApprovalRequestId;
      answers: Record<string, string>;
    };

export interface DesktopNotificationFallbackAction {
  type: "open-thread";
  label: string;
}

export interface DesktopNotificationFallbackInput {
  title: string;
  body: string;
  silent?: boolean;
  action?: DesktopNotificationFallbackAction;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getWindowChromeMetrics: () => DesktopWindowChromeMetrics;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  getPathForFile: (file: unknown) => string | null;
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
    show: (input: DesktopNotificationPayload) => Promise<boolean>;
    onAction: (listener: (action: DesktopNotificationAction) => void) => () => void;
    consumePendingActions: () => Promise<DesktopNotificationAction[]>;
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
    getSettings: () => Promise<BrowserUseSettings>;
    updateSettings: (input: BrowserUseSettingsPatch) => Promise<BrowserUseSettings>;
    clearBrowsingData: (input: BrowserClearBrowsingDataInput) => Promise<void>;
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
    list: (input: TerminalListInput) => Promise<TerminalListResult>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    listDirectory: (input: ProjectListDirectoryInput) => Promise<ProjectListDirectoryResult>;
    listTree: (input: ProjectListTreeInput) => Promise<ProjectListTreeResult>;
    fileMetadata: (input: ProjectFileMetadataInput) => Promise<ProjectFileMetadataResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    createDirectory: (input: ProjectCreateDirectoryInput) => Promise<ProjectCreateDirectoryResult>;
    renameEntry: (input: ProjectRenameEntryInput) => Promise<ProjectRenameEntryResult>;
    deleteEntry: (input: ProjectDeleteEntryInput) => Promise<ProjectDeleteEntryResult>;
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
    diff: (input: GitDiffInput) => Promise<GitDiffResult>;
    filePreview: (input: GitFilePreviewInput) => Promise<GitFilePreviewResult>;
    reviewAction: (input: GitReviewActionInput) => Promise<GitReviewActionResult>;
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
    getSettings: () => Promise<ServerGetSettingsResult>;
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
    updateProvider: (input: ServerUpdateProviderInput) => Promise<ServerUpdateProviderResult>;
    suggestNewThreadTasks: (
      input: ServerSuggestNewThreadTasksInput,
    ) => Promise<ServerSuggestNewThreadTasksResult>;
    updateSettings: (input: ServerUpdateSettingsInput) => Promise<ServerUpdateSettingsResult>;
    onProviderUpdateStatus: (
      callback: (payload: ServerProviderUpdateStatusPayload) => void,
    ) => () => void;
    onErrorInboxUpdated: (
      callback: (payload: ServerErrorInboxUpdatedPayload) => void,
    ) => () => void;
  };
  computerUse: {
    listApps: () => Promise<ComputerUseListAppsResult>;
    getSettings: () => Promise<ComputerUseSettings>;
    updateSettings: (input: ComputerUseSettingsPatch) => Promise<ComputerUseSettings>;
  };
  remoteAccess: {
    getSnapshot: () => Promise<RemoteAccessSnapshot>;
    createPairingLink: (
      input: RemoteAccessCreatePairingLinkInput,
    ) => Promise<RemoteAccessCreatePairingLinkResult>;
    revokePairingLink: (input: RemoteAccessRevokePairingLinkInput) => Promise<RemoteAccessSnapshot>;
    revokeClient: (input: RemoteAccessRevokeClientInput) => Promise<RemoteAccessSnapshot>;
    revokeOtherClients: () => Promise<RemoteAccessSnapshot>;
    setNetworkAccess: (input: RemoteAccessSetNetworkAccessInput) => Promise<RemoteAccessSnapshot>;
    setTailscaleHttps: (
      input: RemoteAccessSetTailscaleHttpsInput,
    ) => Promise<RemoteAccessSnapshot>;
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
    prewarmSession: (
      input: ProviderPrewarmSessionInput,
    ) => Promise<ProviderPrewarmSessionResult>;
  };
  orchestration: {
    getSnapshot: (input?: OrchestrationGetSnapshotInput) => Promise<OrchestrationReadModel>;
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
    getSettings: () => Promise<BrowserUseSettings>;
    updateSettings: (input: BrowserUseSettingsPatch) => Promise<BrowserUseSettings>;
    clearBrowsingData: (input: BrowserClearBrowsingDataInput) => Promise<void>;
    setInspectMode: (input: BrowserSetInspectModeInput) => Promise<BrowserSessionSnapshot>;
    captureInspectSelection: (input: BrowserProjectInput) => Promise<BrowserInspectCapture | null>;
    onEvent: (callback: (event: BrowserRuntimeEvent) => void) => () => void;
  };
}
