import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  EllipsisIcon,
  MessageSquareIcon,
  XIcon,
  ChevronRightIcon,
  FileIcon,
} from "lucide-react";
import { Suspense, use, useEffect, useMemo, useState } from "react";

import { parseDiffRouteSearch } from "../diffRouteSearch";
import { isElectronRuntime } from "../env";
import { useFilePanelStore, getFilePanelThreadState, type FilePanelComment } from "../filePanelStore";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
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

type ResolvedHighlighter = {
  highlighter: DiffsHighlighter;
  language: string;
};

const fileViewerHighlighterPromiseCache = new Map<string, Promise<ResolvedHighlighter>>();

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

function getFileViewerHighlighterPromise(language: string): Promise<ResolvedHighlighter> {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  const cached = fileViewerHighlighterPromiseCache.get(normalizedLanguage);
  if (cached) {
    return cached;
  }

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [normalizedLanguage as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  })
    .then((highlighter) => ({ highlighter, language: normalizedLanguage }))
    .catch(async () => {
      const fallbackLanguage = "text";
      const fallbackHighlighter = await getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [fallbackLanguage as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      });
      return { highlighter: fallbackHighlighter, language: fallbackLanguage };
    });

  fileViewerHighlighterPromiseCache.set(normalizedLanguage, promise);
  return promise;
}

