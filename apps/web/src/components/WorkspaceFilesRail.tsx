import { useMemo } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import type { ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { projectListDirectoryQueryOptions } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { getFilePanelThreadState, useFilePanelStore } from "../filePanelStore";

interface WorkspaceFilesRailProps {
  threadId: ThreadId;
  cwd: string | null;
  className?: string;
  onRevealFile?: ((path: string) => void) | undefined;
}

export function WorkspaceFilesRail(props: WorkspaceFilesRailProps) {
  const threadState = useFilePanelStore((store) => getFilePanelThreadState(store, props.threadId));
  const openFile = useFilePanelStore((store) => store.openFile);
  const toggleDirectory = useFilePanelStore((store) => store.toggleDirectory);
  const rootQuery = useQuery(
    projectListDirectoryQueryOptions({
      cwd: props.cwd,
      relativePath: null,
      enabled: props.cwd !== null,
    }),
  );

  const expandedDirectories = useMemo(
    () => new Set(threadState.expandedDirectories),
    [threadState.expandedDirectories],
  );
  const activeFilePath = threadState.activeTab.kind === "file" ? threadState.activeTab.path : null;

  return (
    <aside
      className={cn(
        "flex h-full w-[22rem] shrink-0 flex-col border-l border-border/50 bg-background/35 text-foreground",
        props.className,
      )}
    >
      <div className="flex h-[var(--app-desktop-content-header-height)] shrink-0 items-center border-b border-border/50 px-4">
        <span className="text-sm font-medium text-foreground/82">All files</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {rootQuery.isLoading ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">Loading files…</p>
        ) : props.cwd === null ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">File tree unavailable.</p>
        ) : (
          <WorkspaceDirectoryList
            cwd={props.cwd}
            threadId={props.threadId}
            entries={rootQuery.data?.entries ?? []}
            expandedDirectories={expandedDirectories}
            activeFilePath={activeFilePath}
            onOpenFile={(path) => {
              openFile(props.threadId, path);
              props.onRevealFile?.(path);
            }}
            onToggleDirectory={(path) => toggleDirectory(props.threadId, path)}
            depth={0}
          />
        )}
      </div>
    </aside>
  );
}

function WorkspaceDirectoryList(props: {
  cwd: string;
  threadId: ThreadId;
  entries: ReadonlyArray<{
    path: string;
    name: string;
    kind: "file" | "directory";
  }>;
  expandedDirectories: ReadonlySet<string>;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  depth: number;
}) {
  return (
    <div className="space-y-0.5">
      {props.entries.map((entry) =>
        entry.kind === "directory" ? (
          <WorkspaceDirectoryNode
            key={entry.path}
            cwd={props.cwd}
            threadId={props.threadId}
            path={entry.path}
            name={entry.name}
            expanded={props.expandedDirectories.has(entry.path)}
            expandedDirectories={props.expandedDirectories}
            activeFilePath={props.activeFilePath}
            onOpenFile={props.onOpenFile}
            onToggleDirectory={props.onToggleDirectory}
            depth={props.depth}
          />
        ) : (
          <button
            key={entry.path}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-foreground/72 transition-colors hover:bg-accent/35 hover:text-foreground",
              props.activeFilePath === entry.path ? "bg-accent/40 text-foreground" : "",
            )}
            style={{ paddingLeft: `${props.depth * 12 + 8}px` }}
            onClick={() => props.onOpenFile(entry.path)}
            title={entry.path}
          >
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            <span className="truncate">{entry.name}</span>
          </button>
        ),
      )}
    </div>
  );
}

function WorkspaceDirectoryNode(props: {
  cwd: string;
  threadId: ThreadId;
  path: string;
  name: string;
  expanded: boolean;
  expandedDirectories: ReadonlySet<string>;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  depth: number;
}) {
  const childQuery = useQuery(
    projectListDirectoryQueryOptions({
      cwd: props.cwd,
      relativePath: props.path,
      enabled: props.expanded,
    }),
  );

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-foreground/72 transition-colors hover:bg-accent/35 hover:text-foreground"
        style={{ paddingLeft: `${props.depth * 12 + 8}px` }}
        onClick={() => props.onToggleDirectory(props.path)}
        title={props.path}
      >
        {props.expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="truncate">{props.name}</span>
      </button>
      {props.expanded ? (
        childQuery.isLoading ? (
          <p
            className="px-2 py-1 text-[11px] text-muted-foreground/60"
            style={{ paddingLeft: `${(props.depth + 1) * 12 + 8}px` }}
          >
            Loading…
          </p>
        ) : (
          <WorkspaceDirectoryList
            cwd={props.cwd}
            threadId={props.threadId}
            entries={childQuery.data?.entries ?? []}
            expandedDirectories={props.expandedDirectories}
            activeFilePath={props.activeFilePath}
            onOpenFile={props.onOpenFile}
            onToggleDirectory={props.onToggleDirectory}
            depth={props.depth + 1}
          />
        )
      ) : null}
    </div>
  );
}
