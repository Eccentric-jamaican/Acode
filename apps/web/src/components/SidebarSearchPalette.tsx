import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  GitForkIcon,
  HardDriveIcon,
  HomeIcon,
  LoaderCircleIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ProjectListDirectoryResult } from "@t3tools/contracts";
import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { TbFolderPlus } from "react-icons/tb";
import { ClaudeAI, OpenAI, OpenCodeIcon } from "./Icons";
import {
  type SidebarFolderEntry,
  type SidebarFolderRoot,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
  filterSidebarFolderEntries,
  hasSidebarSearchResults,
  isLikelyAbsoluteFolderPath,
  joinClientPath,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThreads,
  parentClientPath,
} from "./SidebarSearchPalette.logic";
import { deriveRepositoryDirectoryName } from "../lib/gitClone";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "./ui/command";

export type SidebarSearchPaletteMode = "search" | "folder";
type FolderPickerPurpose = "add-project" | "clone-parent";

interface SidebarSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  folderRoots: readonly SidebarFolderRoot[];
  onCreateThread: () => void;
  onAddProject: () => void;
  onCloneRepository: (input: {
    repositoryUrl: string;
    directoryName: string;
    parentDirectory: string;
  }) => Promise<{ cwd: string; directoryName: string } | null>;
  onAddProjectFromPath: (cwd: string) => Promise<boolean>;
  onListDirectory: (cwd: string) => Promise<ProjectListDirectoryResult>;
  onOpenSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function actionHandler(
  actionId: string,
  props: Omit<
    SidebarSearchPaletteProps,
    "open" | "onOpenChange" | "actions" | "projects" | "threads"
  >,
): (() => void) | null {
  switch (actionId) {
    case "new-thread":
      return props.onCreateThread;
    case "add-project":
      return props.onAddProject;
    case "settings":
      return props.onOpenSettings;
    default:
      return null;
  }
}

type IconComponent = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, IconComponent> = {
  "new-thread": SquarePenIcon,
  "add-project": TbFolderPlus,
  "clone-repository": GitForkIcon,
  settings: SettingsIcon,
};
const CLONE_ACTION_ICON: IconComponent = GitForkIcon;

function PaletteIcon(props: { icon: IconComponent }) {
  const Icon = props.icon;
  return (
    <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
      <Icon className="size-3.5" />
    </div>
  );
}

function ProviderIcon(props: { provider: SidebarSearchThread["provider"] }) {
  return (
    <div className="flex size-4 shrink-0 items-center justify-center">
      {props.provider === "claudeAgent" ? (
        <ClaudeAI aria-hidden="true" className="size-3.5 text-[#d97757]" />
      ) : props.provider === "opencode" ? (
        <OpenCodeIcon aria-hidden="true" className="size-3.5 text-muted-foreground/70" />
      ) : (
        <OpenAI aria-hidden="true" className="size-3.5 text-muted-foreground/50" />
      )}
    </div>
  );
}

function threadMatchLabel(input: {
  matchKind: "message" | "project" | "title";
  messageMatchCount: number;
}): string | null {
  if (input.matchKind === "message") {
    return input.messageMatchCount > 1 ? `${input.messageMatchCount} chat hits` : "Chat match";
  }
  if (input.matchKind === "project") {
    return "Project match";
  }
  return null;
}