function extractHighlightedLines(html: string): string[] {
  if (typeof DOMParser === "undefined") {
    return html.split("\n");
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  const lineNodes = Array.from(document.querySelectorAll(".line"));
  if (lineNodes.length === 0) {
    return [html];
  }

  return lineNodes.map((lineNode) => lineNode.innerHTML);
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
    activeFilePath && !filePanelState.noWrapCodeFiles.includes(activeFilePath),
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

  const headerRowClassName = cn(
    "desktop-top-edge-actions-safe flex min-w-0 items-center gap-2 px-4",
    usesDesktopAppChrome && mode !== "sheet" ? "h-[var(--app-desktop-content-header-height)]" : "h-12",
  );

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      <div className="shrink-0 border-b border-border">
        <div
          className={headerRowClassName}
          data-testid={usesDesktopAppChrome && mode !== "sheet" ? "diff-panel-top-header" : undefined}
        >
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max items-center gap-1 py-2">
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
        <div className="desktop-top-edge-actions-safe flex h-9 items-center justify-between gap-3 border-t border-border/60 px-4 text-[12px] text-muted-foreground/70">
          {activeFilePath ? (
            <div className="min-w-0 truncate" data-testid="viewer-breadcrumbs">
              {breadcrumbs.map((segment, index) => (
                <span key={breadcrumbs.slice(0, index + 1).join("/")}>
                  {index > 0 ? <ChevronRightIcon className="mx-1 inline size-3 opacity-60" /> : null}
                  <span>{segment}</span>
                </span>
              ))}
            </div>
          ) : (
            <span className="truncate">Viewer</span>
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
              onOpenInEditor={() => {
                if (!activeCwd || !activeFilePath) {
                  return;
                }
                const api = readNativeApi();
                if (!api) {
                  return;
                }
                const targetPath = resolvePathLinkTarget(activeFilePath, activeCwd);
                void api.shell.openInEditor(targetPath, preferredTerminalEditor());
              }}
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
                onOpenInEditor={() => {
                  if (!activeCwd || !activeFilePath) {
                    return;
                  }
                  const api = readNativeApi();
                  if (!api) {
                    return;
                  }
                  const targetPath = resolvePathLinkTarget(activeFilePath, activeCwd);
                  void api.shell.openInEditor(targetPath, preferredTerminalEditor());
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
        "inline-flex h-8 items-center rounded-md border px-2.5 text-[12px] font-medium transition-colors",
        props.active
          ? "border-border bg-accent/55 text-foreground"
          : "border-transparent bg-transparent text-muted-foreground/72 hover:bg-accent/30 hover:text-foreground",
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
        "inline-flex h-8 max-w-52 items-center gap-1 rounded-md border px-2 text-[12px] transition-colors",
        props.active
          ? "border-border bg-accent/55 text-foreground"
          : "border-transparent bg-transparent text-muted-foreground/72 hover:bg-accent/30 hover:text-foreground",
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
  onOpenInEditor: () => void;
}) {
  return (
    <div className="h-full overflow-auto bg-background/80">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground/70">
        <span className="truncate">{props.filePath}</span>
        <Button type="button" size="xs" variant="outline" onClick={props.onOpenInEditor}>
          Open
        </Button>
      </div>
      <div className="px-6 py-6">
        <ChatMarkdown text={props.contents} cwd={props.cwd ?? undefined} />
      </div>
    </div>
  );
}

function ReadOnlyFileViewer(props: {
  filePath: string;
  contents: string;
  comments: readonly FilePanelComment[];
  theme: "light" | "dark";
  wrapLines: boolean;
  onAddComment: (line: number, text: string) => void;
  onUpdateComment: (commentId: string, text: string) => void;
  onDeleteComment: (commentId: string) => void;
  onOpenInEditor: () => void;
}) {
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draftText, setDraftText] = useState("");
  const lines = useMemo(() => props.contents.split(/\r?\n/), [props.contents]);
  const themeName = resolveDiffThemeName(props.theme);
  const requestedLanguage = inferFileViewerLanguage(props.filePath);
  const { highlighter, language } = use(getFileViewerHighlighterPromise(requestedLanguage));
  const highlightedHtml = useMemo(
    () => highlighter.codeToHtml(props.contents, { lang: language, theme: themeName }),
    [highlighter, language, props.contents, themeName],
  );
  const highlightedLines = useMemo(() => extractHighlightedLines(highlightedHtml), [highlightedHtml]);

  return (
    <div className="h-full overflow-auto bg-background/80">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground/70">
        <span className="truncate">{props.filePath}</span>
        <Button type="button" size="xs" variant="outline" onClick={props.onOpenInEditor}>
          Open
        </Button>
      </div>
      <div className="font-mono text-[12px] leading-5.5">
        {lines.map((lineText, index) => {
          const lineNumber = index + 1;
          const lineComments = props.comments.filter((comment) => comment.line === lineNumber);
          return (
            <div key={`${lineNumber}:${lineText}`}>
              <div className="group flex items-start gap-3 px-4 py-[1px] hover:bg-accent/10">
                <div className="flex w-16 shrink-0 items-center gap-1 pt-[1px] text-right text-[11px] text-muted-foreground/50">
                  <button
                    type="button"
                    className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                    onClick={() => {
                      setDraftLine(lineNumber);
                      setDraftText("");
                    }}
                    aria-label={`Comment on line ${lineNumber}`}
                  >
                    <MessageSquareIcon className="size-3" />
                  </button>
                  <span className={cn("tabular-nums", lineComments.length > 0 ? "text-foreground/75" : "")}>{lineNumber}</span>
                </div>
                <div
                  className={cn(
                    "file-viewer-shiki min-w-0 flex-1 py-0 font-mono text-[12px] leading-5.5",
                    props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto",
                    props.theme === "dark" ? "text-foreground/88" : "text-foreground/84",
                  )}
                  dangerouslySetInnerHTML={{
                    __html:
                      highlightedLines[index] && highlightedLines[index].length > 0
                        ? highlightedLines[index]
                        : lineText.length > 0
                          ? lineText
                          : "&nbsp;",
                  }}
                />
              </div>
              {lineComments.map((comment) => (
                <LineCommentCard
                  key={comment.id}
                  comment={comment}
                  onSave={(text) => props.onUpdateComment(comment.id, text)}
                  onDelete={() => props.onDeleteComment(comment.id)}
                />
              ))}
              {draftLine === lineNumber ? (
                <div className="px-20 pb-3 pr-4">
                  <div className="rounded-md border border-border/60 bg-background/80 p-2">
                    <textarea
                      className="min-h-20 w-full resize-y bg-transparent text-[12px] text-foreground outline-none"
                      placeholder="Local comment"
                      value={draftText}
                      onChange={(event) => setDraftText(event.target.value)}
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <Button type="button" size="xs" variant="ghost" onClick={() => setDraftLine(null)}>
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={draftText.trim().length === 0}
                        onClick={() => {
                          props.onAddComment(lineNumber, draftText.trim());
                          setDraftText("");
                          setDraftLine(null);
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
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
    <div className="px-20 pb-2 pr-4">
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
