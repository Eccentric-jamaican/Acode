import {
  type ComponentProps,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  EllipsisIcon,
  EyeOffIcon,
  FilterIcon,
  InboxIcon,
  KanbanSquareIcon,
  LayoutListIcon,
  Link2Icon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Settings2Icon,
  SquareIcon,
} from "lucide-react";
import type { RuntimeMode } from "@t3tools/contracts";

import { readNativeApi } from "~/nativeApi";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn, newCommandId, newTaskId } from "~/lib/utils";
import { useStore } from "~/store";
import type { ProjectRules, TaskRuntimeStatus, TaskState } from "~/types";
import AppPageShell from "~/components/AppPageShell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "~/components/ui/sheet";
import { SidebarInsetTrigger } from "~/components/ui/sidebar";
import { Toggle } from "~/components/ui/toggle";
import { toastManager } from "~/components/ui/toast";
import { DEFAULT_ORCHESTRATE_FILTERS, type OrchestrateFilters } from "./orchestrateFilters";
import { DEFAULT_HIDDEN_STATES, hiddenTaskStates, visibleTaskStates } from "./orchestrateLayout";
import { TaskContextEditor } from "./TaskContextEditor";
import {
  buildErrorInboxCollection,
  filterErrorInboxCollection,
  relativeErrorTimeLabel,
  sortErrorInboxCollection,
} from "./errorInboxModel";
import {
  buildTaskWithRuntimeCollection,
  filterTaskCollection,
  formatRuntimeLabel,
  formatTaskKey,
  formatTaskStateLabel,
  groupTasksByProject,
  groupTasksByState,
  relativeTimeLabel,
  sortTaskCollection,
  taskMetaLine,
  taskNeedsAttention,
  type OrchestrateView,
  type TaskWithRuntime,
} from "./orchestrateModel";
import {
  cloneTaskDraftImageAttachments,
  revokeTaskDraftAttachmentPreviewUrls,
  taskDraftAttachmentsFromTask,
  toTaskCommandAttachments,
  type TaskDraftImageAttachment,
} from "./taskContextAttachments";

const ORCHESTRATE_RUNTIME_OPTIONS: RuntimeMode[] = ["approval-required", "full-access"];

const TASK_STATE_OPTIONS: readonly TaskState[] = [
  "backlog",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

const TASK_RUNTIME_FILTER_OPTIONS: ReadonlyArray<TaskRuntimeStatus | "all"> = [
  "all",
  "idle",
  "queued",
  "starting",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "retrying",
  "error",
  "stopped",
] as const;

type RouteSearchProps = {
  projectIdFromSearch?: string | undefined;
  taskIdFromSearch?: string | undefined;
  viewFromSearch?: OrchestrateView | undefined;
};

type TaskDraft = {
  title: string;
  brief: string;
  briefCursor: number;
  attachments: Array<TaskDraftImageAttachment>;
  acceptanceCriteria: string;
  priority: string;
  projectId: string;
  initialState: TaskState;
  runtimeMode: RuntimeMode;
  startImmediately: boolean;
};

type DetailDraft = {
  title: string;
  brief: string;
  briefCursor: number;
  attachments: Array<TaskDraftImageAttachment>;
  acceptanceCriteria: string;
  priority: string;
  state: TaskState;
};

type RulesDraft = {
  promptTemplate: string;
  defaultModel: string;
  defaultRuntimeMode: RuntimeMode;
  onSuccessMoveTo: TaskState;
  onFailureMoveTo: TaskState;
};

function buildSearch(input: {
  projectId?: string | undefined;
  taskId?: string | undefined;
  view?: OrchestrateView | undefined;
}) {
  return {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.view ? { view: input.view } : {}),
  };
}

function runtimeBadgeVariant(
  status: TaskRuntimeStatus | null,
): ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "error":
      return "error";
    case "awaiting_approval":
    case "awaiting_input":
    case "retrying":
      return "warning";
    case "running":
    case "starting":
    case "queued":
      return "info";
    case "stopped":
      return "secondary";
    case "idle":
    default:
      return "outline";
  }
}

function runtimeIcon(status: TaskRuntimeStatus | null) {
  switch (status) {
    case "running":
    case "starting":
    case "queued":
      return LoaderCircleIcon;
    case "error":
      return CircleAlertIcon;
    case "awaiting_approval":
    case "awaiting_input":
      return CirclePauseIcon;
    case "retrying":
      return RotateCcwIcon;
    case "stopped":
      return SquareIcon;
    case "idle":
    default:
      return CircleDashedIcon;
  }
}

function errorSeverityVariant(
  severity: "error" | "warning",
): ComponentProps<typeof Badge>["variant"] {
  return severity === "error" ? "error" : "warning";
}

function errorSeverityLabel(severity: "error" | "warning"): string {
  return severity === "error" ? "Error" : "Warning";
}

function stateDotClass(state: TaskState): string {
  switch (state) {
    case "running":
      return "bg-info";
    case "review":
      return "bg-warning";
    case "blocked":
      return "bg-destructive";
    case "done":
      return "bg-success";
    case "ready":
      return "bg-foreground/35";
    case "backlog":
    default:
      return "bg-muted-foreground/30";
  }
}

function defaultTaskDraft(projectId: string | null, projectRules: ProjectRules | null): TaskDraft {
  return {
    title: "",
    brief: "",
    briefCursor: 0,
    attachments: [],
    acceptanceCriteria: "",
    priority: "",
    projectId: projectId ?? "",
    initialState: "backlog",
    runtimeMode: projectRules?.defaultRuntimeMode ?? "full-access",
    startImmediately: false,
  };
}

function defaultRulesDraft(projectRules: ProjectRules | null): RulesDraft {
  return {
    promptTemplate: projectRules?.promptTemplate ?? "",
    defaultModel: projectRules?.defaultModel ?? "",
    defaultRuntimeMode: projectRules?.defaultRuntimeMode ?? "full-access",
    onSuccessMoveTo: projectRules?.onSuccessMoveTo ?? "review",
    onFailureMoveTo: projectRules?.onFailureMoveTo ?? "blocked",
  };
}

function normalizePriorityDraft(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.replaceAll(/[^\d]/g, "");
}

function parsePriorityDraft(value: string): number | null | "invalid" {
  const normalized = normalizePriorityDraft(value);
  if (normalized.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "invalid";
  }
  return parsed;
}

function TaskRuntimePill({ task }: { task: TaskWithRuntime }) {
  const status = task.runtime?.status ?? null;
  if (!status || status === "idle") {
    return null;
  }
  const Icon = runtimeIcon(status);
  return (
    <Badge
      variant={runtimeBadgeVariant(status)}
      size="sm"
      className="gap-1 rounded-full px-1.5 text-[10px] font-medium"
    >
      <Icon
        className={cn(
          "size-3",
          status === "running" || status === "starting" ? "animate-spin" : "",
        )}
      />
      <span>{formatRuntimeLabel(status)}</span>
    </Badge>
  );
}

