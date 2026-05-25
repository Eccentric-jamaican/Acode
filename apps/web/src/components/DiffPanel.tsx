import {
  FileDiff,
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  File as PierreFile,
  type LineAnnotation,
  type SupportedLanguages,
} from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { type GitDiffScope, type GitReviewAction, ThreadId } from "@t3tools/contracts";
import JSZip from "jszip";
import {
  EllipsisIcon,
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  CopyIcon,
  SplitSquareHorizontalIcon,
  WrapTextIcon,
  Rows3Icon,
  Undo2Icon,
  PlusIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

import { parseDiffRouteSearch } from "../diffRouteSearch";
import { isElectronRuntime } from "../env";
import {
  useFilePanelStore,
  getFilePanelThreadState,
  type FilePanelComment,
} from "../filePanelStore";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import {
  gitDiffQueryOptions,
  gitFilePreviewQueryOptions,
  gitReviewActionMutationOptions,
  gitStatusQueryOptions,
} from "../lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "../lib/providerReactQuery";
import {
  projectFileMetadataQueryOptions,
  projectReadFileQueryOptions,
} from "../lib/projectReactQuery";
import { normalizeSyntaxLanguage } from "../lib/syntaxLanguage";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import type { Thread } from "../types";
import { Button } from "./ui/button";
import { PdfCanvasPreview } from "./PdfCanvasPreview";
import ChatMarkdown from "./ChatMarkdown";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

interface DiffPanelProps {
  mode?: "inline" | "sheet" | "sidebar";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

function inferFileViewerLanguage(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!extension) {
    return "text";
  }
  if (extension === "md") {
    return "markdown";
  }
  if (extension === "yml") {
    return "yaml";
  }
  if (extension === "mts" || extension === "cts") {
    return "ts";
  }
  return normalizeSyntaxLanguage(extension);
}

function isMarkdownFile(filePath: string): boolean {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extension === "md" || extension === "mdx" || extension === "markdown";
}

function officeDocumentKind(
  filePath: string,
): "spreadsheet" | "document" | "slides" | "pdf" | null {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "xls" || extension === "xlsx") return "spreadsheet";
  if (extension === "docx") return "document";
  if (extension === "pptx") return "slides";
  if (extension === "pdf") return "pdf";
  return null;
}

function previewMediaKind(filePath: string): "image" | null {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (
    extension === "avif" ||
    extension === "bmp" ||
    extension === "gif" ||
    extension === "ico" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "png" ||
    extension === "svg" ||
    extension === "webp"
  ) {
    return "image";
  }
  return null;
}

function previewFileKind(
  filePath: string,
): "spreadsheet" | "document" | "slides" | "pdf" | "image" | null {
  return officeDocumentKind(filePath) ?? previewMediaKind(filePath);
}

