import { useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type {
  ContextMenuItem as PierreContextMenuItem,
  ContextMenuOpenContext as PierreContextMenuOpenContext,
  GitStatusEntry,
} from "@pierre/trees";
import type { ProjectEntry, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import { getFilePanelThreadState, useFilePanelStore } from "../filePanelStore";
import { gitQueryKeys, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { projectListTreeQueryOptions, projectQueryKeys } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "./ui/button";

interface WorkspaceFilesRailProps {
  threadId: ThreadId;
  cwd: string | null;
  className?: string;
  onClose?: (() => void) | undefined;
  onRevealFile?: ((path: string) => void) | undefined;
}

const TREE_UNSAFE_CSS = `
  :host {
    display: block;
    height: 100%;
    min-height: 0;
    color-scheme: dark light;
    font-family: inherit;
    background: transparent;
    --trees-bg-override: transparent;
    --trees-bg-muted-override: hsl(var(--accent) / 0.34);
    --trees-fg-override: hsl(var(--foreground));
    --trees-fg-muted-override: hsl(var(--muted-foreground));
    --trees-accent-override: hsl(var(--primary));
    --trees-border-color-override: hsl(var(--border) / 0.5);
    --trees-border-radius-override: 6px;
    --trees-density-override: 0.82;
    --trees-font-family-override: inherit;
    --trees-font-size-override: 12.5px;
    --trees-font-weight-regular-override: 400;
    --trees-font-weight-semibold-override: 500;
    --trees-focus-ring-color-override: hsl(var(--ring) / 0.4);
    --trees-focus-ring-offset-override: 0px;
    --trees-gap-override: 2px;
    --trees-icon-width-override: 16px;
    --trees-item-margin-x-override: 2px;
    --trees-item-padding-x-override: 7px;
    --trees-item-row-gap-override: 5px;
    --trees-level-gap-override: 12px;
    --trees-padding-inline-override: 0px;
    --trees-scrollbar-gutter-override: stable;
    --trees-search-bg-override: transparent;
    --trees-search-fg-override: hsl(var(--foreground));
    --trees-search-font-weight-override: 400;
    --trees-selected-bg-override: hsl(var(--accent) / 0.44);
    --trees-selected-fg-override: hsl(var(--foreground));
    --trees-selected-focused-border-color-override: transparent;
    --trees-input-bg-override: transparent;
  }

  [data-file-tree-search-container] {
    padding: 0 2px 8px;
    background: transparent;
  }

  [data-file-tree-search-input] {
    width: 100%;
    height: 28px;
    box-sizing: border-box;
    border: 1px solid transparent;
    border-radius: 6px;
    background: hsl(var(--muted) / 0.28);
    color: hsl(var(--foreground));
    outline: none;
    padding: 0 9px;
    font: inherit;
    font-size: 12.5px;
  }

  [data-file-tree-search-input]::placeholder {
    color: hsl(var(--muted-foreground) / 0.72);
  }

  [data-file-tree-search-input]:focus,
  [data-file-tree-search-input][data-file-tree-search-input-fake-focus='true'] {
    border-color: hsl(var(--ring) / 0.34);
    background: hsl(var(--background) / 0.7);
  }

  [role='tree'] {
    background: transparent;
  }

  button[data-type='item'],
  button[data-file-tree-sticky-row='true'] {
    min-height: 24px;
    color: hsl(var(--foreground) / 0.78);
  }

  button[data-type='item']:hover,
  button[data-file-tree-sticky-row='true']:hover {
    color: hsl(var(--foreground));
  }

  button[data-type='item'][data-item-selected],
  button[data-file-tree-sticky-row='true'][data-item-selected] {
    color: hsl(var(--foreground));
  }

  [data-item-section='spacing-item'] {
    opacity: 0.42;
  }

  [data-item-section='icon'] svg {
    width: 14px;
    height: 14px;
  }

  [data-item-section='content'] {
    min-width: 0;
  }
`;

export function WorkspaceFilesRail(props: WorkspaceFilesRailProps) {
  const threadState = useFilePanelStore((store) => getFilePanelThreadState(store, props.threadId));
  const openFile = useFilePanelStore((store) => store.openFile);
  const treeQuery = useQuery(
    projectListTreeQueryOptions({
      cwd: props.cwd,
      enabled: props.cwd !== null,
    }),
  );
  const gitStatusQuery = useQuery(gitStatusQueryOptions(props.cwd));
  const activeFilePath = threadState.activeTab.kind === "file" ? threadState.activeTab.path : null;
  const hasFullTreeEntries = (treeQuery.data?.entries.length ?? 0) > 0;
  const gitStatusEntries = useMemo<readonly GitStatusEntry[]>(() => {
    return (
      gitStatusQuery.data?.workingTree.files.map((file) => ({
        path: file.path,
        status: "modified" as const,
      })) ?? []
    );
  }, [gitStatusQuery.data?.workingTree.files]);

  return (
    <aside
      className={cn(
        "flex h-full w-[22rem] shrink-0 flex-col border-l border-border/50 bg-background/35 text-foreground",
        props.className,
      )}
    >
      <div className="flex h-[var(--app-desktop-content-header-height)] shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4">
        <span className="text-sm font-medium text-foreground/82">All files</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {treeQuery.data?.truncated ? (
            <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Truncated
            </span>
          ) : null}
          {props.onClose ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="sm:hidden"
              aria-label="Close all files"
              title="Close all files"
              onClick={props.onClose}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 px-2 py-2">
        {treeQuery.isLoading ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">Loading files...</p>
        ) : props.cwd === null ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">File tree unavailable.</p>
        ) : hasFullTreeEntries ? (
          <WorkspacePierreTree
            activeFilePath={activeFilePath}
            cwd={props.cwd}
            entries={treeQuery.data?.entries ?? []}
            expandedDirectories={threadState.expandedDirectories}
            gitStatusEntries={gitStatusEntries}
            onOpenFile={(path) => {
              openFile(props.threadId, path);
              props.onRevealFile?.(path);
            }}
          />
        ) : treeQuery.isError ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">Unable to load files.</p>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">No files found.</p>
        )}
      </div>
    </aside>
  );
}

function toPierrePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path.replace(/\/+$/, "")}/` : entry.path;
}

function fromPierrePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function WorkspacePierreTree(props: {
  activeFilePath: string | null;
  cwd: string;
  entries: ReadonlyArray<ProjectEntry>;
  expandedDirectories: ReadonlyArray<string>;
  gitStatusEntries: readonly GitStatusEntry[];
  onOpenFile: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const entryKindByPath = useMemo(() => {
    const next = new Map<string, ProjectEntry["kind"]>();
    for (const entry of props.entries) {
      next.set(toPierrePath(entry), entry.kind);
    }
    return next;
  }, [props.entries]);
  const paths = useMemo(() => props.entries.map(toPierrePath), [props.entries]);
  const expandedDirectories = useMemo(
    () => props.expandedDirectories.map((path) => `${path.replace(/\/+$/, "")}/`),
    [props.expandedDirectories],
  );
  const initialSelectedPaths = useMemo(
    () => (props.activeFilePath ? [props.activeFilePath] : []),
    [props.activeFilePath],
  );
  const latestSelectionContextRef = useRef({
    entryKindByPath,
    onOpenFile: props.onOpenFile,
  });
  const latestActionContextRef = useRef({
    cwd: props.cwd,
    onOpenFile: props.onOpenFile,
    queryClient,
  });
  latestSelectionContextRef.current = {
    entryKindByPath,
    onOpenFile: props.onOpenFile,
  };
  latestActionContextRef.current = {
    cwd: props.cwd,
    onOpenFile: props.onOpenFile,
    queryClient,
  };

  const { model } = useFileTree({
    composition: {
      contextMenu: {
        buttonVisibility: "when-needed",
        enabled: true,
        triggerMode: "both",
      },
    },
    density: "compact",
    fileTreeSearchMode: "collapse-non-matches",
    flattenEmptyDirectories: true,
    gitStatus: props.gitStatusEntries,
    initialExpandedPaths: expandedDirectories,
    initialSelectedPaths,
    paths,
    itemHeight: 24,
    overscan: 18,
    search: true,
    stickyFolders: true,
    unsafeCSS: TREE_UNSAFE_CSS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1);
      if (!selectedPath) {
        return;
      }
      const latest = latestSelectionContextRef.current;
      if (latest.entryKindByPath.get(selectedPath) === "file") {
        latest.onOpenFile(fromPierrePath(selectedPath));
      }
    },
  });

  useEffect(() => {
    model.setGitStatus(props.gitStatusEntries);
  }, [model, props.gitStatusEntries]);

  useEffect(() => {
    model.resetPaths(paths, {
      initialExpandedPaths: expandedDirectories,
    });
  }, [expandedDirectories, model, paths]);

  useEffect(() => {
    if (!props.activeFilePath || !entryKindByPath.has(props.activeFilePath)) {
      return;
    }
    model.focusPath(props.activeFilePath);
  }, [entryKindByPath, model, props.activeFilePath]);

  return (
    <PierreFileTree
      aria-label="Workspace files"
      className="block h-full min-h-0"
      model={model}
      onClick={(event) => {
        const clickedPath = findClickedTreePath(event.nativeEvent);
        if (!clickedPath) {
          return;
        }
        const latest = latestSelectionContextRef.current;
        if (latest.entryKindByPath.get(clickedPath) === "file") {
          latest.onOpenFile(fromPierrePath(clickedPath));
        }
      }}
      renderContextMenu={(item, context) => (
        <NativeTreeContextMenu
          context={context}
          item={item}
          onAction={async (action, selectedItem, selectedContext) => {
            await handleTreeContextMenuAction({
              action,
              ...latestActionContextRef.current,
              context: selectedContext,
              item: selectedItem,
              model,
            });
          }}
        />
      )}
      style={{ height: "100%" }}
    />
  );
}

function findClickedTreePath(event: MouseEvent): string | null {
  for (const candidate of event.composedPath()) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }
    const flattenedPath = candidate.getAttribute("data-item-flattened-subitem");
    if (flattenedPath) {
      return flattenedPath;
    }
    const itemPath = candidate.getAttribute("data-item-path");
    if (itemPath) {
      return itemPath;
    }
  }
  return null;
}

type TreeContextMenuAction =
  | "open"
  | "reveal"
  | "open-in-editor"
  | "copy-relative-path"
  | "copy-absolute-path"
  | "new-file"
  | "new-folder"
  | "rename"
  | "delete";

function NativeTreeContextMenu(props: {
  item: PierreContextMenuItem;
  context: PierreContextMenuOpenContext;
  onAction: (
    action: TreeContextMenuAction,
    item: PierreContextMenuItem,
    context: PierreContextMenuOpenContext,
  ) => Promise<void>;
}) {
  useEffect(() => {
    let canceled = false;
    const api = ensureNativeApi();
    const menuItems = getTreeContextMenuItems(props.item);

    const timeout = window.setTimeout(() => {
      if (canceled) {
        return;
      }
      void api.contextMenu
        .show(menuItems, {
          x: props.context.anchorRect.left,
          y: props.context.anchorRect.bottom,
        })
        .then(async (selectedAction) => {
          if (canceled || selectedAction === null) {
            return;
          }
          await props.onAction(selectedAction, props.item, props.context);
        })
        .finally(() => {
          props.context.close();
        });
    }, 0);

    return () => {
      canceled = true;
      window.clearTimeout(timeout);
    };
  }, [props]);

  return null;
}

function getTreeContextMenuItems(item: PierreContextMenuItem) {
  const isDirectory = item.kind === "directory";
  return [
    ...(isDirectory ? [] : [{ id: "open" as const, label: "Open" }]),
    { id: "reveal" as const, label: "Reveal" },
    { id: "open-in-editor" as const, label: "Open in editor" },
    ...(isDirectory
      ? [
          { id: "new-file" as const, label: "New file" },
          { id: "new-folder" as const, label: "New folder" },
        ]
      : []),
    { id: "copy-relative-path" as const, label: "Copy relative path" },
    { id: "copy-absolute-path" as const, label: "Copy absolute path" },
    { id: "rename" as const, label: "Rename" },
    { id: "delete" as const, label: "Delete", destructive: true },
  ] satisfies ReadonlyArray<{
    id: TreeContextMenuAction;
    label: string;
    destructive?: boolean;
  }>;
}

async function handleTreeContextMenuAction(input: {
  action: TreeContextMenuAction;
  context: PierreContextMenuOpenContext;
  cwd: string;
  item: PierreContextMenuItem;
  model: ReturnType<typeof useFileTree>["model"];
  onOpenFile: (path: string) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  input.context.close({ restoreFocus: false });
  const api = ensureNativeApi();
  const itemPath = fromPierrePath(input.item.path);
  const absolutePath = joinWorkspacePath(input.cwd, itemPath);

  switch (input.action) {
    case "open": {
      if (input.item.kind === "file") {
        input.onOpenFile(itemPath);
      }
      return;
    }
    case "reveal": {
      input.model.focusPath(input.item.path);
      return;
    }
    case "open-in-editor": {
      await api.shell.openInEditor(absolutePath, preferredTerminalEditor());
      return;
    }
    case "copy-relative-path": {
      await navigator.clipboard.writeText(itemPath);
      return;
    }
    case "copy-absolute-path": {
      await navigator.clipboard.writeText(absolutePath);
      return;
    }
    case "new-file": {
      await createTreeFile({
        cwd: input.cwd,
        model: input.model,
        parentPath: itemPath,
        queryClient: input.queryClient,
      });
      return;
    }
    case "new-folder": {
      await createTreeFolder({
        cwd: input.cwd,
        model: input.model,
        parentPath: itemPath,
        queryClient: input.queryClient,
      });
      return;
    }
    case "rename": {
      await renameTreeEntry({
        cwd: input.cwd,
        item: input.item,
        model: input.model,
        queryClient: input.queryClient,
      });
      return;
    }
    case "delete": {
      await deleteTreeEntry({
        cwd: input.cwd,
        item: input.item,
        model: input.model,
        queryClient: input.queryClient,
      });
      return;
    }
  }
}

async function createTreeFile(input: {
  cwd: string;
  model: ReturnType<typeof useFileTree>["model"];
  parentPath: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const name = promptForEntryName("New file");
  if (!name) {
    return;
  }
  const relativePath = joinRelativeWorkspacePath(input.parentPath, name);
  const api = ensureNativeApi();
  await api.projects.writeFile({
    contents: "",
    cwd: input.cwd,
    relativePath,
  });
  input.model.add(relativePath);
  input.model.focusPath(relativePath);
  await invalidateWorkspaceTreeQueries(input.queryClient, input.cwd);
}

async function createTreeFolder(input: {
  cwd: string;
  model: ReturnType<typeof useFileTree>["model"];
  parentPath: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const name = promptForEntryName("New folder");
  if (!name) {
    return;
  }
  const relativePath = joinRelativeWorkspacePath(input.parentPath, name);
  const pierrePath = `${relativePath.replace(/\/+$/, "")}/`;
  const api = ensureNativeApi();
  await api.projects.createDirectory({
    cwd: input.cwd,
    relativePath,
  });
  input.model.add(pierrePath);
  input.model.focusPath(pierrePath);
  await invalidateWorkspaceTreeQueries(input.queryClient, input.cwd);
}

async function renameTreeEntry(input: {
  cwd: string;
  item: PierreContextMenuItem;
  model: ReturnType<typeof useFileTree>["model"];
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const oldRelativePath = fromPierrePath(input.item.path);
  const nextName = promptForEntryName("Rename", basenameOfWorkspacePath(oldRelativePath));
  if (!nextName) {
    return;
  }
  const newRelativePath = joinRelativeWorkspacePath(dirnameOfWorkspacePath(oldRelativePath), nextName);
  if (newRelativePath === oldRelativePath) {
    return;
  }
  const newPierrePath =
    input.item.kind === "directory" ? `${newRelativePath.replace(/\/+$/, "")}/` : newRelativePath;
  const api = ensureNativeApi();
  await api.projects.renameEntry({
    cwd: input.cwd,
    fromRelativePath: oldRelativePath,
    toRelativePath: newRelativePath,
  });
  input.model.move(input.item.path, newPierrePath, { collision: "replace" });
  input.model.focusPath(newPierrePath);
  await invalidateWorkspaceTreeQueries(input.queryClient, input.cwd);
}

async function deleteTreeEntry(input: {
  cwd: string;
  item: PierreContextMenuItem;
  model: ReturnType<typeof useFileTree>["model"];
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const relativePath = fromPierrePath(input.item.path);
  const api = ensureNativeApi();
  const confirmed = await api.dialogs.confirm(
    `Delete ${relativePath}${input.item.kind === "directory" ? " and everything inside it" : ""}?`,
  );
  if (!confirmed) {
    return;
  }
  await api.projects.deleteEntry({
    cwd: input.cwd,
    relativePath,
  });
  input.model.remove(input.item.path, { recursive: true });
  await invalidateWorkspaceTreeQueries(input.queryClient, input.cwd);
}

async function invalidateWorkspaceTreeQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  cwd: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.listTree(cwd) }),
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) }),
  ]);
}

function promptForEntryName(label: string, initialValue = ""): string | null {
  const value = window.prompt(label, initialValue);
  if (value === null) {
    return null;
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function joinRelativeWorkspacePath(parentPath: string, name: string): string {
  const normalizedParent = parentPath.replace(/^\/+|\/+$/g, "");
  const normalizedName = name.replace(/^\/+|\/+$/g, "");
  return normalizedParent ? `${normalizedParent}/${normalizedName}` : normalizedName;
}

function basenameOfWorkspacePath(relativePath: string): string {
  const parts = relativePath.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part) {
      return part;
    }
  }
  return relativePath;
}

function dirnameOfWorkspacePath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinWorkspacePath(cwd: string, relativePath: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  const normalizedRoot = cwd.replace(/[\\/]+$/, "");
  const normalizedRelative = relativePath.split("/").join(separator);
  return normalizedRelative ? `${normalizedRoot}${separator}${normalizedRelative}` : normalizedRoot;
}