function TaskCard({
  task,
  highlighted,
  onSelect,
  onOpenDetails,
  onOpenThread,
  onStart,
  onStop,
  onRetry,
  onQuickCreate,
  onMoveTask,
}: {
  task: TaskWithRuntime;
  highlighted: boolean;
  onSelect: () => void;
  onOpenDetails: () => void;
  onOpenThread: (() => void) | null;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  onQuickCreate: () => void;
  onMoveTask: (state: TaskState) => void;
}) {
  const needsAttention = taskNeedsAttention(task.task, task.runtime);
  const isRunning =
    task.runtime?.status === "running" ||
    task.runtime?.status === "starting" ||
    task.runtime?.status === "queued";

  return (
    <div
      draggable
      onClick={onSelect}
      onDoubleClick={onOpenDetails}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.task.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group/task relative rounded-2xl border bg-card p-3 text-left shadow-xs/5 transition-colors",
        highlighted
          ? "border-foreground/18 bg-accent/35"
          : "border-border/80 hover:border-border hover:bg-accent/20",
      )}
      data-testid={`orchestrate-task-card-${task.task.id}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/72">
            <span className="truncate">{formatTaskKey(task.task.id)}</span>
            {needsAttention ? <span className="h-1.5 w-1.5 rounded-full bg-destructive" /> : null}
          </div>
          <p
            className="mt-1 line-clamp-2 text-[clamp(0.88rem,0.84rem+0.14vw,0.98rem)] font-medium leading-[1.25] text-foreground text-pretty"
            title={task.task.title}
          >
            {task.task.title}
          </p>
          <p
            className="mt-2 truncate text-[11px] text-muted-foreground/78 tabular-nums"
            title={taskMetaLine(task)}
          >
            {taskMetaLine(task)}
          </p>
        </div>

        <Menu>
          <MenuTrigger
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover/task:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
            aria-label="Task actions"
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuItem onClick={onOpenDetails}>Open details</MenuItem>
            {onOpenThread ? <MenuItem onClick={onOpenThread}>Open thread</MenuItem> : null}
            <MenuSeparator />
            {TASK_STATE_OPTIONS.map((state) => (
              <MenuItem key={state} onClick={() => onMoveTask(state)}>
                Move to {formatTaskStateLabel(state)}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={onQuickCreate}>New task here</MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", stateDotClass(task.task.state))} />
          <TaskRuntimePill task={task} />
          {task.task.threadId ? (
            <Badge variant="outline" size="sm" className="rounded-full px-1.5 text-[10px]">
              <Link2Icon className="size-3" />
            </Badge>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover/task:opacity-100 group-focus-within/task:opacity-100">
          {isRunning ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Stop task"
              onClick={(event) => {
                event.stopPropagation();
                onStop();
              }}
            >
              <SquareIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Start task"
              onClick={(event) => {
                event.stopPropagation();
                onStart();
              }}
            >
              <CirclePlayIcon className="size-3.5" />
            </Button>
          )}
          {task.runtime?.status === "error" || task.task.state === "blocked" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Retry task"
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
            >
              <RotateCcwIcon className="size-3.5" />
            </Button>
          ) : null}
          {onOpenThread ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open thread"
              onClick={(event) => {
                event.stopPropagation();
                onOpenThread();
              }}
            >
              <ArrowUpRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function OrchestrateRouteView({
  projectIdFromSearch,
  taskIdFromSearch,
  viewFromSearch,
}: RouteSearchProps) {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const tasks = useStore((store) => store.tasks);
  const taskRuntimes = useStore((store) => store.taskRuntimes);
  const errorInbox = useStore((store) => store.errorInbox);
  const threads = useStore((store) => store.threads);
  const projectRules = useStore((store) => store.projectRules);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const showHiddenRail = useMediaQuery("(min-width: 1480px)");

  const resolvedView = viewFromSearch ?? (isMobile ? "list" : "board");
  const selectedProject =
    projectIdFromSearch === "all"
      ? null
      : (projects.find((project) => project.id === projectIdFromSearch) ?? projects[0] ?? null);
  const selectedProjectId = projectIdFromSearch === "all" ? null : (selectedProject?.id ?? null);
  const selectedProjectRules =
    projectRules.find((rules) => rules.projectId === selectedProjectId) ?? null;
  const selectedTaskFromSearch =
    tasks.find((task) => task.id === taskIdFromSearch && task.projectId === selectedProjectId) ??
    null;

  const [filters, setFilters] = useState<OrchestrateFilters>(DEFAULT_ORCHESTRATE_FILTERS);
  const [hiddenStates, setHiddenStates] = useState<Set<TaskState>>(
    () => new Set(DEFAULT_HIDDEN_STATES),
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [projectRulesOpen, setProjectRulesOpen] = useState(false);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const [selectedInboxEntryId, setSelectedInboxEntryId] = useState<string | null>(null);
  const [includeResolvedInboxEntries, setIncludeResolvedInboxEntries] = useState(false);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(() =>
    defaultTaskDraft(selectedProjectId, selectedProjectRules),
  );
  const taskDraftProject =
    projects.find((project) => project.id === taskDraft.projectId) ?? selectedProject ?? null;
  const [rulesDraft, setRulesDraft] = useState<RulesDraft>(() =>
    defaultRulesDraft(selectedProjectRules),
  );
  const [savingTask, setSavingTask] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [detailDraft, setDetailDraft] = useState<DetailDraft>({
    title: "",
    brief: "",
    briefCursor: 0,
    attachments: [],
    acceptanceCriteria: "",
    priority: "",
    state: "backlog",
  });

  const deferredSearch = useDeferredValue(filters.search);
  const normalizedFilters = useMemo(
    () => ({ ...filters, search: deferredSearch }),
    [deferredSearch, filters],
  );
  const taskCollection = useMemo(
    () =>
      buildTaskWithRuntimeCollection({
        tasks,
        taskRuntimes,
        threads,
        projects,
        projectRules,
      }),
    [projectRules, projects, taskRuntimes, tasks, threads],
  );
  const filteredTasks = useMemo(
    () => filterTaskCollection(taskCollection, normalizedFilters, selectedProjectId ?? "all"),
    [normalizedFilters, selectedProjectId, taskCollection],
  );
  const errorInboxCollection = useMemo(
    () =>
      buildErrorInboxCollection({
        entries: errorInbox,
        projects,
        tasks,
        threads,
      }),
    [errorInbox, projects, tasks, threads],
  );
  const filteredErrorInbox = useMemo(
    () =>
      filterErrorInboxCollection(errorInboxCollection, {
        selectedProjectId,
        search: normalizedFilters.search,
        includeResolved: includeResolvedInboxEntries,
      }),
    [
      errorInboxCollection,
      includeResolvedInboxEntries,
      normalizedFilters.search,
      selectedProjectId,
    ],
  );
  const sortedErrorInbox = useMemo(
    () => sortErrorInboxCollection(filteredErrorInbox),
    [filteredErrorInbox],
  );
  const selectedErrorInboxEntry =
    sortedErrorInbox.find((entry) => entry.entry.id === selectedInboxEntryId) ??
    sortedErrorInbox[0] ??
    null;
  const selectedErrorInboxLinkedTask = selectedErrorInboxEntry?.linkedTask ?? null;
  const selectedErrorInboxThread = selectedErrorInboxEntry?.thread ?? null;
  const sortedTasks = useMemo(() => sortTaskCollection(filteredTasks), [filteredTasks]);
  const tasksByState = useMemo(() => groupTasksByState(sortedTasks), [sortedTasks]);
  const tasksByProject = useMemo(() => groupTasksByProject(sortedTasks), [sortedTasks]);
  const currentTask =
    taskCollection.find((entry) => entry.task.id === selectedTaskFromSearch?.id) ?? null;
  const visibleStates = useMemo(() => visibleTaskStates(hiddenStates), [hiddenStates]);
  const hiddenStatesList = useMemo(() => hiddenTaskStates(hiddenStates), [hiddenStates]);

  const buildTaskDraftForProject = (projectId: string | null): TaskDraft =>
    defaultTaskDraft(
      projectId,
      projectRules.find((rules) => rules.projectId === projectId) ?? null,
    );

  const openNewTaskDialog = (overrides?: {
    initialState?: TaskState;
    projectId?: string | undefined;
  }) => {
    const nextProjectId = overrides?.projectId ?? selectedProjectId;
    setTaskDraft((current) => {
      revokeTaskDraftAttachmentPreviewUrls(current.attachments);
      return {
        ...buildTaskDraftForProject(nextProjectId),
        ...(overrides?.initialState !== undefined ? { initialState: overrides.initialState } : {}),
        ...(overrides?.projectId !== undefined ? { projectId: overrides.projectId } : {}),
      };
    });
    setNewTaskOpen(true);
  };

  const handleNewTaskDialogOpenChange = (open: boolean) => {
    if (!open) {
      setTaskDraft((current) => {
        revokeTaskDraftAttachmentPreviewUrls(current.attachments);
        return buildTaskDraftForProject(selectedProjectId);
      });
    }
    setNewTaskOpen(open);
  };

  useEffect(() => {
    setTaskDraft((current) => {
      revokeTaskDraftAttachmentPreviewUrls(current.attachments);
      return defaultTaskDraft(selectedProjectId, selectedProjectRules);
    });
  }, [selectedProjectId, selectedProjectRules]);

  useEffect(() => {
    setRulesDraft(defaultRulesDraft(selectedProjectRules));
  }, [selectedProjectRules]);

  useEffect(() => {
    if (!selectedErrorInboxEntry) {
      if (selectedInboxEntryId !== null) {
        setSelectedInboxEntryId(null);
      }
      return;
    }
    if (selectedInboxEntryId !== selectedErrorInboxEntry.entry.id) {
      setSelectedInboxEntryId(selectedErrorInboxEntry.entry.id);
    }
  }, [selectedErrorInboxEntry, selectedInboxEntryId]);

  useEffect(() => {
    setDetailDraft((current) => {
      revokeTaskDraftAttachmentPreviewUrls(current.attachments);
      if (!currentTask) {
        return {
          title: "",
          brief: "",
          briefCursor: 0,
          attachments: [],
          acceptanceCriteria: "",
          priority: "",
          state: "backlog",
        };
      }
      return {
        title: currentTask.task.title,
        brief: currentTask.task.brief,
        briefCursor: currentTask.task.brief.length,
        attachments: taskDraftAttachmentsFromTask(
          currentTask.task.attachments.filter((attachment) => attachment.type === "image"),
        ),
        acceptanceCriteria: currentTask.task.acceptanceCriteria,
        priority: currentTask.task.priority === null ? "" : String(currentTask.task.priority),
        state: currentTask.task.state,
      };
    });
  }, [currentTask]);

  useEffect(() => {
    return () => {
      revokeTaskDraftAttachmentPreviewUrls(taskDraft.attachments);
      revokeTaskDraftAttachmentPreviewUrls(detailDraft.attachments);
    };
  }, [detailDraft.attachments, taskDraft.attachments]);

  const updateRoute = (input: {
    projectId?: string | null;
    taskId?: string | null;
    view?: OrchestrateView;
  }) => {
    const nextProjectId = input.projectId === undefined ? selectedProjectId : input.projectId;
    const nextTaskId =
      input.taskId === undefined ? (selectedTaskFromSearch?.id ?? null) : input.taskId;
    const nextView = input.view ?? resolvedView;
    startTransition(() => {
      void navigate({
        to: "/orchestrate",
        search: buildSearch({
          projectId: nextProjectId ?? undefined,
          taskId: nextTaskId ?? undefined,
          view: nextView,
        }),
      });
    });
  };

  const dispatchCommand = async (command: object) => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Native API is unavailable.");
    }
    await api.orchestration.dispatchCommand(command as never);
  };

  const handleTaskAction = async (
    action: "start" | "stop" | "retry" | "delete",
    task: TaskWithRuntime,
  ) => {
    try {
      if (action === "start") {
        await dispatchCommand({
          type: "task.run.start",
          commandId: newCommandId(),
          taskId: task.task.id,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      if (action === "stop") {
        await dispatchCommand({
          type: "task.run.stop",
          commandId: newCommandId(),
          taskId: task.task.id,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      if (action === "retry") {
        await dispatchCommand({
          type: "task.run.retry",
          commandId: newCommandId(),
          taskId: task.task.id,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      await dispatchCommand({
        type: "task.delete",
        commandId: newCommandId(),
        taskId: task.task.id,
        createdAt: new Date().toISOString(),
      });
      if (selectedTaskFromSearch?.id === task.task.id) {
        updateRoute({ taskId: null });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Task action failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const handleMoveTask = async (task: TaskWithRuntime, state: TaskState) => {
    if (task.task.state === state) {
      return;
    }
    try {
      await dispatchCommand({
        type: "task.state.set",
        commandId: newCommandId(),
        taskId: task.task.id,
        state,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not move task",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const handleSetInboxResolution = async (
    entryId: string,
    resolution: "ignored" | "resolved" | null,
  ) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Native API is unavailable.",
      });
      return;
    }
    try {
      await api.server.setErrorInboxEntryResolution({ entryId, resolution });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update error inbox entry",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const handlePromoteInboxEntryToTask = async (entryId: string) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Native API is unavailable.",
      });
      return;
    }
    try {
      const result = await api.server.promoteErrorInboxEntryToTask({
        entryId,
        projectId: selectedProjectId ?? undefined,
      });
      setHighlightedTaskId(result.taskId);
      updateRoute({
        projectId: result.entry.projectId ?? selectedProjectId,
        taskId: result.taskId,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create task from error",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const openTaskDetails = (task: TaskWithRuntime) => {
    setHighlightedTaskId(task.task.id);
    updateRoute({ projectId: task.task.projectId, taskId: task.task.id });
  };

  const openThread = (task: TaskWithRuntime) => {
    if (!task.task.threadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: task.task.threadId },
    });
  };

  const openThreadById = (threadId: string) => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
    });
  };

  const handleCreateTask = async () => {
    if (!taskDraft.projectId || taskDraft.title.trim().length === 0) {
      toastManager.add({
        type: "error",
        title: "Task title required",
      });
      return;
    }
    const createdAt = new Date().toISOString();
    const taskId = newTaskId();
    const priorityValue = parsePriorityDraft(taskDraft.priority);

    if (priorityValue === "invalid") {
      toastManager.add({
        type: "error",
        title: "Priority must be a non-negative number",
      });
      return;
    }

    setSavingTask(true);
    try {
      const attachments = await toTaskCommandAttachments(taskDraft.attachments);
      await dispatchCommand({
        type: "task.create",
        commandId: newCommandId(),
        taskId,
        projectId: taskDraft.projectId,
        title: taskDraft.title.trim(),
        brief: taskDraft.brief.trim(),
        acceptanceCriteria: taskDraft.acceptanceCriteria.trim(),
        attachments,
        priority: priorityValue,
        state: taskDraft.initialState,
        createdAt,
      });

      if (taskDraft.startImmediately) {
        await dispatchCommand({
          type: "task.run.start",
          commandId: newCommandId(),
          taskId,
          createdAt: new Date().toISOString(),
        });
      }

      handleNewTaskDialogOpenChange(false);
      setHighlightedTaskId(taskId);
      updateRoute({ projectId: taskDraft.projectId, taskId, view: resolvedView });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create task",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSavingTask(false);
    }
  };

  const handleSaveTaskDetails = async () => {
    if (!currentTask) {
      return;
    }
    if (detailDraft.title.trim().length === 0) {
      toastManager.add({ type: "error", title: "Task title required" });
      return;
    }

    const nextPriority = parsePriorityDraft(detailDraft.priority);
    if (nextPriority === "invalid") {
      toastManager.add({ type: "error", title: "Priority must be a non-negative number" });
      return;
    }

    try {
      const attachments = await toTaskCommandAttachments(detailDraft.attachments);
      await dispatchCommand({
        type: "task.meta.update",
        commandId: newCommandId(),
        taskId: currentTask.task.id,
        title: detailDraft.title.trim(),
        brief: detailDraft.brief.trim(),
        acceptanceCriteria: detailDraft.acceptanceCriteria.trim(),
        attachments,
        priority: nextPriority,
        updatedAt: new Date().toISOString(),
      });

      if (detailDraft.state !== currentTask.task.state) {
        await dispatchCommand({
          type: "task.state.set",
          commandId: newCommandId(),
          taskId: currentTask.task.id,
          state: detailDraft.state,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save task",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const handleSaveRules = async () => {
    if (!selectedProjectId) {
      return;
    }
    setSavingRules(true);
    try {
      await dispatchCommand({
        type: "project.orchestration-rules.update",
        commandId: newCommandId(),
        projectId: selectedProjectId,
        promptTemplate: rulesDraft.promptTemplate,
        defaultModel:
          rulesDraft.defaultModel.trim().length > 0 ? rulesDraft.defaultModel.trim() : null,
        defaultRuntimeMode: rulesDraft.defaultRuntimeMode,
        onSuccessMoveTo: rulesDraft.onSuccessMoveTo,
        onFailureMoveTo: rulesDraft.onFailureMoveTo,
        createdAt: new Date().toISOString(),
      });
      setProjectRulesOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save project rules",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSavingRules(false);
    }
  };

  const emptyState =
    projects.length === 0 && resolvedView !== "inbox" ? (
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="rounded-3xl border border-dashed border-border px-6 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Add a project to start orchestrating work.
          </p>
        </div>
      </div>
    ) : null;

  return (
    <AppPageShell className="min-w-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-page-shell-surface)]">
        <header className="shrink-0 px-3 py-2.5 sm:px-5 md:min-h-[var(--app-desktop-content-header-height)] md:py-1.5">
          <div
            className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:gap-3"
            data-testid="orchestrate-top-header"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <SidebarInsetTrigger className="shrink-0 md:hidden" />
              <h1
                className="truncate text-[clamp(0.98rem,0.92rem+0.22vw,1.12rem)] font-medium text-foreground"
                data-testid="orchestrate-header-title"
              >
                Orchestrate
              </h1>

              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="xs"
                      className="max-w-40 justify-between rounded-full px-3"
                    >
                      <span className="truncate">
                        {projectIdFromSearch === "all"
                          ? "All projects"
                          : (selectedProject?.name ?? "No project")}
                      </span>
                    </Button>
                  }
                />
                <MenuPopup align="start" className="w-52">
                  <MenuItem onClick={() => updateRoute({ projectId: "all", taskId: null })}>
                    All projects
                  </MenuItem>
                  <MenuSeparator />
                  {projects.map((project) => (
                    <MenuItem
                      key={project.id}
                      onClick={() => updateRoute({ projectId: project.id, taskId: null })}
                    >
                      {project.name}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>

            <div className="flex basis-full flex-wrap items-center gap-1.5 sm:gap-2">
              <div
                className="desktop-top-edge-actions-safe flex flex-wrap items-center gap-1.5 sm:gap-2"
                data-testid="orchestrate-header-actions"
              >
                <div className="flex items-center rounded-full border border-border bg-background p-0.5 shadow-xs/5">
                  <Toggle
                    pressed={resolvedView === "board"}
                    onPressedChange={(pressed) => {
                      if (pressed) updateRoute({ view: "board" });
                    }}
                    variant="default"
                    size="xs"
                    aria-label="Board view"
                    className="rounded-full px-2.5"
                  >
                    <KanbanSquareIcon className="size-3.5" />
                    <span className="hidden sm:inline">Board</span>
                  </Toggle>
                  <Toggle
                    pressed={resolvedView === "list"}
                    onPressedChange={(pressed) => {
                      if (pressed) updateRoute({ view: "list" });
                    }}
                    variant="default"
                    size="xs"
                    aria-label="List view"
                    className="rounded-full px-2.5"
                  >
                    <LayoutListIcon className="size-3.5" />
                    <span className="hidden sm:inline">List</span>
                  </Toggle>
                  <Toggle
                    pressed={resolvedView === "inbox"}
                    onPressedChange={(pressed) => {
                      if (pressed) updateRoute({ view: "inbox" });
                    }}
                    variant="default"
                    size="xs"
                    aria-label="Inbox view"
                    className="rounded-full px-2.5"
                  >
                    <InboxIcon className="size-3.5" />
                    <span className="hidden sm:inline">Inbox</span>
                  </Toggle>
                </div>

                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="xs" className="rounded-full px-2.5">
                        <FilterIcon className="size-3.5" />
                        <span className="hidden sm:inline">Filter</span>
                      </Button>
                    }
                  />
                  <MenuPopup align="end" className="w-64">
                    <div className="p-2">
                      <div className="relative">
                        <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 size-3.5 text-muted-foreground/70" />
                        <Input
                          value={filters.search}
                          onChange={(event) =>
                            setFilters((current) => ({ ...current, search: event.target.value }))
                          }
                          placeholder={resolvedView === "inbox" ? "Search errors" : "Search tasks"}
                          size="sm"
                          className="pl-7"
                        />
                      </div>
                    </div>
                    {resolvedView === "inbox" ? (
                      <>
                        <MenuSeparator />
                        <MenuCheckboxItem
                          checked={includeResolvedInboxEntries}
                          onCheckedChange={(checked) =>
                            setIncludeResolvedInboxEntries(Boolean(checked))
                          }
                        >
                          Include resolved
                        </MenuCheckboxItem>
                      </>
                    ) : (
                      <>
                        <MenuSeparator />
                        <MenuGroup>
                          <MenuGroupLabel>State</MenuGroupLabel>
                          <MenuRadioGroup
                            value={filters.state}
                            onValueChange={(value) =>
                              setFilters((current) => ({
                                ...current,
                                state: (value as TaskState | "all") ?? "all",
                              }))
                            }
                          >
                            <MenuRadioItem value="all" indicatorPlacement="end">
                              All states
                            </MenuRadioItem>
                            {TASK_STATE_OPTIONS.map((state) => (
                              <MenuRadioItem key={state} value={state} indicatorPlacement="end">
                                {formatTaskStateLabel(state)}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuGroup>
                          <MenuGroupLabel>Runtime</MenuGroupLabel>
                          <MenuRadioGroup
                            value={filters.runtime}
                            onValueChange={(value) =>
                              setFilters((current) => ({
                                ...current,
                                runtime: (value as TaskRuntimeStatus | "all") ?? "all",
                              }))
                            }
                          >
                            {TASK_RUNTIME_FILTER_OPTIONS.map((status) => (
                              <MenuRadioItem key={status} value={status} indicatorPlacement="end">
                                {status === "all" ? "All runtimes" : formatRuntimeLabel(status)}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuCheckboxItem
                          checked={filters.needsAttention}
                          onCheckedChange={(checked) =>
                            setFilters((current) => ({
                              ...current,
                              needsAttention: Boolean(checked),
                            }))
                          }
                        >
                          Needs attention
                        </MenuCheckboxItem>
                        <MenuCheckboxItem
                          checked={filters.hasLinkedThread}
                          onCheckedChange={(checked) =>
                            setFilters((current) => ({
                              ...current,
                              hasLinkedThread: Boolean(checked),
                            }))
                          }
                        >
                          Has linked thread
                        </MenuCheckboxItem>
                      </>
                    )}
                  </MenuPopup>
                </Menu>

                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="xs" className="rounded-full px-2.5">
                        <Settings2Icon className="size-3.5" />
                        <span className="hidden sm:inline">Display</span>
                      </Button>
                    }
                  />
                  <MenuPopup align="end" className="w-48">
                    <MenuItem onClick={() => setProjectRulesOpen(true)}>Project rules</MenuItem>
                    {resolvedView !== "inbox" ? (
                      <>
                        <MenuSeparator />
                        <MenuCheckboxItem
                          checked={!hiddenStates.has("done")}
                          onCheckedChange={(checked) =>
                            setHiddenStates((current) => {
                              const next = new Set(current);
                              if (checked) {
                                next.delete("done");
                              } else {
                                next.add("done");
                              }
                              return next;
                            })
                          }
                        >
                          Show done
                        </MenuCheckboxItem>
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>

                <Button
                  onClick={() => openNewTaskDialog()}
                  size="xs"
                  className="rounded-full px-3"
                  disabled={!selectedProjectId || resolvedView === "inbox"}
                >
                  <PlusIcon className="size-3.5" />
                  <span className="hidden sm:inline">New task</span>
                </Button>
              </div>
            </div>
          </div>
        </header>

        {emptyState ? (
          emptyState
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <ScrollArea className="min-h-0 min-w-0 flex-1" scrollbarGutter>
              {resolvedView === "board" ? (
                <div
                  className="grid min-h-full min-w-full auto-cols-[minmax(18rem,1fr)] grid-flow-col gap-3 px-3 py-3 sm:px-4 sm:py-4"
                  data-testid="orchestrate-board-grid"
                >
                  {visibleStates.map((state) => {
                    const columnTasks = tasksByState.get(state) ?? [];
                    return (
                      <section
                        key={state}
                        className="flex min-h-full min-w-0 flex-col rounded-3xl border border-border/70 bg-muted/26 p-2"
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const taskId = event.dataTransfer.getData("text/plain");
                          const droppedTask = taskCollection.find(
                            (entry) => entry.task.id === taskId,
                          );
                          if (!droppedTask) return;
                          void handleMoveTask(droppedTask, state);
                        }}
                      >
                        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-2xl bg-muted/90 px-2 py-1.5 backdrop-blur-sm">
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {formatTaskStateLabel(state)}
                            </span>
                            <span className="text-[12px] tabular-nums text-muted-foreground/70">
                              {columnTasks.length}
                            </span>
                          </div>
                          <Menu>
                            <MenuTrigger className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                              <EllipsisIcon className="size-4" />
                            </MenuTrigger>
                            <MenuPopup align="end" className="w-40">
                              <MenuItem
                                onClick={() => {
                                  openNewTaskDialog({
                                    initialState: state,
                                    projectId: selectedProjectId ?? undefined,
                                  });
                                }}
                              >
                                New task
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Add ${formatTaskStateLabel(state)} task`}
                            onClick={() =>
                              openNewTaskDialog({
                                initialState: state,
                                projectId: selectedProjectId ?? undefined,
                              })
                            }
                          >
                            <PlusIcon className="size-3.5" />
                          </Button>
                        </div>

                        <div className="mt-2 flex min-h-[8rem] flex-1 flex-col gap-2">
                          {columnTasks.map((task) => (
                            <TaskCard
                              key={task.task.id}
                              task={task}
                              highlighted={
                                highlightedTaskId === task.task.id ||
                                selectedTaskFromSearch?.id === task.task.id
                              }
                              onSelect={() => setHighlightedTaskId(task.task.id)}
                              onOpenDetails={() => openTaskDetails(task)}
                              onOpenThread={task.task.threadId ? () => openThread(task) : null}
                              onStart={() => void handleTaskAction("start", task)}
                              onStop={() => void handleTaskAction("stop", task)}
                              onRetry={() => void handleTaskAction("retry", task)}
                              onQuickCreate={() =>
                                openNewTaskDialog({
                                  initialState: state,
                                  projectId: selectedProjectId ?? undefined,
                                })
                              }
                              onMoveTask={(nextState) => {
                                void handleMoveTask(task, nextState);
                              }}
                            />
                          ))}

                          {columnTasks.length === 0 ? (
                            <button
                              type="button"
                              className="flex h-10 items-center justify-center rounded-2xl border border-dashed border-border/70 text-muted-foreground transition-colors hover:border-border hover:bg-accent/20 hover:text-foreground"
                              onClick={() =>
                                openNewTaskDialog({
                                  initialState: state,
                                  projectId: selectedProjectId ?? undefined,
                                })
                              }
                            >
                              <PlusIcon className="size-4" />
                            </button>
                          ) : null}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : resolvedView === "list" ? (
                <div className="px-3 py-3 sm:px-4 sm:py-4">
                  <div className="space-y-5">
                    {projects
                      .filter((project) => tasksByProject.has(project.id))
                      .map((project) => {
                        const projectTasks = tasksByProject.get(project.id) ?? [];
                        return (
                          <section key={project.id} className="space-y-2">
                            <div className="flex items-center gap-2 px-1">
                              <h2 className="truncate text-[13px] font-medium text-foreground">
                                {project.name}
                              </h2>
                              <span className="text-[12px] tabular-nums text-muted-foreground/70">
                                {projectTasks.length}
                              </span>
                            </div>
                            <div className="overflow-hidden rounded-3xl border border-border/70 bg-card">
                              {projectTasks.map((task, index) => (
                                <button
                                  key={task.task.id}
                                  type="button"
                                  onClick={() => openTaskDetails(task)}
                                  className={cn(
                                    "flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-accent/20",
                                    index > 0 ? "border-t border-border/60" : "",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "h-2 w-2 shrink-0 rounded-full",
                                      stateDotClass(task.task.state),
                                    )}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="truncate text-sm font-medium text-foreground">
                                        {task.task.title}
                                      </span>
                                      <TaskRuntimePill task={task} />
                                    </div>
                                    <p className="mt-1 truncate text-[11px] text-muted-foreground/78 tabular-nums">
                                      {taskMetaLine(task)}
                                    </p>
                                  </div>
                                  <Badge variant="outline" size="sm" className="rounded-full px-2">
                                    {formatTaskStateLabel(task.task.state)}
                                  </Badge>
                                </button>
                              ))}
                            </div>
                          </section>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <div className="grid min-h-full min-w-0 grid-cols-1 xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
                  <div className="border-b border-border/70 xl:border-r xl:border-b-0">
                    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/70 bg-background/96 px-3 py-3 backdrop-blur-sm sm:px-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">Error inbox</p>
                        <p className="text-xs text-muted-foreground">
                          {sortedErrorInbox.length}{" "}
                          {sortedErrorInbox.length === 1 ? "entry" : "entries"}
                        </p>
                      </div>
                      {includeResolvedInboxEntries ? (
                        <Badge variant="outline" size="sm" className="rounded-full px-2">
                          Including resolved
                        </Badge>
                      ) : null}
                    </div>

                    {sortedErrorInbox.length === 0 ? (
                      <div className="px-4 py-10">
                        <div className="rounded-3xl border border-dashed border-border px-5 py-8 text-center">
                          <InboxIcon className="mx-auto size-5 text-muted-foreground/60" />
                          <p className="mt-3 text-sm text-muted-foreground">
                            No captured errors match the current filters.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/60">
                        {sortedErrorInbox.map((item) => {
                          const isSelected = selectedErrorInboxEntry?.entry.id === item.entry.id;
                          return (
                            <button
                              key={item.entry.id}
                              type="button"
                              onClick={() => setSelectedInboxEntryId(item.entry.id)}
                              className={cn(
                                "flex w-full flex-col items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-accent/20",
                                isSelected ? "bg-accent/35" : "bg-background",
                              )}
                            >
                              <div className="flex w-full items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="line-clamp-2 text-sm font-medium text-foreground">
                                    {item.entry.summary}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {item.entry.category} / {item.entry.source}
                                  </p>
                                </div>
                                <Badge
                                  variant={errorSeverityVariant(item.entry.severity)}
                                  size="sm"
                                  className="rounded-full px-2"
                                >
                                  {errorSeverityLabel(item.entry.severity)}
                                </Badge>
                              </div>

                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                <span>{relativeErrorTimeLabel(item.entry.lastSeenAt)}</span>
                                <span>{item.entry.occurrenceCount} hits</span>
                                <span>{item.project?.name ?? "Global"}</span>
                                {item.entry.linkedTaskId ? (
                                  <Badge variant="outline" size="sm" className="rounded-full px-2">
                                    Linked task
                                  </Badge>
                                ) : null}
                                {item.entry.resolution ? (
                                  <Badge
                                    variant="secondary"
                                    size="sm"
                                    className="rounded-full px-2"
                                  >
                                    {item.entry.resolution}
                                  </Badge>
                                ) : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    {selectedErrorInboxEntry ? (
                      <div className="flex min-h-full flex-col">
                        <div className="border-b border-border/70 px-4 py-4 sm:px-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                  variant={errorSeverityVariant(
                                    selectedErrorInboxEntry.entry.severity,
                                  )}
                                  size="sm"
                                  className="rounded-full px-2"
                                >
                                  {errorSeverityLabel(selectedErrorInboxEntry.entry.severity)}
                                </Badge>
                                <Badge variant="outline" size="sm" className="rounded-full px-2">
                                  {selectedErrorInboxEntry.entry.category}
                                </Badge>
                                <Badge variant="outline" size="sm" className="rounded-full px-2">
                                  {selectedErrorInboxEntry.entry.source}
                                </Badge>
                              </div>
                              <h2 className="mt-3 text-lg font-medium text-foreground">
                                {selectedErrorInboxEntry.entry.summary}
                              </h2>
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                  First seen{" "}
                                  {relativeErrorTimeLabel(
                                    selectedErrorInboxEntry.entry.firstSeenAt,
                                  )}
                                </span>
                                <span>
                                  Last seen{" "}
                                  {relativeErrorTimeLabel(selectedErrorInboxEntry.entry.lastSeenAt)}
                                </span>
                                <span>
                                  {selectedErrorInboxEntry.entry.occurrenceCount} occurrences
                                </span>
                                <span>
                                  Project{" "}
                                  {selectedErrorInboxEntry.project?.name ?? "Global / unresolved"}
                                </span>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {selectedErrorInboxLinkedTask ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="rounded-full px-3"
                                  onClick={() => {
                                    setHighlightedTaskId(selectedErrorInboxLinkedTask.id);
                                    updateRoute({
                                      projectId: selectedErrorInboxLinkedTask.projectId,
                                      taskId: selectedErrorInboxLinkedTask.id,
                                    });
                                  }}
                                >
                                  <ArrowUpRightIcon className="size-3.5" />
                                  <span>Open task</span>
                                </Button>
                              ) : (
                                <Button
                                  size="xs"
                                  className="rounded-full px-3"
                                  onClick={() =>
                                    void handlePromoteInboxEntryToTask(
                                      selectedErrorInboxEntry.entry.id,
                                    )
                                  }
                                >
                                  <PlusIcon className="size-3.5" />
                                  <span>Create task</span>
                                </Button>
                              )}
                              {selectedErrorInboxThread ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="rounded-full px-3"
                                  onClick={() => openThreadById(selectedErrorInboxThread.id)}
                                >
                                  <Link2Icon className="size-3.5" />
                                  <span>Open thread</span>
                                </Button>
                              ) : null}
                              <Button
                                size="xs"
                                variant="outline"
                                className="rounded-full px-3"
                                onClick={() =>
                                  void handleSetInboxResolution(
                                    selectedErrorInboxEntry.entry.id,
                                    "ignored",
                                  )
                                }
                              >
                                <EyeOffIcon className="size-3.5" />
                                <span>Ignore</span>
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                className="rounded-full px-3"
                                onClick={() =>
                                  void handleSetInboxResolution(
                                    selectedErrorInboxEntry.entry.id,
                                    "resolved",
                                  )
                                }
                              >
                                <CheckIcon className="size-3.5" />
                                <span>Resolve</span>
                              </Button>
                              {selectedErrorInboxEntry.entry.resolution ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  className="rounded-full px-3"
                                  onClick={() =>
                                    void handleSetInboxResolution(
                                      selectedErrorInboxEntry.entry.id,
                                      null,
                                    )
                                  }
                                >
                                  Reopen
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
                          <div className="space-y-4">
                            {selectedErrorInboxEntry.entry.detail ? (
                              <section className="space-y-2">
                                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                  Detail
                                </h3>
                                <div className="rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm whitespace-pre-wrap text-foreground">
                                  {selectedErrorInboxEntry.entry.detail}
                                </div>
                              </section>
                            ) : null}

                            <section className="space-y-2">
                              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                Latest context
                              </h3>
                              <pre className="overflow-x-auto rounded-2xl border border-border/70 bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
                                {JSON.stringify(
                                  selectedErrorInboxEntry.entry.latestContextJson,
                                  null,
                                  2,
                                )}
                              </pre>
                            </section>
                          </div>

                          <aside className="space-y-3">
                            <div className="rounded-2xl border border-border/70 bg-card p-4">
                              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                Metadata
                              </h3>
                              <dl className="mt-3 space-y-2 text-sm">
                                <div>
                                  <dt className="text-muted-foreground">Status</dt>
                                  <dd className="font-medium text-foreground">
                                    {selectedErrorInboxEntry.entry.resolution ?? "open"}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-muted-foreground">Provider</dt>
                                  <dd className="font-medium text-foreground">
                                    {selectedErrorInboxEntry.entry.provider ?? "n/a"}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-muted-foreground">Fingerprint</dt>
                                  <dd className="break-all font-mono text-[11px] text-foreground">
                                    {selectedErrorInboxEntry.entry.fingerprint}
                                  </dd>
                                </div>
                                {selectedErrorInboxEntry.entry.threadId ? (
                                  <div>
                                    <dt className="text-muted-foreground">Thread</dt>
                                    <dd className="break-all font-mono text-[11px] text-foreground">
                                      {selectedErrorInboxEntry.entry.threadId}
                                    </dd>
                                  </div>
                                ) : null}
                                {selectedErrorInboxEntry.entry.turnId ? (
                                  <div>
                                    <dt className="text-muted-foreground">Turn</dt>
                                    <dd className="break-all font-mono text-[11px] text-foreground">
                                      {selectedErrorInboxEntry.entry.turnId}
                                    </dd>
                                  </div>
                                ) : null}
                              </dl>
                            </div>
                          </aside>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-full items-center justify-center px-6 py-12">
                        <div className="rounded-3xl border border-dashed border-border px-6 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            Select an inbox entry to inspect the latest captured diagnostic.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {resolvedView !== "inbox" && sortedTasks.length === 0 ? (
                <div className="px-4 pb-10">
                  <div className="mx-auto flex max-w-sm flex-col items-center justify-center rounded-3xl border border-dashed border-border px-6 py-10 text-center">
                    <KanbanSquareIcon className="size-5 text-muted-foreground/60" />
                    <p className="mt-3 text-sm text-muted-foreground">No tasks yet.</p>
                    <Button
                      size="xs"
                      className="mt-4 rounded-full px-3"
                      onClick={() => openNewTaskDialog()}
                    >
                      <PlusIcon className="size-3.5" />
                      <span>New task</span>
                    </Button>
                  </div>
                </div>
              ) : null}
            </ScrollArea>

            {resolvedView === "board" && showHiddenRail && hiddenStatesList.length > 0 ? (
              <aside className="hidden w-56 shrink-0 border-l border-border/70 px-3 py-4 xl:block">
                <div className="px-1">
                  <p className="text-[12px] font-medium text-muted-foreground">Hidden columns</p>
                </div>
                <div className="mt-3 space-y-1">
                  {hiddenStatesList.map((state) => (
                    <button
                      key={state}
                      type="button"
                      className="flex w-full items-center justify-between rounded-2xl border border-border/70 bg-card px-3 py-3 text-left hover:bg-accent/20"
                      onClick={() =>
                        setHiddenStates((current) => {
                          const next = new Set(current);
                          next.delete(state);
                          return next;
                        })
                      }
                    >
                      <span className="text-sm font-medium text-foreground">
                        {formatTaskStateLabel(state)}
                      </span>
                      <PlusIcon className="size-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </aside>
            ) : null}
          </div>
        )}
      </div>

      <Dialog open={newTaskOpen} onOpenChange={handleNewTaskDialogOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Title</span>
              <Input
                autoFocus
                value={taskDraft.title}
                onChange={(event) =>
                  setTaskDraft((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Task title"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Project</span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="outline" className="w-full justify-between">
                        <span className="truncate">
                          {projects.find((project) => project.id === taskDraft.projectId)?.name ??
                            "Select project"}
                        </span>
                      </Button>
                    }
                  />
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    {projects.map((project) => (
                      <MenuItem
                        key={project.id}
                        onClick={() =>
                          setTaskDraft((current) => ({ ...current, projectId: project.id }))
                        }
                      >
                        {project.name}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">State</span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="outline" className="w-full justify-between">
                        {formatTaskStateLabel(taskDraft.initialState)}
                      </Button>
                    }
                  />
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    {TASK_STATE_OPTIONS.map((state) => (
                      <MenuItem
                        key={state}
                        onClick={() =>
                          setTaskDraft((current) => ({ ...current, initialState: state }))
                        }
                      >
                        {formatTaskStateLabel(state)}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-foreground">Brief</span>
              <TaskContextEditor
                workspaceRoot={taskDraftProject?.cwd ?? null}
                value={taskDraft.brief}
                cursor={taskDraft.briefCursor}
                attachments={taskDraft.attachments}
                placeholder="Describe the task. Use @ to reference files."
                onChange={(brief, briefCursor) =>
                  setTaskDraft((current) => ({ ...current, brief, briefCursor }))
                }
                onAttachmentsChange={(attachments) =>
                  setTaskDraft((current) => ({
                    ...current,
                    attachments: cloneTaskDraftImageAttachments(attachments),
                  }))
                }
                onError={(message) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not attach image",
                    description: message,
                  });
                }}
              />
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Acceptance</span>
              <textarea
                value={taskDraft.acceptanceCriteria}
                onChange={(event) =>
                  setTaskDraft((current) => ({
                    ...current,
                    acceptanceCriteria: event.target.value,
                  }))
                }
                rows={4}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Definition of done"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Priority</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  name="task-priority"
                  value={taskDraft.priority}
                  onChange={(event) =>
                    setTaskDraft((current) => ({
                      ...current,
                      priority: normalizePriorityDraft(event.target.value),
                    }))
                  }
                  inputMode="numeric"
                  placeholder="0+"
                  nativeInput
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Runtime</span>
                <div className="flex items-center gap-2 rounded-full border border-border p-1">
                  {ORCHESTRATE_RUNTIME_OPTIONS.map((runtimeMode) => (
                    <Toggle
                      key={runtimeMode}
                      pressed={taskDraft.runtimeMode === runtimeMode}
                      onPressedChange={(pressed) => {
                        if (pressed) {
                          setTaskDraft((current) => ({ ...current, runtimeMode }));
                        }
                      }}
                      size="xs"
                      className="rounded-full px-2.5"
                    >
                      {runtimeMode === "full-access" ? "Full access" : "Approval"}
                    </Toggle>
                  ))}
                </div>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={taskDraft.startImmediately}
                onChange={(event) =>
                  setTaskDraft((current) => ({
                    ...current,
                    startImmediately: event.target.checked,
                  }))
                }
                className="size-4 rounded border border-input"
              />
              <span>Start immediately</span>
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => handleNewTaskDialogOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateTask()} disabled={savingTask}>
              {savingTask ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={projectRulesOpen} onOpenChange={setProjectRulesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Project rules</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Prompt template</span>
              <textarea
                value={rulesDraft.promptTemplate}
                onChange={(event) =>
                  setRulesDraft((current) => ({ ...current, promptTemplate: event.target.value }))
                }
                rows={5}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="How should the agent approach work in this project?"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Default model</span>
                <Input
                  value={rulesDraft.defaultModel}
                  onChange={(event) =>
                    setRulesDraft((current) => ({ ...current, defaultModel: event.target.value }))
                  }
                  placeholder="Project default"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Runtime</span>
                <div className="flex items-center gap-2 rounded-full border border-border p-1">
                  {ORCHESTRATE_RUNTIME_OPTIONS.map((runtimeMode) => (
                    <Toggle
                      key={runtimeMode}
                      pressed={rulesDraft.defaultRuntimeMode === runtimeMode}
                      onPressedChange={(pressed) => {
                        if (pressed) {
                          setRulesDraft((current) => ({
                            ...current,
                            defaultRuntimeMode: runtimeMode,
                          }));
                        }
                      }}
                      size="xs"
                      className="rounded-full px-2.5"
                    >
                      {runtimeMode === "full-access" ? "Full access" : "Approval"}
                    </Toggle>
                  ))}
                </div>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">On success</span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="outline" className="w-full justify-between">
                        {formatTaskStateLabel(rulesDraft.onSuccessMoveTo)}
                      </Button>
                    }
                  />
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    {TASK_STATE_OPTIONS.map((state) => (
                      <MenuItem
                        key={state}
                        onClick={() =>
                          setRulesDraft((current) => ({ ...current, onSuccessMoveTo: state }))
                        }
                      >
                        {formatTaskStateLabel(state)}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">On failure</span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="outline" className="w-full justify-between">
                        {formatTaskStateLabel(rulesDraft.onFailureMoveTo)}
                      </Button>
                    }
                  />
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    {TASK_STATE_OPTIONS.map((state) => (
                      <MenuItem
                        key={state}
                        onClick={() =>
                          setRulesDraft((current) => ({ ...current, onFailureMoveTo: state }))
                        }
                      >
                        {formatTaskStateLabel(state)}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              </label>
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setProjectRulesOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleSaveRules()}
              disabled={savingRules || !selectedProjectId}
            >
              {savingRules ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={currentTask !== null}
        onOpenChange={(open) => {
          if (!open) {
            updateRoute({ taskId: null });
          }
        }}
      >
        <SheetContent side={isMobile ? "bottom" : "right"} className="sm:max-w-xl" showCloseButton>
          {currentTask ? (
            <>
              <SheetHeader>
                <div className="flex min-w-0 items-start gap-3 pr-10">
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-[clamp(1rem,0.94rem+0.22vw,1.14rem)]">
                      {currentTask.task.title}
                    </SheetTitle>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="rounded-full px-2">
                        {formatTaskStateLabel(currentTask.task.state)}
                      </Badge>
                      <TaskRuntimePill task={currentTask} />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {currentTask.runtime?.status === "running" ||
                    currentTask.runtime?.status === "starting" ||
                    currentTask.runtime?.status === "queued" ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Stop task"
                        onClick={() => void handleTaskAction("stop", currentTask)}
                      >
                        <SquareIcon className="size-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Start task"
                        onClick={() => void handleTaskAction("start", currentTask)}
                      >
                        <CirclePlayIcon className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Retry task"
                      onClick={() => void handleTaskAction("retry", currentTask)}
                    >
                      <RotateCcwIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </SheetHeader>
              <SheetPanel className="space-y-5">
                <div className="grid gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Title
                    </span>
                    <Input
                      value={detailDraft.title}
                      onChange={(event) =>
                        setDetailDraft((current) => ({ ...current, title: event.target.value }))
                      }
                    />
                  </label>

                  <div className="space-y-1.5">
                    <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Brief
                    </span>
                    <TaskContextEditor
                      workspaceRoot={currentTask.project?.cwd ?? null}
                      value={detailDraft.brief}
                      cursor={detailDraft.briefCursor}
                      attachments={detailDraft.attachments}
                      placeholder="Describe the task. Use @ to reference files."
                      onChange={(brief, briefCursor) =>
                        setDetailDraft((current) => ({ ...current, brief, briefCursor }))
                      }
                      onAttachmentsChange={(attachments) =>
                        setDetailDraft((current) => ({
                          ...current,
                          attachments: cloneTaskDraftImageAttachments(attachments),
                        }))
                      }
                      onError={(message) => {
                        toastManager.add({
                          type: "error",
                          title: "Could not attach image",
                          description: message,
                        });
                      }}
                    />
                  </div>

                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Acceptance
                    </span>
                    <textarea
                      value={detailDraft.acceptanceCriteria}
                      onChange={(event) =>
                        setDetailDraft((current) => ({
                          ...current,
                          acceptanceCriteria: event.target.value,
                        }))
                      }
                      rows={4}
                      className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        State
                      </span>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button variant="outline" className="w-full justify-between">
                              {formatTaskStateLabel(detailDraft.state)}
                            </Button>
                          }
                        />
                        <MenuPopup align="start" className="w-(--anchor-width)">
                          {TASK_STATE_OPTIONS.map((state) => (
                            <MenuItem
                              key={state}
                              onClick={() => setDetailDraft((current) => ({ ...current, state }))}
                            >
                              {formatTaskStateLabel(state)}
                            </MenuItem>
                          ))}
                        </MenuPopup>
                      </Menu>
                    </label>

                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Priority
                      </span>
                      <Input
                        type="number"
                        min={0}
                        step={1}
                        name="detail-priority"
                        value={detailDraft.priority}
                        onChange={(event) =>
                          setDetailDraft((current) => ({
                            ...current,
                            priority: normalizePriorityDraft(event.target.value),
                          }))
                        }
                        inputMode="numeric"
                        placeholder="0+"
                        nativeInput
                      />
                    </label>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Agent thread
                  </p>
                  <div className="rounded-2xl border border-border/70 bg-card px-3 py-3">
                    {currentTask.task.threadId ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">
                            {currentTask.thread?.title ?? "Agent thread"}
                          </p>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground/78">
                            {relativeTimeLabel(
                              currentTask.runtime?.lastActivityAt ??
                                currentTask.thread?.updatedAt ??
                                currentTask.task.updatedAt,
                            )}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          className="rounded-full px-3"
                          onClick={() => openThread(currentTask)}
                        >
                          <ArrowUpRightIcon className="size-3.5" />
                          <span>Open</span>
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No thread yet.</p>
                    )}
                  </div>
                </div>

                {currentTask.thread?.activities.length ? (
                  <div className="space-y-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Activity
                    </p>
                    <div className="space-y-2">
                      {currentTask.thread.activities
                        .slice(-6)
                        .toReversed()
                        .map((activity) => (
                          <div
                            key={activity.id}
                            className="rounded-2xl border border-border/70 bg-card px-3 py-2.5"
                          >
                            <p className="text-sm text-foreground">{activity.summary}</p>
                            <p className="mt-1 text-[11px] text-muted-foreground/72 tabular-nums">
                              {relativeTimeLabel(activity.createdAt)}
                            </p>
                          </div>
                        ))}
                    </div>
                  </div>
                ) : null}
              </SheetPanel>
              <SheetFooter variant="bare" className="justify-between sm:flex-row">
                <Button
                  variant="destructive-outline"
                  onClick={() => void handleTaskAction("delete", currentTask)}
                >
                  Delete
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => updateRoute({ taskId: null })}>
                    Close
                  </Button>
                  <Button onClick={() => void handleSaveTaskDetails()}>Save</Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </AppPageShell>
  );
}