function tokenizeHighlightQuery(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token, index, allTokens) => allTokens.indexOf(token) === index);
  return tokens.toSorted((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText(props: { text: string; query: string; className?: string }) {
  const segments = useMemo(() => {
    const tokens = tokenizeHighlightQuery(props.query);
    if (tokens.length === 0) {
      return [{ text: props.text, highlighted: false, start: 0 }];
    }

    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    let cursor = 0;
    return parts.map((part) => {
      const segment = {
        text: part,
        highlighted: tokens.some((token) => token === part.toLowerCase()),
        start: cursor,
      };
      cursor += part.length;
      return segment;
    });
  }, [props.query, props.text]);

  return (
    <span className={props.className}>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={`h-${segment.start}-${segment.text}`}
            className="rounded-[3px] bg-accent/70 px-[1px] text-current"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`n-${segment.start}-${segment.text}`}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

function ShortcutBadge(props: { label: string }) {
  return (
    <kbd className="inline-flex shrink-0 items-center rounded border border-border/50 bg-muted/40 px-1 py-[1px] text-[10px] text-muted-foreground/60">
      {props.label}
    </kbd>
  );
}

function folderRootIcon(root: SidebarFolderRoot): IconComponent {
  if (root.id === "home") return HomeIcon;
  if (root.id === "drive-root") return HardDriveIcon;
  return FolderIcon;
}

function basenameOfClientPath(value: string): string {
  const trimmed = value.trim().replaceAll(/[\\/]+$/g, "");
  if (!trimmed) return value;
  const separatorIndex = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (separatorIndex < 0) return trimmed;
  return trimmed.slice(separatorIndex + 1) || trimmed;
}

function folderBreadcrumbs(value: string): Array<{ label: string; path: string }> {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const windowsDriveMatch = trimmed.match(/^([a-zA-Z]:)[\\/]*(.*)$/);
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1] ?? "";
    if (!drive) return [];
    const rest = windowsDriveMatch[2] ?? "";
    const segments = rest.split(/[\\/]+/).filter((segment) => segment.length > 0);
    let currentPath = `${drive}\\`;
    return [
      { label: drive, path: currentPath },
      ...segments.map((segment) => {
        currentPath = joinClientPath(currentPath, segment);
        return { label: segment, path: currentPath };
      }),
    ];
  }

  const isRooted = trimmed.startsWith("/");
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0);
  let currentPath = isRooted ? "/" : "";
  const breadcrumbs = isRooted ? [{ label: "Root", path: "/" }] : [];
  for (const segment of segments) {
    currentPath = currentPath ? joinClientPath(currentPath, segment) : segment;
    breadcrumbs.push({ label: segment, path: currentPath });
  }
  return breadcrumbs;
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const open = props.open;
  const mode = props.mode;
  const onListDirectory = props.onListDirectory;
  const onModeChange = props.onModeChange;
  const [query, setQuery] = useState("");
  const [cloneMode, setCloneMode] = useState<"idle" | "editing" | "submitting" | "success">(
    "idle",
  );
  const [cloneRepositoryUrl, setCloneRepositoryUrl] = useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [clonedProject, setClonedProject] = useState<{ cwd: string; directoryName: string } | null>(
    null,
  );
  const [pendingClone, setPendingClone] = useState<{
    repositoryUrl: string;
    directoryName: string;
  } | null>(null);
  const [folderPurpose, setFolderPurpose] = useState<FolderPickerPurpose>("add-project");
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<SidebarFolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderSubmitting, setFolderSubmitting] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const folderEntriesCacheRef = useRef(new Map<string, SidebarFolderEntry[]>());
  const cloneInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCloneMode("idle");
      setCloneRepositoryUrl("");
      setCloneError(null);
      setClonedProject(null);
      setPendingClone(null);
      setFolderPurpose("add-project");
      setFolderEntries([]);
      setFolderLoading(false);
      setFolderSubmitting(false);
      setFolderError(null);
      folderEntriesCacheRef.current.clear();
      onModeChange("search");
    }
  }, [onModeChange, open]);

  useEffect(() => {
    if (cloneMode === "editing") {
      cloneInputRef.current?.focus();
      cloneInputRef.current?.select();
    }
  }, [cloneMode]);

  const matchedActions = useMemo(
    () => matchSidebarSearchActions(props.actions, query),
    [props.actions, query],
  );
  const matchedProjects = useMemo(
    () => matchSidebarSearchProjects(props.projects, query),
    [props.projects, query],
  );
  const matchedThreads = useMemo(
    () => matchSidebarSearchThreads(props.threads, query),
    [props.threads, query],
  );
  const defaultFolderPath = props.folderRoots[0]?.path ?? null;
  const visibleFolderEntries = useMemo(
    () => filterSidebarFolderEntries(folderEntries, query),
    [folderEntries, query],
  );
  const trimmedFolderQuery = query.trim();
  const hasTypedAbsoluteFolderPath = isLikelyAbsoluteFolderPath(trimmedFolderQuery);
  const shouldShowFolderQuickRoots = props.folderRoots.length > 0 && trimmedFolderQuery.length === 0;
  const folderEntryScrollClassName = shouldShowFolderQuickRoots ? "max-h-44" : "max-h-80";
  const folderParentPath = currentFolder ? parentClientPath(currentFolder) : null;
  const currentFolderLabel = currentFolder ? basenameOfClientPath(currentFolder) : "Folder";
  const currentFolderBreadcrumbs = currentFolder ? folderBreadcrumbs(currentFolder) : [];
  const hasResults = hasSidebarSearchResults({
    actions: matchedActions,
    projects: matchedProjects,
    threads: matchedThreads,
  });
  const hasVisibleResults = hasResults || cloneMode !== "idle";
  const hasSuggestedActions = matchedActions.length > 0 || cloneMode !== "idle";

  const resetInlineClone = () => {
    setCloneMode("idle");
    setCloneRepositoryUrl("");
    setCloneError(null);
    setClonedProject(null);
    setPendingClone(null);
  };

  const closeFolderPicker = () => {
    onModeChange("search");
    setQuery("");
    setFolderError(null);
    setFolderSubmitting(false);
    if (folderPurpose === "clone-parent" && pendingClone) {
      setCloneMode("editing");
    }
    setFolderPurpose("add-project");
  };

  const openFolderPicker = (purpose: FolderPickerPurpose) => {
    setFolderPurpose(purpose);
    setQuery("");
    setFolderError(null);
    setFolderSubmitting(false);
    if (!currentFolder && defaultFolderPath) {
      setCurrentFolder(defaultFolderPath);
    }
    onModeChange("folder");
  };

  const openInlineClone = () => {
    setCloneMode("editing");
    setCloneError(null);
    setClonedProject(null);
  };

  const submitCloneRepository = async () => {
    const repositoryUrl = cloneRepositoryUrl.trim();
    if (repositoryUrl.length === 0) {
      setCloneError("Enter a Git repository URL.");
      setCloneMode("editing");
      return;
    }

    const directoryName = deriveRepositoryDirectoryName(repositoryUrl);
    if (!directoryName) {
      setCloneError("Could not infer a folder name from that repository URL.");
      setCloneMode("editing");
      return;
    }

    setCloneError(null);
    setPendingClone({ repositoryUrl, directoryName });
    openFolderPicker("clone-parent");
  };

  const confirmAddClonedProject = async () => {
    if (!clonedProject) {
      return;
    }
    setCloneMode("submitting");
    setCloneError(null);
    const added = await props.onAddProjectFromPath(clonedProject.cwd);
    if (added) {
      resetInlineClone();
      props.onOpenChange(false);
      return;
    }
    setCloneMode("success");
  };

  const navigateToFolder = (path: string) => {
    setCurrentFolder(path);
    setQuery("");
    setFolderError(null);
  };

  const handleFolderPrimaryAction = () => {
    if (hasTypedAbsoluteFolderPath) {
      navigateToFolder(trimmedFolderQuery);
      return;
    }
    void confirmCurrentFolder();
  };

  const confirmCurrentFolder = async () => {
    if (!currentFolder || folderSubmitting) {
      return;
    }

    setFolderSubmitting(true);
    setFolderError(null);
    try {
      if (folderPurpose === "clone-parent") {
        if (!pendingClone) {
          setFolderError("Enter a Git repository URL first.");
          return;
        }
        setCloneMode("submitting");
        const cloned = await props.onCloneRepository({
          ...pendingClone,
          parentDirectory: currentFolder,
        });
        if (!cloned) {
          setCloneMode("editing");
          return;
        }
        setClonedProject(cloned);
        setPendingClone(null);
        setCloneMode("success");
        onModeChange("search");
        setQuery("");
        return;
      }

      const added = await props.onAddProjectFromPath(currentFolder);
      if (added) {
        props.onOpenChange(false);
      }
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Unable to use this folder.");
      if (folderPurpose === "clone-parent") {
        setCloneMode("editing");
      }
    } finally {
      setFolderSubmitting(false);
    }
  };

  const handleFolderInputEnter = () => {
    if (trimmedFolderQuery.length === 0) {
      void confirmCurrentFolder();
      return;
    }
    if (hasTypedAbsoluteFolderPath) {
      navigateToFolder(trimmedFolderQuery);
      return;
    }
    if (visibleFolderEntries.length === 1 && currentFolder) {
      navigateToFolder(joinClientPath(currentFolder, visibleFolderEntries[0]?.name ?? ""));
    }
  };

  useEffect(() => {
    if (!open || mode !== "folder" || currentFolder || !defaultFolderPath) {
      return;
    }
    setCurrentFolder(defaultFolderPath);
  }, [currentFolder, defaultFolderPath, mode, open]);

  useEffect(() => {
    if (!open || mode !== "folder" || !currentFolder) {
      return;
    }

    let disposed = false;
    const cachedEntries = folderEntriesCacheRef.current.get(currentFolder);
    if (cachedEntries) {
      setFolderEntries(cachedEntries);
      setFolderLoading(false);
      setFolderError(null);
      return;
    }

    setFolderLoading(true);
    setFolderError(null);

    void onListDirectory(currentFolder)
      .then((result) => {
        if (disposed) return;
        const entries = [...result.entries];
        folderEntriesCacheRef.current.set(currentFolder, entries);
        setFolderEntries(entries);
      })
      .catch((error) => {
        if (disposed) return;
        setFolderEntries([]);
        setFolderError(error instanceof Error ? error.message : "Unable to open this folder.");
      })
      .finally(() => {
        if (!disposed) {
          setFolderLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [currentFolder, mode, onListDirectory, open]);

  const renderCloneInlineRow = () => (
    <div className="px-1.5 py-0.5">
      <div className="rounded-lg border border-border/60 bg-background/90 px-2.5 py-1.5 shadow-sm">
        <div className="flex items-center gap-2">
          {cloneMode === "success" ? (
            <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />
          ) : cloneMode === "submitting" ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground/60" />
          ) : (
            <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
          )}
          {cloneMode === "success" ? (
            <div className="min-w-0 flex-1 text-[13px] text-foreground">
              Cloned into <span className="font-medium">{clonedProject?.directoryName}</span>. Add it
              as a project?
            </div>
          ) : (
            <input
              ref={cloneInputRef}
              value={cloneRepositoryUrl}
              onChange={(event) => {
                setCloneRepositoryUrl(event.currentTarget.value);
                if (cloneError) {
                  setCloneError(null);
                }
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (cloneMode !== "submitting") {
                    void submitCloneRepository();
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  resetInlineClone();
                }
              }}
              onClick={(event) => event.stopPropagation()}
              placeholder="Enter URL"
              disabled={cloneMode === "submitting"}
              className="min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-wait disabled:opacity-60"
            />
          )}
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              resetInlineClone();
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {cloneMode === "success" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>

      {cloneMode === "success" ? (
        <div className="mt-1.5 flex items-center gap-1.5 pl-1">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void confirmAddClonedProject();
            }}
            className="rounded bg-foreground px-2 py-1 text-[11px] text-background transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            Add as project
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              resetInlineClone();
              props.onOpenChange(false);
            }}
            className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            Not now
          </button>
        </div>
      ) : (
        <div className="pt-1.5 pl-1 text-[10px] text-muted-foreground/50">
          {cloneError
            ? cloneError
            : cloneMode === "submitting"
              ? "Cloning repository..."
              : "Paste repository URL and press Enter."}
        </div>
      )}
    </div>
  );

  const renderFolderPicker = () => (
    <>
      <CommandGroup>
        <CommandGroupLabel className="pt-0 pb-1 pl-2 text-[10px] text-muted-foreground/50">
          {folderPurpose === "clone-parent" ? "Clone into" : "Open folder"}
        </CommandGroupLabel>
        <div className="px-1.5 pb-1.5">
          <div className="rounded-lg border border-border/60 bg-background/85 p-2">
            <div className="flex items-center gap-1.5">
              {folderParentPath ? (
                <button
                  type="button"
                  aria-label="Go to parent folder"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground"
                  onClick={() => navigateToFolder(folderParentPath)}
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
              ) : null}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1 overflow-visible text-[12px] text-muted-foreground/70">
                {currentFolderBreadcrumbs.map((breadcrumb, index) => (
                  <span key={breadcrumb.path} className="inline-flex max-w-full min-w-0 items-center gap-1">
                    {index > 0 ? <ChevronRightIcon className="size-3 shrink-0 opacity-50" /> : null}
                    <button
                      type="button"
                      className="max-w-36 truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/60 hover:text-foreground"
                      onClick={() => navigateToFolder(breadcrumb.path)}
                    >
                      {breadcrumb.label}
                    </button>
                  </span>
                ))}
                {currentFolderBreadcrumbs.length === 0 ? (
                  <span className="truncate px-1">{currentFolder ?? "Choose a starting folder"}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
                disabled={folderSubmitting || (!currentFolder && !hasTypedAbsoluteFolderPath)}
                onClick={handleFolderPrimaryAction}
              >
                {folderSubmitting ? (
                  <LoaderCircleIcon className="size-3 animate-spin" />
                ) : (
                  <CheckIcon className="size-3" />
                )}
                <span>
                  {hasTypedAbsoluteFolderPath
                    ? "Go to path"
                    : folderPurpose === "clone-parent"
                      ? "Clone here"
                      : "Use folder"}
                </span>
              </button>
            </div>
          </div>
        </div>
      </CommandGroup>

      {shouldShowFolderQuickRoots ? (
        <CommandGroup>
          <CommandGroupLabel className="pb-1 pl-2 text-[10px] text-muted-foreground/50">
            Quick roots
          </CommandGroupLabel>
          <div className="grid grid-cols-2 gap-1 px-1.5 pb-1">
            {props.folderRoots.map((root) => {
              const Icon = folderRootIcon(root);
              return (
                <button
                  key={`${root.id}:${root.path}`}
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground"
                  onClick={() => navigateToFolder(root.path)}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{root.label}</span>
                </button>
              );
            })}
          </div>
        </CommandGroup>
      ) : null}

      <CommandSeparator />

      <CommandGroup>
        <CommandGroupLabel className="pb-1 pl-2 text-[10px] text-muted-foreground/50">
          {currentFolderLabel}
        </CommandGroupLabel>
        {folderLoading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground/60">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Loading folders...
          </div>
        ) : folderError ? (
          <div className="px-3 py-3 text-[12px] text-rose-500">{folderError}</div>
        ) : visibleFolderEntries.length > 0 && currentFolder ? (
          <div className={`min-h-0 overflow-y-auto pr-1 ${folderEntryScrollClassName}`}>
            {visibleFolderEntries.map((entry) => {
              const entryPathAddsContext =
                entry.path.trim().length > 0 &&
                entry.path.trim().toLowerCase() !== entry.name.trim().toLowerCase();
              return (
                <CommandItem
                  key={entry.path}
                  value={`folder:${entry.path}`}
                  className="cursor-pointer items-center gap-2 rounded-md px-2 py-1"
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => navigateToFolder(joinClientPath(currentFolder, entry.name))}
                >
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-foreground">{entry.name}</div>
                    {entryPathAddsContext ? (
                      <div className="truncate text-[10px] text-muted-foreground/45">
                        {entry.path}
                      </div>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-3 text-[12px] text-muted-foreground/60">
            {query.trim() ? "No matching folders" : "No folders here"}
          </div>
        )}
      </CommandGroup>
    </>
  );

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup
        className="max-w-[560px]"
        data-testid="sidebar-search-palette"
        onKeyDownCapture={(event) => {
          if (props.mode !== "folder" || event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          closeFolderPicker();
        }}
      >
        <Command autoHighlight={false} mode="none">
          <CommandPanel className="overflow-hidden">
            <CommandInput
              placeholder={
                props.mode === "folder" ? "Filter folders or paste path..." : "Type command or search..."
              }
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (props.mode !== "folder") return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  handleFolderInputEnter();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeFolderPicker();
                }
              }}
              startAddon={
                props.mode === "folder" ? (
                  <FolderIcon className="size-4 text-muted-foreground/60" />
                ) : (
                  <SearchIcon className="size-4 text-muted-foreground/60" />
                )
              }
              endAddon={
                props.mode === "folder" ? (
                  <button
                    type="button"
                    aria-label="Back to command palette"
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/85 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={closeFolderPicker}
                  >
                    <ArrowLeftIcon className="size-3" />
                    <span>Commands</span>
                  </button>
                ) : null
              }
            />
            <CommandList
              className={
                props.mode === "folder"
                  ? "max-h-[min(30rem,70vh)] not-empty:px-1 not-empty:pt-0 not-empty:pb-2"
                  : "max-h-[min(16rem,45vh)] not-empty:px-1 not-empty:pt-0 not-empty:pb-1"
              }
            >
              {props.mode === "folder" ? renderFolderPicker() : null}
              {props.mode === "search" && hasSuggestedActions ? (
                <CommandGroup>
                  <CommandGroupLabel className="pt-0 pb-1 pl-2 text-[10px] text-muted-foreground/50">
                    Suggested
                  </CommandGroupLabel>
                  {matchedActions.map((action) => {
                    if (action.id === "clone-repository") {
                      return cloneMode === "idle" ? (
                        <CommandItem
                          key={action.id}
                          value={`action:${action.id}`}
                          className="cursor-pointer items-center gap-2 rounded-md px-2 py-0.5"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            openInlineClone();
                          }}
                        >
                          <PaletteIcon icon={CLONE_ACTION_ICON} />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                            {action.label}
                          </span>
                        </CommandItem>
                      ) : (
                        <div key={action.id}>{renderCloneInlineRow()}</div>
                      );
                    }
                    const onSelect = actionHandler(action.id, props);
                    if (!onSelect) return null;
                    const Icon = ACTION_ICONS[action.id];
                    if (!Icon) return null;
                    return (
                      <CommandItem
                        key={action.id}
                        value={`action:${action.id}`}
                        className="cursor-pointer items-center gap-2 rounded-md px-2 py-0.5"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            if (action.id === "add-project") {
                              onSelect();
                              return;
                            }
                            props.onOpenChange(false);
                            onSelect();
                          }}
                        >
                        {Icon ? <PaletteIcon icon={Icon} /> : null}
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {action.label}
                        </span>
                        {action.shortcutLabel ? <ShortcutBadge label={action.shortcutLabel} /> : null}
                      </CommandItem>
                    );
                  })}
                  {cloneMode !== "idle" &&
                  !matchedActions.some((action) => action.id === "clone-repository") ? (
                    renderCloneInlineRow()
                  ) : null}
                </CommandGroup>
              ) : null}

              {props.mode === "search" &&
              hasSuggestedActions &&
              (matchedThreads.length > 0 || matchedProjects.length > 0) ? (
                <CommandSeparator />
              ) : null}

              {props.mode === "search" && matchedThreads.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel className="pb-1 pl-2 text-[10px] text-muted-foreground/50">
                    {query ? "Chat" : "Recent"}
                  </CommandGroupLabel>
                  {matchedThreads.map(({ id, matchKind, messageMatchCount, snippet, thread }) => (
                    <CommandItem
                      key={id}
                      value={id}
                      className="cursor-pointer items-start gap-2 rounded-md px-2 py-1"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        props.onOpenChange(false);
                        props.onOpenThread(thread.id);
                      }}
                    >
                      <div className="pt-0.5">
                        <ProviderIcon provider={thread.provider} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <div className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                            <HighlightedText text={thread.title || "Untitled thread"} query={query} />
                          </div>
                          <span className="w-16 shrink-0 truncate text-right text-[10px] text-muted-foreground/50">
                            {thread.projectName}
                          </span>
                          {thread.updatedAt || thread.createdAt ? (
                            <span className="w-7 shrink-0 text-right text-[10px] text-muted-foreground/50">
                              {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                            </span>
                          ) : (
                            <span className="w-7 shrink-0" />
                          )}
                        </div>
                        {snippet ? (
                          <div className="mt-0.5 flex items-start gap-2">
                            <div className="min-w-0 flex-1 line-clamp-1 text-[10px] leading-4 text-muted-foreground/50">
                              <HighlightedText text={snippet} query={query} />
                            </div>
                            <div className="flex w-20 shrink-0 justify-end">
                              {threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                <span className="truncate text-[10px] text-muted-foreground/40">
                                  {threadMatchLabel({ matchKind, messageMatchCount })}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ) : threadMatchLabel({ matchKind, messageMatchCount }) ? (
                          <div className="mt-0.5 text-[10px] text-muted-foreground/40">
                            {threadMatchLabel({ matchKind, messageMatchCount })}
                          </div>
                        ) : null}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {props.mode === "search" && matchedThreads.length > 0 && matchedProjects.length > 0 ? (
                <CommandSeparator />
              ) : null}

              {props.mode === "search" && matchedProjects.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel className="pb-1 pl-2 text-[10px] text-muted-foreground/50">
                    Projects
                  </CommandGroupLabel>
                  {matchedProjects.map(({ id, project }) => (
                    <CommandItem
                      key={id}
                      value={id}
                      className="cursor-pointer items-center gap-2 rounded-md px-2 py-0.5"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        props.onOpenChange(false);
                        props.onOpenProject(project.id);
                      }}
                    >
                      <PaletteIcon icon={TbFolderPlus} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-foreground">
                          {project.name || "Untitled project"}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground/50">
                          {project.cwd}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {props.mode === "search" && !hasVisibleResults ? (
                <CommandEmpty className="py-8">
                  <div className="flex flex-col items-center justify-center gap-1.5 text-center text-sm text-muted-foreground/50">
                    <SearchIcon className="size-3.5 opacity-60" />
                    <div>No matches</div>
                  </div>
                </CommandEmpty>
              ) : null}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            {props.mode === "folder" ? (
              <>
                <span>{folderPurpose === "clone-parent" ? "Choose clone destination" : "Choose project folder"}</span>
                <span>{hasTypedAbsoluteFolderPath ? "Enter to go" : "Enter to use"}</span>
              </>
            ) : (
              <>
                <span>Jump to threads, projects, and actions</span>
                <span>{cloneMode === "idle" ? "Enter to open" : "Enter to continue"}</span>
              </>
            )}
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
