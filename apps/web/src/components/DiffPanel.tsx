import {
  type FileContents,
  File as PierreFile,
  type LineAnnotation,
  type SupportedLanguages,
} from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  EllipsisIcon,
  MessageSquareIcon,
  XIcon,
  ChevronRightIcon,
  FileIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { parseDiffRouteSearch } from "../diffRouteSearch";
import { isElectronRuntime } from "../env";
import { useFilePanelStore, getFilePanelThreadState, type FilePanelComment } from "../filePanelStore";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import { projectReadFileQueryOptions } from "../lib/projectReactQuery";
import { normalizeSyntaxLanguage } from "../lib/syntaxLanguage";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

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
  const filePanelState = useFilePanelStore((store) => getFilePanelThreadState(store, activeThreadId));
  const openFile = useFilePanelStore((store) => store.openFile);
  const closeFile = useFilePanelStore((store) => store.closeFile);
  const selectSummary = useFilePanelStore((store) => store.selectSummary);
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

  const activeFilePath = filePanelState.activeTab.kind === "file" ? filePanelState.activeTab.path : null;
  const markdownRichViewEnabled = Boolean(
    activeFilePath && !filePanelState.plainViewMarkdownFiles.includes(activeFilePath),
  );
  const codeWordWrapEnabled = Boolean(
    activeFilePath && filePanelState.noWrapCodeFiles.includes(activeFilePath),
  );
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: activeCwd,
      relativePath: activeFilePath,
      enabled: activeCwd !== null && activeFilePath !== null,
    }),
  );

  const breadcrumbs = useMemo(() => {
    if (!activeFilePath) return [] as string[];
    return activeFilePath.split("/").filter((segment) => segment.length > 0);
  }, [activeFilePath]);
  const activeFileName = breadcrumbs.at(-1) ?? null;
  const openActiveFileInEditor = () => {
    if (!activeCwd || !activeFilePath) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const targetPath = resolvePathLinkTarget(activeFilePath, activeCwd);
    void api.shell.openInEditor(targetPath, preferredTerminalEditor());
  };

  const headerRowClassName = cn(
    "desktop-top-edge-actions-safe flex min-w-0 items-end gap-2 border-b border-border/45 bg-muted/18 px-3",
    usesDesktopAppChrome && mode !== "sheet" ? "h-[var(--app-desktop-content-header-height)]" : "h-11",
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
          data-testid={usesDesktopAppChrome && mode !== "sheet" ? "diff-panel-top-header" : undefined}
        >
          <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="flex min-w-max items-end gap-0">
              <ViewerTabButton
                active={filePanelState.activeTab.kind === "summary"}
                onClick={() => {
                  if (activeThreadId) {
                    selectSummary(activeThreadId);
                  }
                }}
              >
                Summary
              </ViewerTabButton>
              {filePanelState.openFiles.map((filePath) => (
                <ViewerFileTab
                  key={filePath}
                  filePath={filePath}
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
        <div className="desktop-top-edge-actions-safe flex h-11 items-center justify-between gap-3 px-4 text-[12px] text-muted-foreground/72">
          {activeFilePath ? (
            <div className="min-w-0" data-testid="viewer-breadcrumbs">
              <div className="truncate text-[13px] font-medium text-foreground/88">
                {activeFileName}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center overflow-hidden whitespace-nowrap text-[11px]">
                {breadcrumbs.slice(0, -1).map((segment, index) => (
                  <span key={breadcrumbs.slice(0, index + 1).join("/")} className="contents">
                    {index > 0 ? <ChevronRightIcon className="mx-0.5 size-3 shrink-0 opacity-45" /> : null}
                    <span className="truncate">{segment}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <span className="truncate text-[13px] font-medium text-foreground/84">Viewer</span>
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
                    <span className="text-muted-foreground">{'↩'}</span>
                    {codeWordWrapEnabled ? "Disable word wrap" : "Enable word wrap"}
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {!activeThread ? (
          <PanelEmptyState message="Select a thread to inspect files." />
        ) : filePanelState.activeTab.kind === "summary" ? (
          <SummarySurface cwd={activeCwd} openFiles={filePanelState.openFiles.length} />
        ) : activeFileQuery.isLoading ? (
          <PanelEmptyState message="Loading file…" />
        ) : activeFileQuery.data?.status !== "text" ? (
          <PanelEmptyState message={activeFileQuery.data?.message ?? "File unavailable."} />
        ) : activeFilePath !== null ? (
          isMarkdownFile(activeFilePath) && markdownRichViewEnabled ? (
            <MarkdownFileViewer
              filePath={activeFilePath}
              contents={activeFileQuery.data.contents}
              cwd={activeCwd}
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
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = props.filePath.split("/").at(-1) ?? props.filePath;
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

function SummarySurface(props: { cwd: string | null; openFiles: number }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="space-y-3 rounded-md border border-border/60 bg-background/60 p-4 text-[12px] text-muted-foreground/78">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/75">Summary</p>
          <p className="mt-1">AI summary placeholder.</p>
        </div>
        <div className="space-y-1">
          <p>Workspace: <span className="text-foreground/82">{props.cwd ?? "Unavailable"}</span></p>
          <p>Open files: <span className="text-foreground/82">{props.openFiles}</span></p>
        </div>
      </div>
    </div>
  );
}

function PanelEmptyState(props: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
      {props.message}
    </div>
  );
}

function MarkdownFileViewer(props: {
  filePath: string;
  contents: string;
  cwd: string | null;
}) {
  return (
    <div className="h-full overflow-auto bg-background">
      <div className="px-6 py-6">
        <ChatMarkdown text={props.contents} cwd={props.cwd ?? undefined} />
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

  [data-column-content] {
    padding-right: 24px;
  }

  [data-line]:hover {
    background: hsl(var(--accent) / 0.08);
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
        renderGutterUtility={(getHoveredLine) => (
          <button
            type="button"
            className="rounded-sm p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            aria-label="Comment on hovered line"
            onClick={() => {
              const hoveredLine = getHoveredLine();
              if (!hoveredLine) {
                return;
              }
              setDraftLine(hoveredLine.lineNumber);
              setDraftText("");
            }}
          >
            <MessageSquareIcon className="size-3" />
          </button>
        )}
      />
    </div>
  );
}

function FileLineAnnotation(props: {
  annotation: LineAnnotation<FileCommentAnnotation>;
  draftText: string;
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
            placeholder="Local comment"
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
            <p className="whitespace-pre-wrap break-words text-foreground/84">{props.comment.text}</p>
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
