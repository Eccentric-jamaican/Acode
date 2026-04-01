import type {
  ErrorInboxEntry as ContractErrorInboxEntry,
  OrchestrationLatestTurn,
  OrchestrationProjectRules as ContractOrchestrationProjectRules,
  OrchestrationProposedPlanId,
  OrchestrationSessionStatus,
  OrchestrationTask as ContractOrchestrationTask,
  OrchestrationTaskRuntime as ContractOrchestrationTaskRuntime,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  TaskId,
  TurnId,
  MessageId,
  CheckpointRef,
  ProviderKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_THREAD_TERMINAL_COUNT = 4;
export type ProjectScript = ContractProjectScript;
export type TaskState = ContractOrchestrationTask["state"];
export type TaskRuntimeStatus = ContractOrchestrationTaskRuntime["status"];

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: ProjectId;
  name: string;
  cwd: string;
  model: string;
  expanded: boolean;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  origin: "user" | "task";
  taskId: TaskId | null;
  title: string;
  model: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  latestTurn: OrchestrationLatestTurn | null;
  lastVisitedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  isPinned: boolean;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  brief: string;
  acceptanceCriteria: string;
  attachments: ChatAttachment[];
  state: TaskState;
  priority: number | null;
  threadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRuntime {
  taskId: TaskId;
  status: TaskRuntimeStatus;
  activeTurnId: TurnId | null;
  lastError: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

export interface ErrorInboxEntry extends ContractErrorInboxEntry {}

export interface ProjectRules extends ContractOrchestrationProjectRules {}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