function isPdfFile(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === "pdf";
}

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const usesDesktopAppChrome = isElectronRuntime();
  const { resolvedTheme } = useTheme();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const filePanelState = useFilePanelStore((store) =>
    getFilePanelThreadState(store, activeThreadId),
  );
  const openFile = useFilePanelStore((store) => store.openFile);
  const closeFile = useFilePanelStore((store) => store.closeFile);
  const selectReview = useFilePanelStore((store) => store.selectReview);
  const toggleMarkdownRichView = useFilePanelStore((store) => store.toggleMarkdownRichView);
  const toggleCodeWordWrap = useFilePanelStore((store) => store.toggleCodeWordWrap);
  const addComment = useFilePanelStore((store) => store.addComment);
  const updateComment = useFilePanelStore((store) => store.updateComment);
  const deleteComment = useFilePanelStore((store) => store.deleteComment);

  useEffect(() => {
    if (!activeThreadId || !diffSearch.diffFilePath) {
      return;
    }
    openFile(activeThreadId, diffSearch.diffFilePath);
  }, [activeThreadId, diffSearch.diffFilePath, openFile]);

  const activeFilePath =
    filePanelState.activeTab.kind === "file" ? filePanelState.activeTab.path : null;
  const activeFileCwd =
    activeFilePath !== null
      ? (filePanelState.cwdByFilePath[activeFilePath] ?? activeCwd)
      : activeCwd;
  const markdownRichViewEnabled = Boolean(
    activeFilePath && !filePanelState.plainViewMarkdownFiles.includes(activeFilePath),
  );
  const codeWordWrapEnabled = Boolean(
    activeFilePath && filePanelState.noWrapCodeFiles.includes(activeFilePath),
  );
  const activeFileDocumentKind = activeFilePath ? previewFileKind(activeFilePath) : null;
  const activeThreadSessionStatus = activeThread?.session?.status ?? null;
  const liveDocumentMetadataRefreshInterval =
    activeFileDocumentKind !== null && activeThreadSessionStatus === "running" ? 1_500 : false;
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: activeFileCwd,
      relativePath: activeFilePath,
      enabled: activeFileCwd !== null && activeFilePath !== null,
      ...(activeFileDocumentKind !== null ? { staleTime: 0 } : {}),
    }),
  );
  const { refetch: refetchActiveFile } = activeFileQuery;
  const activeFileMetadataQuery = useQuery(
    projectFileMetadataQueryOptions({
      cwd: activeFileCwd,
      relativePath: activeFilePath,
      enabled:
        activeFileDocumentKind !== null &&
        activeFileCwd !== null &&
        activeFilePath !== null &&
        activeThreadSessionStatus === "running",
      refetchInterval: liveDocumentMetadataRefreshInterval,
    }),
  );
  const activeDocumentMetadataSignatureRef = useRef<string | null>(null);

  const breadcrumbs = useMemo(() => {
    if (!activeFilePath) return [] as string[];
    return activeFilePath.split("/").filter((segment) => segment.length > 0);
  }, [activeFilePath]);
  const activeFileName = breadcrumbs.at(-1) ?? null;
  const activeFileDisplayName =
    activeFilePath !== null
      ? (filePanelState.displayNameByFilePath[activeFilePath] ?? activeFileName)
      : activeFileName;
  const showFileSubheader = activeFilePath !== null && activeFileDocumentKind === null;
  useEffect(() => {
    if (activeFileDocumentKind === null || activeFileCwd === null || activeFilePath === null) {
      return;
    }
    void refetchActiveFile();
  }, [
    activeFileCwd,
    activeFileDocumentKind,
    activeFilePath,
    refetchActiveFile,
    activeThreadSessionStatus,
  ]);
  useEffect(() => {
    if (activeFileDocumentKind === null || activeFileCwd === null || activeFilePath === null) {
      activeDocumentMetadataSignatureRef.current = null;
      return;
    }
    const metadata = activeFileMetadataQuery.data;
    if (!metadata || metadata.status !== "file") {
      return;
    }

    const signature = `${activeFileCwd}:${activeFilePath}:${metadata.sizeBytes}:${metadata.modifiedAtMs}`;
    if (activeDocumentMetadataSignatureRef.current === null) {
      activeDocumentMetadataSignatureRef.current = signature;
      return;
    }
    if (activeDocumentMetadataSignatureRef.current !== signature) {
      activeDocumentMetadataSignatureRef.current = signature;
      void refetchActiveFile();
    }
  }, [
    activeFileCwd,
    activeFileDocumentKind,
    activeFileMetadataQuery.data,
    activeFilePath,
    refetchActiveFile,
  ]);
  const openActiveFileInEditor = () => {
    if (!activeFileCwd || !activeFilePath) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const targetPath = resolvePathLinkTarget(activeFilePath, activeFileCwd);
    void api.shell.openInEditor(targetPath, preferredTerminalEditor());
  };

  const headerRowClassName = cn(
    "desktop-top-edge-actions-safe flex min-w-0 items-end gap-2 border-b border-border/45 bg-muted/18 px-3",
    usesDesktopAppChrome && mode !== "sheet"
      ? "h-[var(--app-desktop-content-header-height)]"
      : "h-11",
  );

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background text-foreground",
        mode === "inline"
          ? "w-[42vw] min-w-[420px] max-w-[640px] shrink-0 border-l border-border/60"
          : "w-full",
      )}
    >
      <div className="shrink-0 border-b border-border/60 bg-background">
        <div
          className={headerRowClassName}
          data-testid={
            usesDesktopAppChrome && mode !== "sheet" ? "diff-panel-top-header" : undefined
          }
        >
          <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex min-w-max items-end gap-0">
              <ViewerTabButton
                active={filePanelState.activeTab.kind === "review"}
                onClick={() => {
                  if (activeThreadId) {
                    selectReview(activeThreadId);
                  }
                }}
              >
                Review
              </ViewerTabButton>
              {filePanelState.openFiles.map((filePath) => (
                <ViewerFileTab
                  key={filePath}
                  filePath={filePath}
                  displayName={filePanelState.displayNameByFilePath[filePath]}
                  active={activeFilePath === filePath}
                  onSelect={() => {
                    if (activeThreadId) {
                      openFile(activeThreadId, filePath);
                    }
                  }}
                  onClose={() => {
                    if (activeThreadId) {
                      closeFile(activeThreadId, filePath);
                    }
                  }}
                />
              ))}
            </div>
          </div>
        </div>
        {filePanelState.activeTab.kind === "file" && showFileSubheader ? (
          <div className="desktop-top-edge-actions-safe flex h-11 items-center justify-between gap-3 px-4 text-[12px] text-muted-foreground/72">
            {activeFilePath ? (
              <div className="min-w-0" data-testid="viewer-breadcrumbs">
                <div className="truncate text-[13px] font-medium text-foreground/88">
                  {activeFileDisplayName}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center overflow-hidden whitespace-nowrap text-[11px]">
                  {breadcrumbs.slice(0, -1).map((segment, index) => (
                    <span key={breadcrumbs.slice(0, index + 1).join("/")} className="contents">
                      {index > 0 ? (
                        <ChevronRightIcon className="mx-0.5 size-3 shrink-0 opacity-45" />
                      ) : null}
                      <span className="truncate">{segment}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <span className="truncate text-[13px] font-medium text-foreground/84">File</span>
            )}
            {activeFilePath ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Viewer options"
                      className="shrink-0"
                    />
                  }
                >
                  <EllipsisIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={openActiveFileInEditor}>
                    <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                    Open in editor
                  </MenuItem>
                  {isMarkdownFile(activeFilePath) ? (
                    <MenuItem
                      onClick={() => {
                        if (activeThreadId) {
                          toggleMarkdownRichView(activeThreadId, activeFilePath);
                        }
                      }}
                    >
                      <span className="text-muted-foreground">{"{}"}</span>
                      {markdownRichViewEnabled ? "Disable rich view" : "Enable rich view"}
                    </MenuItem>
                  ) : (
                    <MenuItem
                      onClick={() => {
                        if (activeThreadId) {
                          toggleCodeWordWrap(activeThreadId, activeFilePath);
                        }
                      }}
                    >
                      <span className="text-muted-foreground">{"↩"}</span>
                      {codeWordWrapEnabled ? "Disable word wrap" : "Enable word wrap"}
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {!activeThread ? (
          <PanelEmptyState message="Select a thread to inspect files." />
        ) : filePanelState.activeTab.kind === "review" ? (
          <ReviewSurface
            cwd={activeCwd}
            thread={activeThread}
            theme={resolvedTheme}
            commentsByFilePath={filePanelState.commentsByFilePath}
            onAddComment={(filePath, line, text, side) => {
              if (activeThreadId) {
                addComment(activeThreadId, filePath, line, text, side);
              }
            }}
            onUpdateComment={(filePath, commentId, text) => {
              if (activeThreadId) {
                updateComment(activeThreadId, filePath, commentId, text);
              }
            }}
            onDeleteComment={(filePath, commentId) => {
              if (activeThreadId) {
                deleteComment(activeThreadId, filePath, commentId);
              }
            }}
          />
        ) : activeFileQuery.isLoading ? (
          <PanelEmptyState message="Loading file…" />
        ) : activeFileQuery.data?.status === "document" && activeFilePath !== null ? (
          <OfficeDocumentViewer
            filePath={activeFilePath}
            contentsBase64={activeFileQuery.data.contentsBase64}
            mimeType={activeFileQuery.data.mimeType}
          />
        ) : activeFileQuery.data && activeFileQuery.data.status !== "text" ? (
          <PanelEmptyState
            message={
              activeFilePath !== null &&
              activeFileQuery.data.status === "binary" &&
              previewFileKind(activeFilePath) !== null
                ? "Preview is available, but the running server returned the old binary-file response. Restart the T3 server and reopen this file."
                : "message" in activeFileQuery.data
                  ? activeFileQuery.data.message
                  : "File unavailable."
            }
          />
        ) : activeFilePath !== null && activeFileQuery.data?.status === "text" ? (
          isMarkdownFile(activeFilePath) && markdownRichViewEnabled ? (
            <MarkdownFileViewer
              filePath={activeFilePath}
              contents={activeFileQuery.data.contents}
              cwd={activeFileCwd}
            />
          ) : (
            <Suspense fallback={<PanelEmptyState message="Loading syntax highlighting…" />}>
              <ReadOnlyFileViewer
                filePath={activeFilePath}
                contents={activeFileQuery.data.contents}
                comments={filePanelState.commentsByFilePath[activeFilePath] ?? []}
                theme={resolvedTheme}
                wrapLines={codeWordWrapEnabled}
                onAddComment={(line, text) => {
                  if (activeThreadId) {
                    addComment(activeThreadId, activeFilePath, line, text);
                  }
                }}
                onUpdateComment={(commentId, text) => {
                  if (activeThreadId) {
                    updateComment(activeThreadId, activeFilePath, commentId, text);
                  }
                }}
                onDeleteComment={(commentId) => {
                  if (activeThreadId) {
                    deleteComment(activeThreadId, activeFilePath, commentId);
                  }
                }}
              />
            </Suspense>
          )
        ) : (
          <PanelEmptyState message="Select a file to view it here." />
        )}
      </div>
    </div>
  );
}

function ViewerTabButton(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center border-b-2 px-3 text-[12px] font-medium transition-colors",
        props.active
          ? "border-primary/70 bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--border)/0.35)]"
          : "border-transparent bg-transparent text-muted-foreground/74 hover:bg-background/55 hover:text-foreground",
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function ViewerFileTab(props: {
  filePath: string;
  displayName?: string | undefined;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = props.displayName ?? props.filePath.split("/").at(-1) ?? props.filePath;
  return (
    <div
      className={cn(
        "inline-flex h-9 max-w-56 items-center gap-1 border-b-2 px-3 text-[12px] transition-colors",
        props.active
          ? "border-primary/70 bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--border)/0.35)]"
          : "border-transparent bg-transparent text-muted-foreground/74 hover:bg-background/55 hover:text-foreground",
      )}
    >
      <button type="button" className="flex min-w-0 items-center gap-1" onClick={props.onSelect}>
        <FileIcon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        className="rounded-sm text-muted-foreground/70 hover:text-foreground"
        onClick={props.onClose}
        aria-label={`Close ${label}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

const REVIEW_DIFF_UNSAFE_CSS = `
  :host {
    display: block;
    min-height: 100%;
    background: transparent;
    color: hsl(var(--foreground));
    font-family: inherit;
    --diffs-font-family-override: var(--font-mono);
    --diffs-font-size-override: 12px;
    --diffs-line-height-override: 1.45rem;
    --diffs-bg-override: transparent;
    --diffs-fg-override: hsl(var(--foreground) / 0.9);
    --diffs-border-color-override: hsl(var(--border) / 0.52);
    --diffs-gutter-fg-override: hsl(var(--muted-foreground) / 0.54);
    --diffs-gutter-bg-override: transparent;
    --diffs-line-hover-bg-override: hsl(var(--accent) / 0.08);
    --diffs-add-bg-override: hsl(142 54% 28% / 0.18);
    --diffs-del-bg-override: hsl(0 66% 42% / 0.16);
    --diffs-add-fg-override: hsl(142 78% 38%);
    --diffs-del-fg-override: hsl(0 82% 58%);
  }

  pre {
    margin: 0;
    padding: 0 0 28px;
    background: transparent;
    outline: none;
  }

  pre[data-file] {
    border: 0;
  }

  [data-file-header] {
    position: sticky;
    top: 40px;
    z-index: 1;
    min-height: 42px;
    border-bottom: 1px solid hsl(var(--border) / 0.52);
    background: hsl(var(--background) / 0.96);
    backdrop-filter: blur(12px);
  }

  [data-line] {
    min-height: 22px;
  }

  [data-column-number],
  [data-line-number-content] {
    color: hsl(var(--muted-foreground) / 0.5);
    user-select: none;
  }

  [data-column-number] {
    padding-left: 28px;
  }

  [data-column-content] {
    padding-right: 24px;
  }

  [data-gutter-utility-slot] {
    left: 5px;
    right: auto;
    z-index: 8;
    width: 20px;
    align-items: center;
    overflow: visible;
    pointer-events: none;
  }

  [data-utility-button] {
    width: 20px;
    height: 20px;
    margin-right: 0;
    border: 1px solid hsl(var(--border) / 0.72);
    border-radius: 6px;
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    box-shadow: 0 1px 3px hsl(0 0% 0% / 0.18);
    pointer-events: auto;
  }

  [data-utility-button]:hover {
    background: hsl(var(--accent));
  }

  [data-hunk-separator] {
    background: hsl(var(--muted) / 0.58);
    color: hsl(var(--muted-foreground) / 0.78);
  }
`;

type ReviewScope = GitDiffScope | "last-turn";

function ReviewSurface(props: {
  cwd: string | null;
  thread: Thread;
  theme: "light" | "dark";
  commentsByFilePath: Record<string, FilePanelComment[]>;
  onAddComment: (
    filePath: string,
    line: number,
    text: string,
    side: FilePanelComment["side"],
  ) => void;
  onUpdateComment: (filePath: string, commentId: string, text: string) => void;
  onDeleteComment: (filePath: string, commentId: string) => void;
}) {
  const [scope, setScope] = useState<ReviewScope>("unstaged");
  const [wordWrap, setWordWrap] = useState(false);
  const [wordDiffs, setWordDiffs] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [draftComment, setDraftComment] = useState<{
    filePath: string;
    line: number;
    side: AnnotationSide;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const queryClient = useQueryClient();
  const statusQuery = useQuery(gitStatusQueryOptions(props.cwd));
  const gitScope: GitDiffScope = scope === "last-turn" ? "unstaged" : scope;
  const diffQuery = useQuery(
    gitDiffQueryOptions({
      cwd: props.cwd,
      scope: gitScope,
      enabled: scope !== "last-turn",
    }),
  );
  const lastChangedTurnCheckpoint = useMemo(() => {
    return (
      props.thread.turnDiffSummaries
        .filter(
          (summary) =>
            summary.files.length > 0 &&
            typeof summary.checkpointTurnCount === "number" &&
            summary.checkpointTurnCount > 0,
        )
        .toSorted(
          (left, right) => (right.checkpointTurnCount ?? 0) - (left.checkpointTurnCount ?? 0),
        )[0] ?? null
    );
  }, [props.thread.turnDiffSummaries]);
  const lastTurnToTurnCount = lastChangedTurnCheckpoint?.checkpointTurnCount ?? null;
  const lastTurnFromTurnCount =
    lastTurnToTurnCount !== null ? Math.max(0, lastTurnToTurnCount - 1) : null;
  const lastTurnDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: props.thread.id,
      fromTurnCount: lastTurnFromTurnCount,
      toTurnCount: lastTurnToTurnCount,
      cacheScope: "review:last-turn",
      enabled: scope === "last-turn" && lastTurnToTurnCount !== null,
    }),
  );
  const reviewActionMutation = useMutation(
    gitReviewActionMutationOptions({ cwd: props.cwd, queryClient }),
  );
  const themeName = resolveDiffThemeName(props.theme);
  const patch =
    scope === "last-turn" ? (lastTurnDiffQuery.data?.diff ?? "") : (diffQuery.data?.patch ?? "");
  const hasPatch = patch.trim().length > 0;
  const reviewFiles = useMemo(() => parseReviewPatchFiles(patch), [patch]);
  const reviewStats = useMemo(() => summarizeReviewFiles(reviewFiles), [reviewFiles]);
  const scopeLabel = reviewScopeLabel(scope);
  const isLoading = scope === "last-turn" ? lastTurnDiffQuery.isLoading : diffQuery.isLoading;
  const isError = scope === "last-turn" ? lastTurnDiffQuery.isError : diffQuery.isError;
  const isFetching = scope === "last-turn" ? lastTurnDiffQuery.isFetching : diffQuery.isFetching;
  const canRunWorkingTreeActions =
    props.cwd !== null && hasPatch && (scope === "unstaged" || scope === "staged");

  const refresh = () => {
    void statusQuery.refetch();
    if (scope === "last-turn") {
      void lastTurnDiffQuery.refetch();
    } else {
      void diffQuery.refetch();
    }
  };

  const copyToClipboard = async (value: string, title: string) => {
    if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
      toastManager.add({ type: "error", title: "Clipboard unavailable" });
      return;
    }
    await navigator.clipboard.writeText(value);
    toastManager.add({ type: "success", title });
  };

  const copyPatch = () => {
    void copyToClipboard(patch, "Patch copied");
  };

  const copyGitApplyCommand = () => {
    const command = `@'\n${patch.replace(/'@/g, "' @")}\n'@ | git apply -`;
    void copyToClipboard(command, "git apply command copied");
  };

  const runReviewAction = async (action: GitReviewAction, path?: string) => {
    if (!props.cwd || reviewActionMutation.isPending) {
      return;
    }
    if (action === "revertUnstagedAll" || action === "revertUnstagedPath") {
      const api = readNativeApi();
      const confirmed = await api?.dialogs.confirm(
        path
          ? `Revert unstaged changes in ${path}?`
          : "Revert all unstaged tracked changes in this workspace?",
      );
      if (!confirmed) {
        return;
      }
    }
    await reviewActionMutation.mutateAsync(path ? { action, path } : action);
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/55 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="inline-flex h-8 rounded-md bg-muted/70 p-0.5 text-[12px]">
            <ReviewScopeButton active={scope === "unstaged"} onClick={() => setScope("unstaged")}>
              Unstaged
            </ReviewScopeButton>
            <ReviewScopeButton active={scope === "staged"} onClick={() => setScope("staged")}>
              Staged
            </ReviewScopeButton>
            <ReviewScopeButton active={scope === "branch"} onClick={() => setScope("branch")}>
              Branch
            </ReviewScopeButton>
            <ReviewScopeButton active={scope === "last-turn"} onClick={() => setScope("last-turn")}>
              Last turn
            </ReviewScopeButton>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Review options" />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setWordWrap((value) => !value)}>
                <WrapTextIcon className="size-3.5 text-muted-foreground" />
                {wordWrap ? "Disable word wrap" : "Enable word wrap"}
              </MenuItem>
              <MenuItem onClick={() => setWordDiffs((value) => !value)}>
                <span className="font-mono text-muted-foreground">Aa</span>
                {wordDiffs ? "Disable word diffs" : "Enable word diffs"}
              </MenuItem>
              <MenuItem onClick={() => setCollapsed((value) => !value)}>
                <Rows3Icon className="size-3.5 text-muted-foreground" />
                {collapsed ? "Expand all diffs" : "Collapse all diffs"}
              </MenuItem>
              <MenuItem
                onClick={() => setDiffStyle((value) => (value === "unified" ? "split" : "unified"))}
              >
                <SplitSquareHorizontalIcon className="size-3.5 text-muted-foreground" />
                {diffStyle === "unified" ? "Use split diff" : "Use unified diff"}
              </MenuItem>
              <MenuItem disabled={!hasPatch} onClick={copyPatch}>
                <CopyIcon className="size-3.5 text-muted-foreground" />
                Copy patch
              </MenuItem>
              <MenuItem disabled={!hasPatch} onClick={copyGitApplyCommand}>
                <CopyIcon className="size-3.5 text-muted-foreground" />
                Copy git apply command
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh review"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-auto", canRunWorkingTreeActions && "pb-16")}>
        {!props.cwd ? (
          <PanelEmptyState message="Review is unavailable without a workspace." />
        ) : scope === "last-turn" && lastTurnToTurnCount === null ? (
          <PanelEmptyState message="No completed turn changes to review yet." />
        ) : isLoading ? (
          <PanelEmptyState message={`Loading ${scopeLabel.toLowerCase()} changes…`} />
        ) : isError ? (
          <PanelEmptyState message="Unable to load the review diff." />
        ) : !hasPatch || reviewFiles.length === 0 ? (
          <PanelEmptyState message={`No ${scopeLabel.toLowerCase()} changes to review.`} />
        ) : (
          <div className="min-w-0">
            <ReviewFileNavigator files={reviewFiles} stats={reviewStats} />
            {reviewFiles.map((fileDiff, index) => (
              <div
                id={reviewFileDomId(index)}
                key={fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}:${fileDiff.name}:${index}`}
                className="scroll-mt-20"
              >
                {scope !== "last-turn" && isPdfFile(fileDiff.name) ? (
                  <ReviewPdfDiff
                    cwd={props.cwd}
                    fileDiff={fileDiff}
                    scope={scope}
                    disabled={reviewActionMutation.isPending}
                    onAction={(action) => void runReviewAction(action, fileDiff.name)}
                  />
                ) : (
                  <FileDiff
                    fileDiff={fileDiff}
                    lineAnnotations={reviewLineAnnotationsForFile({
                      filePath: fileDiff.name,
                      comments: props.commentsByFilePath[fileDiff.name] ?? [],
                      draft: draftComment,
                    })}
                    options={{
                      collapsed,
                      diffStyle,
                      enableGutterUtility: true,
                      hunkSeparators: "line-info",
                      lineDiffType: wordDiffs ? "word" : "none",
                      maxLineDiffLength: 2_000,
                      overflow: wordWrap ? "wrap" : "scroll",
                      preferredHighlighter: "shiki-js",
                      theme: themeName,
                      themeType: props.theme,
                      tokenizeMaxLineLength: 1_000,
                      unsafeCSS: REVIEW_DIFF_UNSAFE_CSS,
                      onGutterUtilityClick: (range) => {
                        setDraftComment({
                          filePath: fileDiff.name,
                          line: range.start,
                          side: range.side ?? "additions",
                        });
                        setDraftText("");
                      },
                    }}
                    renderAnnotation={(annotation) => (
                      <FileLineAnnotation
                        annotation={annotation}
                        draftText={draftText}
                        label={`Comment on ${annotation.side === "additions" ? "new" : "old"} line ${annotation.lineNumber}`}
                        onCancelDraft={() => setDraftComment(null)}
                        onChangeDraftText={setDraftText}
                        onDeleteComment={(commentId) =>
                          props.onDeleteComment(fileDiff.name, commentId)
                        }
                        onSaveComment={(lineNumber) => {
                          props.onAddComment(
                            fileDiff.name,
                            lineNumber,
                            draftText.trim(),
                            annotation.side,
                          );
                          setDraftText("");
                          setDraftComment(null);
                        }}
                        onUpdateComment={(commentId, text) =>
                          props.onUpdateComment(fileDiff.name, commentId, text)
                        }
                      />
                    )}
                    renderHeaderMetadata={() => (
                      <ReviewFileActions
                        filePath={fileDiff.name}
                        scope={scope}
                        disabled={reviewActionMutation.isPending}
                        onAction={(action) => void runReviewAction(action, fileDiff.name)}
                      />
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {canRunWorkingTreeActions ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/92 p-1 shadow-lg shadow-black/10 backdrop-blur">
            {scope === "unstaged" ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={reviewActionMutation.isPending}
                  onClick={() => void runReviewAction("revertUnstagedAll")}
                >
                  Revert all
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={reviewActionMutation.isPending}
                  onClick={() => void runReviewAction("stageAll")}
                >
                  Stage all
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={reviewActionMutation.isPending}
                onClick={() => void runReviewAction("unstageAll")}
              >
                Unstage all
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseReviewPatchFiles(patch: string): FileDiffMetadata[] {
  const trimmed = patch.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parsedFiles = parsePatchFiles(trimmed, "review").flatMap(
    (parsedPatch) => parsedPatch.files,
  );
  const binaryFiles = parseBinaryReviewPatchFiles(trimmed);
  const parsedNames = new Set(parsedFiles.map((file) => file.name));
  return [...parsedFiles, ...binaryFiles.filter((file) => !parsedNames.has(file.name))];
}

function parseBinaryReviewPatchFiles(patch: string): FileDiffMetadata[] {
  const files: FileDiffMetadata[] = [];
  const diffHeaderPattern = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = diffHeaderPattern.exec(patch)) !== null) {
    const previousName = match[1] ?? "";
    const name = match[2] ?? previousName;
    const nextHeaderIndex = patch.indexOf("\ndiff --git ", diffHeaderPattern.lastIndex);
    const section = patch.slice(match.index, nextHeaderIndex >= 0 ? nextHeaderIndex : patch.length);
    if (!/Binary files .* differ|GIT binary patch/.test(section)) {
      continue;
    }
    files.push({
      name,
      type: "change",
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: true,
      additionLines: [],
      deletionLines: [],
      ...(previousName !== name ? { prevName: previousName } : {}),
      cacheKey: `review-binary-${files.length}`,
    } as FileDiffMetadata);
  }
  return files;
}

function ReviewPdfDiff(props: {
  cwd: string | null;
  disabled: boolean;
  fileDiff: FileDiffMetadata;
  onAction: (action: GitReviewAction) => void;
  scope: GitDiffScope;
}) {
  const previewQuery = useQuery(
    gitFilePreviewQueryOptions({
      cwd: props.cwd,
      path: props.fileDiff.name,
      scope: props.scope,
    }),
  );
  const stats = summarizeReviewFile(props.fileDiff);

  return (
    <section className="border-b border-border/60 bg-background">
      <div className="sticky top-10 z-[9] flex min-h-11 items-center justify-between gap-3 border-b border-border/55 bg-background/95 px-3 py-2 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">
            {props.fileDiff.name}
            <span className="ml-2 font-mono text-[12px] text-emerald-600 dark:text-emerald-400">
              +{stats.additions}
            </span>
            <span className="ml-1 font-mono text-[12px] text-red-600 dark:text-red-400">
              -{stats.deletions}
            </span>
          </div>
          {props.fileDiff.prevName && props.fileDiff.prevName !== props.fileDiff.name ? (
            <div className="truncate text-[11px] text-muted-foreground/70">
              {props.fileDiff.prevName}
            </div>
          ) : null}
        </div>
        <ReviewFileActions
          filePath={props.fileDiff.name}
          scope={props.scope}
          disabled={props.disabled}
          onAction={props.onAction}
        />
      </div>
      {previewQuery.isLoading ? (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground/70">
          Loading PDF preview...
        </div>
      ) : previewQuery.isError || !previewQuery.data ? (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground/70">
          Unable to load PDF preview.
        </div>
      ) : (
        <div className="grid gap-4 bg-muted/28 p-4 xl:grid-cols-2">
          <ReviewPdfSide
            contentsBase64={previewQuery.data.before.contentsBase64}
            status={previewQuery.data.before.status}
            filePath={props.fileDiff.prevName ?? props.fileDiff.name}
          />
          <ReviewPdfSide
            contentsBase64={previewQuery.data.after.contentsBase64}
            status={previewQuery.data.after.status}
            filePath={props.fileDiff.name}
          />
        </div>
      )}
    </section>
  );
}

function ReviewPdfSide(props: {
  contentsBase64?: string | undefined;
  filePath: string;
  status: "missing" | "present";
}) {
  return (
    <div className="min-w-0 overflow-hidden">
      {props.status === "present" && props.contentsBase64 ? (
        <PdfCanvasPreview
          bytes={bytesFromBase64(props.contentsBase64)}
          filePath={props.filePath}
          layout="embedded"
          mimeType="application/pdf"
        />
      ) : (
        <div className="flex h-72 items-center justify-center rounded-md border border-border/55 bg-background text-xs text-muted-foreground/70">
          No file on this side.
        </div>
      )}
    </div>
  );
}

function reviewFileDomId(index: number): string {
  return `review-file-${index}`;
}

function summarizeReviewFile(file: FileDiffMetadata): { additions: number; deletions: number } {
  return file.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      deletions: stats.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

function summarizeReviewFiles(files: readonly FileDiffMetadata[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (stats, file) => {
      const fileStats = summarizeReviewFile(file);
      return {
        additions: stats.additions + fileStats.additions,
        deletions: stats.deletions + fileStats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

function reviewLineAnnotationsForFile(input: {
  filePath: string;
  comments: readonly FilePanelComment[];
  draft: { filePath: string; line: number; side: AnnotationSide } | null;
}): Array<DiffLineAnnotation<FileCommentAnnotation>> {
  const commentsByLineAndSide = new Map<string, FilePanelComment[]>();
  for (const comment of input.comments) {
    const side = comment.side ?? "additions";
    const key = `${side}:${comment.line}`;
    const existing = commentsByLineAndSide.get(key);
    if (existing) {
      existing.push(comment);
    } else {
      commentsByLineAndSide.set(key, [comment]);
    }
  }

  if (input.draft?.filePath === input.filePath) {
    const key = `${input.draft.side}:${input.draft.line}`;
    if (!commentsByLineAndSide.has(key)) {
      commentsByLineAndSide.set(key, []);
    }
  }

  return [...commentsByLineAndSide.entries()]
    .map(([key, comments]) => {
      const [side, lineNumberRaw] = key.split(":");
      return {
        side: side === "deletions" ? "deletions" : "additions",
        lineNumber: Number.parseInt(lineNumberRaw ?? "0", 10),
        metadata: {
          comments,
          draft:
            input.draft?.filePath === input.filePath &&
            input.draft.line === Number.parseInt(lineNumberRaw ?? "0", 10) &&
            input.draft.side === side,
        },
      } satisfies DiffLineAnnotation<FileCommentAnnotation>;
    })
    .filter((annotation) => Number.isFinite(annotation.lineNumber) && annotation.lineNumber > 0)
    .toSorted((left, right) => {
      if (left.side !== right.side) {
        return left.side === "deletions" ? -1 : 1;
      }
      return left.lineNumber - right.lineNumber;
    });
}

function ReviewFileNavigator(props: {
  files: readonly FileDiffMetadata[];
  stats: { additions: number; deletions: number };
}) {
  return (
    <div className="sticky top-0 z-10 flex h-10 items-center justify-between gap-3 border-b border-border/55 bg-background/95 px-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="max-w-44 justify-start px-1.5 text-foreground/86"
              />
            }
          >
            <FileIcon className="size-3.5" />
            <span className="truncate">
              {props.files.length} {props.files.length === 1 ? "file" : "files"}
            </span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-96 max-w-[calc(100vw-2rem)]">
            {props.files.map((file, index) => {
              const stats = summarizeReviewFile(file);
              return (
                <MenuItem
                  key={file.cacheKey ?? `${file.prevName ?? ""}:${file.name}:${index}`}
                  className="grid grid-cols-[1fr_auto_auto] gap-3"
                  title={file.prevName ? `${file.prevName} -> ${file.name}` : file.name}
                  onClick={() => {
                    document.getElementById(reviewFileDomId(index))?.scrollIntoView({
                      block: "start",
                      behavior: "smooth",
                    });
                  }}
                >
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="font-mono text-emerald-600 dark:text-emerald-400">
                    +{stats.additions}
                  </span>
                  <span className="font-mono text-red-600 dark:text-red-400">
                    -{stats.deletions}
                  </span>
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
        <span className="font-mono text-emerald-600 dark:text-emerald-400">
          +{props.stats.additions}
        </span>
        <span className="font-mono text-red-600 dark:text-red-400">-{props.stats.deletions}</span>
      </div>
    </div>
  );
}

function ReviewFileActions(props: {
  filePath: string;
  scope: ReviewScope;
  disabled: boolean;
  onAction: (action: GitReviewAction) => void;
}) {
  if (props.scope === "branch" || props.scope === "last-turn") {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      {props.scope === "unstaged" ? (
        <>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={props.disabled}
            aria-label={`Revert unstaged changes in ${props.filePath}`}
            onClick={() => props.onAction("revertUnstagedPath")}
          >
            <Undo2Icon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={props.disabled}
            aria-label={`Stage ${props.filePath}`}
            onClick={() => props.onAction("stagePath")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={props.disabled}
          onClick={() => props.onAction("unstagePath")}
        >
          Unstage
        </Button>
      )}
    </div>
  );
}

function reviewScopeLabel(scope: ReviewScope): string {
  switch (scope) {
    case "staged":
      return "Staged";
    case "branch":
      return "Branch";
    case "last-turn":
      return "Last turn";
    case "unstaged":
      return "Unstaged";
  }
}

function ReviewScopeButton(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center rounded-[5px] px-2.5 text-muted-foreground transition-colors",
        props.active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function PanelEmptyState(props: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
      {props.message}
    </div>
  );
}

function MarkdownFileViewer(props: { filePath: string; contents: string; cwd: string | null }) {
  return (
    <div className="h-full overflow-auto bg-background">
      <div className="px-6 py-6">
        <ChatMarkdown text={props.contents} cwd={props.cwd ?? undefined} />
      </div>
    </div>
  );
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textFromXmlNode(node: Element): string {
  return [...node.getElementsByTagName("a:t"), ...node.getElementsByTagName("w:t")]
    .map((entry) => entry.textContent ?? "")
    .join("");
}

function previewKey(parts: readonly unknown[]): string {
  return parts.map((part) => String(part)).join(":");
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

type ParsedDocx = { paragraphs: string[] };
type ParsedPptxSlide = { slideNumber: number; title: string; lines: string[] };

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) return { paragraphs: [] };
  const doc = parseXml(documentXml);
  const paragraphs = [...doc.getElementsByTagName("w:p")]
    .map((paragraph) =>
      [...paragraph.getElementsByTagName("w:t")].map((node) => node.textContent ?? "").join(""),
    )
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return { paragraphs };
}

async function parsePptx(bytes: Uint8Array): Promise<ParsedPptxSlide[]> {
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .toSorted((left, right) => {
      const leftNumber = Number.parseInt(left.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
      const rightNumber = Number.parseInt(right.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
      return leftNumber - rightNumber;
    });

  const slides: ParsedPptxSlide[] = [];
  for (const [index, fileName] of slideFiles.entries()) {
    const slideXml = await zip.file(fileName)?.async("text");
    if (!slideXml) continue;
    const doc = parseXml(slideXml);
    const lines = [...doc.getElementsByTagName("a:p")]
      .map(textFromXmlNode)
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    slides.push({
      slideNumber: index + 1,
      title: lines[0] ?? `Slide ${index + 1}`,
      lines,
    });
  }
  return slides;
}

function OfficeDocumentViewer(props: {
  filePath: string;
  contentsBase64: string;
  mimeType: string;
}) {
  const kind = previewFileKind(props.filePath);
  const [docx, setDocx] = useState<ParsedDocx | null>(null);
  const [pptx, setPptx] = useState<ParsedPptxSlide[] | null>(null);
  const [selectedSlideIndex, setSelectedSlideIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bytes = useMemo(() => bytesFromBase64(props.contentsBase64), [props.contentsBase64]);

  const workbook = useMemo(() => {
    if (kind !== "spreadsheet") return null;
    try {
      setError(null);
      return XLSX.read(bytes, { type: "array" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to preview spreadsheet.");
      return null;
    }
  }, [bytes, kind]);

  useEffect(() => {
    let cancelled = false;
    setDocx(null);
    setPptx(null);
    setError(null);
    setSelectedSlideIndex(0);

    if (kind === "document") {
      void parseDocx(bytes)
        .then((parsed) => {
          if (!cancelled) setDocx(parsed);
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : "Unable to preview document.");
          }
        });
    }

    if (kind === "slides") {
      void parsePptx(bytes)
        .then((parsed) => {
          if (!cancelled) setPptx(parsed);
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : "Unable to preview slides.");
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [bytes, kind]);

  if (!kind) {
    return <PanelEmptyState message={`Preview unavailable for ${props.mimeType}.`} />;
  }

  if (error) {
    return <PanelEmptyState message={error} />;
  }

  if (kind === "spreadsheet") {
    return <SpreadsheetPreview workbook={workbook} />;
  }

  if (kind === "pdf") {
    return <PdfCanvasPreview bytes={bytes} filePath={props.filePath} mimeType={props.mimeType} />;
  }

  if (kind === "image") {
    return (
      <ImagePreview
        contentsBase64={props.contentsBase64}
        filePath={props.filePath}
        mimeType={props.mimeType}
      />
    );
  }

  if (kind === "document") {
    return docx ? (
      <WordPreview document={docx} />
    ) : (
      <PanelEmptyState message="Loading document..." />
    );
  }

  return pptx ? (
    <SlidesPreview
      slides={pptx}
      selectedSlideIndex={selectedSlideIndex}
      onSelectSlide={setSelectedSlideIndex}
    />
  ) : (
    <PanelEmptyState message="Loading slides..." />
  );
}

function SpreadsheetPreview(props: { workbook: XLSX.WorkBook | null }) {
  const [sheetName, setSheetName] = useState<string | null>(null);
  const activeSheetName = sheetName ?? props.workbook?.SheetNames[0] ?? null;
  const rows = useMemo(() => {
    if (!props.workbook || !activeSheetName) return [];
    const sheet = props.workbook.Sheets[activeSheetName];
    return sheet
      ? XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, { header: 1 })
      : [];
  }, [activeSheetName, props.workbook]);

  if (!props.workbook || !activeSheetName) {
    return <PanelEmptyState message="Spreadsheet is empty." />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/55 px-3">
        {props.workbook.SheetNames.map((name) => (
          <Button
            key={name}
            type="button"
            size="xs"
            variant={name === activeSheetName ? "secondary" : "ghost"}
            onClick={() => setSheetName(name)}
          >
            {name}
          </Button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto p-4">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <tbody>
            {rows.slice(0, 500).map((row, rowIndex) => (
              <tr key={previewKey(["row", rowIndex, row.join("|")])} className="odd:bg-muted/24">
                {Array.from({ length: Math.max(1, row.length) }).map((_, cellIndex) => (
                  <td
                    key={previewKey(["cell", rowIndex, cellIndex, row[cellIndex] ?? ""])}
                    className="max-w-72 truncate border-b border-r border-border/45 px-2 py-1.5"
                    title={String(row[cellIndex] ?? "")}
                  >
                    {String(row[cellIndex] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImagePreview(props: { contentsBase64: string; filePath: string; mimeType: string }) {
  const imageUrl = useMemo(
    () => `data:${props.mimeType};base64,${props.contentsBase64}`,
    [props.contentsBase64, props.mimeType],
  );

  return (
    <div className="flex h-full min-w-0 items-center justify-center overflow-auto bg-muted/20 p-6">
      <img
        alt={props.filePath}
        src={imageUrl}
        className="max-h-full max-w-full rounded-md object-contain shadow-sm"
      />
    </div>
  );
}

function WordPreview(props: { document: ParsedDocx }) {
  return (
    <div className="h-full overflow-auto bg-background">
      <article className="min-h-full max-w-5xl px-8 py-8 text-left">
        {props.document.paragraphs.length > 0 ? (
          props.document.paragraphs.map((paragraph, index) => (
            <p
              key={previewKey(["paragraph", index, paragraph])}
              className="mb-5 text-[15px] leading-8 text-foreground/82"
            >
              {paragraph}
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Document has no readable text.</p>
        )}
      </article>
    </div>
  );
}

function SlidesPreview(props: {
  slides: ParsedPptxSlide[];
  selectedSlideIndex: number;
  onSelectSlide: (index: number) => void;
}) {
  const selectedSlide = props.slides[props.selectedSlideIndex] ?? props.slides[0];
  if (!selectedSlide) {
    return <PanelEmptyState message="Presentation has no readable slides." />;
  }

  return (
    <div className="grid h-full min-w-0 grid-cols-[168px_1fr] bg-background">
      <div className="min-h-0 overflow-auto border-r border-border/55 p-3">
        {props.slides.map((slide, index) => (
          <button
            key={slide.slideNumber}
            type="button"
            className={cn(
              "mb-3 block w-full rounded-md border p-2 text-left text-xs",
              index === props.selectedSlideIndex
                ? "border-primary/70 bg-primary/8"
                : "border-border/60 bg-muted/18 hover:bg-accent",
            )}
            onClick={() => props.onSelectSlide(index)}
          >
            <div className="mb-1 font-medium text-foreground/80">{slide.slideNumber}</div>
            <div className="aspect-video overflow-hidden rounded-sm bg-background p-2 text-[8px] leading-tight text-muted-foreground">
              {slide.title}
            </div>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto bg-muted/25 p-8">
        <div className="mx-auto aspect-video max-w-5xl rounded-lg border border-border/60 bg-background p-12 shadow-sm">
          <h1 className="mb-8 text-3xl font-semibold text-foreground">{selectedSlide.title}</h1>
          <div className="space-y-4 text-lg leading-8 text-foreground/82">
            {selectedSlide.lines.slice(1).map((line, index) => (
              <p key={previewKey(["slide-line", selectedSlide.slideNumber, index, line])}>{line}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type FileCommentAnnotation = {
  comments: readonly FilePanelComment[];
  draft: boolean;
};

const PIERRE_FILE_VIEWER_UNSAFE_CSS = `
  :host {
    display: block;
    min-height: 100%;
    background: transparent;
    color: hsl(var(--foreground));
    font-family: inherit;
    --diffs-font-family-override: var(--font-mono);
    --diffs-font-size-override: 12px;
    --diffs-line-height-override: 1.45rem;
    --diffs-bg-override: transparent;
    --diffs-fg-override: hsl(var(--foreground) / 0.88);
    --diffs-border-color-override: hsl(var(--border) / 0.52);
    --diffs-gutter-fg-override: hsl(var(--muted-foreground) / 0.54);
    --diffs-gutter-bg-override: transparent;
    --diffs-line-hover-bg-override: hsl(var(--accent) / 0.1);
    --diffs-selected-bg-override: hsl(var(--accent) / 0.18);
  }

  pre {
    margin: 0;
    padding: 12px 0 24px;
    background: transparent;
    outline: none;
  }

  pre[data-file] {
    border: 0;
  }

  [data-line] {
    min-height: 22px;
  }

  [data-column-number],
  [data-line-number-content] {
    color: hsl(var(--muted-foreground) / 0.48);
    user-select: none;
  }

  [data-column-number] {
    padding-left: 28px;
  }

  [data-column-content] {
    padding-right: 24px;
  }

  [data-line]:hover {
    background: hsl(var(--accent) / 0.08);
  }

  [data-gutter-utility-slot] {
    left: 5px;
    right: auto;
    z-index: 8;
    width: 20px;
    align-items: center;
    overflow: visible;
    pointer-events: none;
  }

  [data-utility-button] {
    width: 20px;
    height: 20px;
    margin-right: 0;
    border: 1px solid hsl(var(--border) / 0.72);
    border-radius: 6px;
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    box-shadow: 0 1px 3px hsl(0 0% 0% / 0.18);
    pointer-events: auto;
  }

  [data-utility-button]:hover {
    background: hsl(var(--accent));
  }

  [data-line-annotation] {
    background: transparent;
  }
`;

function ReadOnlyFileViewer(props: {
  filePath: string;
  contents: string;
  comments: readonly FilePanelComment[];
  theme: "light" | "dark";
  wrapLines: boolean;
  onAddComment: (line: number, text: string) => void;
  onUpdateComment: (commentId: string, text: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draftText, setDraftText] = useState("");
  const themeName = resolveDiffThemeName(props.theme);
  const language = inferFileViewerLanguage(props.filePath) as SupportedLanguages;
  const file = useMemo<FileContents>(
    () => ({
      name: props.filePath,
      contents: props.contents,
      lang: language,
      cacheKey: buildPatchCacheKey(props.contents, `file:${props.filePath}:${themeName}`),
    }),
    [language, props.contents, props.filePath, themeName],
  );
  const lineAnnotations = useMemo<Array<LineAnnotation<FileCommentAnnotation>>>(() => {
    const commentsByLine = new Map<number, FilePanelComment[]>();
    for (const comment of props.comments) {
      const existing = commentsByLine.get(comment.line);
      if (existing) {
        existing.push(comment);
      } else {
        commentsByLine.set(comment.line, [comment]);
      }
    }

    if (draftLine !== null && !commentsByLine.has(draftLine)) {
      commentsByLine.set(draftLine, []);
    }

    return [...commentsByLine.entries()]
      .toSorted(([leftLine], [rightLine]) => leftLine - rightLine)
      .map(([lineNumber, comments]) => ({
        lineNumber,
        metadata: {
          comments,
          draft: draftLine === lineNumber,
        },
      }));
  }, [draftLine, props.comments]);

  return (
    <div className="h-full overflow-auto bg-background">
      <PierreFile
        file={file}
        lineAnnotations={lineAnnotations}
        options={{
          disableFileHeader: true,
          overflow: props.wrapLines ? "wrap" : "scroll",
          enableGutterUtility: true,
          onGutterUtilityClick: (range) => {
            setDraftLine(range.start);
            setDraftText("");
          },
          preferredHighlighter: "shiki-js",
          theme: themeName,
          themeType: props.theme,
          tokenizeMaxLineLength: 1_000,
          unsafeCSS: PIERRE_FILE_VIEWER_UNSAFE_CSS,
        }}
        renderAnnotation={(annotation) => (
          <FileLineAnnotation
            annotation={annotation}
            draftText={draftText}
            onCancelDraft={() => setDraftLine(null)}
            onChangeDraftText={setDraftText}
            onDeleteComment={props.onDeleteComment}
            onSaveComment={(lineNumber) => {
              props.onAddComment(lineNumber, draftText.trim());
              setDraftText("");
              setDraftLine(null);
            }}
            onUpdateComment={props.onUpdateComment}
          />
        )}
      />
    </div>
  );
}

function FileLineAnnotation(props: {
  annotation: LineAnnotation<FileCommentAnnotation> | DiffLineAnnotation<FileCommentAnnotation>;
  draftText: string;
  label?: string | undefined;
  onCancelDraft: () => void;
  onChangeDraftText: (value: string) => void;
  onDeleteComment: (commentId: string) => void;
  onSaveComment: (lineNumber: number) => void;
  onUpdateComment: (commentId: string, text: string) => void;
}) {
  return (
    <div className="px-20 pb-2 pr-4">
      {props.annotation.metadata.comments.map((comment) => (
        <LineCommentCard
          key={comment.id}
          comment={comment}
          onSave={(text) => props.onUpdateComment(comment.id, text)}
          onDelete={() => props.onDeleteComment(comment.id)}
        />
      ))}
      {props.annotation.metadata.draft ? (
        <div className="rounded-md border border-border/60 bg-background/80 p-2">
          <textarea
            className="min-h-20 w-full resize-y bg-transparent text-[12px] text-foreground outline-none"
            placeholder={props.label ?? "Local comment"}
            value={props.draftText}
            onChange={(event) => props.onChangeDraftText(event.target.value)}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={props.onCancelDraft}>
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.draftText.trim().length === 0}
              onClick={() => props.onSaveComment(props.annotation.lineNumber)}
            >
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LineCommentCard(props: {
  comment: FilePanelComment;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.comment.text);

  useEffect(() => {
    setValue(props.comment.text);
  }, [props.comment.text]);

  return (
    <div className="pb-2">
      <div className="rounded-md border border-border/60 bg-background/70 p-2 text-[12px] text-muted-foreground/82">
        {editing ? (
          <>
            <textarea
              className="min-h-20 w-full resize-y bg-transparent text-[12px] text-foreground outline-none"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={value.trim().length === 0}
                onClick={() => {
                  props.onSave(value.trim());
                  setEditing(false);
                }}
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words text-foreground/84">
              {props.comment.text}
            </p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={props.onDelete}>
                Delete
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
