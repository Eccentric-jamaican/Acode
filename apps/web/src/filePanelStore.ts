import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface FilePanelComment {
  id: string;
  line: number;
  side?: "additions" | "deletions" | undefined;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface FilePanelThreadState {
  openFiles: string[];
  activeTab: { kind: "review" } | { kind: "file"; path: string };
  expandedDirectories: string[];
  plainViewMarkdownFiles: string[];
  noWrapCodeFiles: string[];
  commentsByFilePath: Record<string, FilePanelComment[]>;
}

interface FilePanelStore {
  byThreadId: Record<string, FilePanelThreadState | undefined>;
  openFile: (threadId: ThreadId, path: string) => void;
  closeFile: (threadId: ThreadId, path: string) => void;
  selectReview: (threadId: ThreadId) => void;
  toggleDirectory: (threadId: ThreadId, path: string) => void;
  toggleMarkdownRichView: (threadId: ThreadId, filePath: string) => void;
  toggleCodeWordWrap: (threadId: ThreadId, filePath: string) => void;
  addComment: (
    threadId: ThreadId,
    filePath: string,
    line: number,
    text: string,
    side?: FilePanelComment["side"],
  ) => void;
  updateComment: (threadId: ThreadId, filePath: string, commentId: string, text: string) => void;
  deleteComment: (threadId: ThreadId, filePath: string, commentId: string) => void;
  clearComments: (threadId: ThreadId) => void;
}

const FILE_PANEL_STORAGE_KEY = "t3code:file-panel-state:v2";
const DEFAULT_FILE_PANEL_THREAD_STATE: FilePanelThreadState = {
  openFiles: [],
  activeTab: { kind: "review" },
  expandedDirectories: [],
  plainViewMarkdownFiles: [],
  noWrapCodeFiles: [],
  commentsByFilePath: {},
};

function createDefaultThreadState(): FilePanelThreadState {
  return {
    openFiles: [],
    activeTab: { kind: "review" },
    expandedDirectories: [],
    plainViewMarkdownFiles: [],
    noWrapCodeFiles: [],
    commentsByFilePath: {},
  };
}

function normalizeFilePanelThreadState(
  threadState: Partial<FilePanelThreadState> | undefined,
): FilePanelThreadState {
  if (!threadState) {
    return createDefaultThreadState();
  }

  return {
    openFiles: Array.isArray(threadState.openFiles) ? threadState.openFiles : [],
    activeTab:
      threadState.activeTab?.kind === "file" && typeof threadState.activeTab.path === "string"
        ? { kind: "file", path: threadState.activeTab.path }
        : { kind: "review" },
    expandedDirectories: Array.isArray(threadState.expandedDirectories)
      ? threadState.expandedDirectories
      : [],
    plainViewMarkdownFiles: Array.isArray(threadState.plainViewMarkdownFiles)
      ? threadState.plainViewMarkdownFiles
      : [],
    noWrapCodeFiles: Array.isArray(threadState.noWrapCodeFiles)
      ? threadState.noWrapCodeFiles
      : [],
    commentsByFilePath:
      threadState.commentsByFilePath && typeof threadState.commentsByFilePath === "object"
        ? threadState.commentsByFilePath
        : {},
  };
}

function nextThreadState(
  state: FilePanelStore["byThreadId"],
  threadId: ThreadId,
  updater: (threadState: FilePanelThreadState) => FilePanelThreadState,
): Record<string, FilePanelThreadState | undefined> {
  const previous = normalizeFilePanelThreadState(state[threadId]);
  const next = updater(previous);
  if (next === previous) {
    return state;
  }
  return {
    ...state,
    [threadId]: next,
  };
}

export function getFilePanelThreadState(
  storeState: Pick<FilePanelStore, "byThreadId">,
  threadId: ThreadId | null,
): FilePanelThreadState {
  if (!threadId) {
    return DEFAULT_FILE_PANEL_THREAD_STATE;
  }
  return storeState.byThreadId[threadId] ?? DEFAULT_FILE_PANEL_THREAD_STATE;
}

export const useFilePanelStore = create<FilePanelStore>()(
  persist(
    (set) => ({
      byThreadId: {},
      openFile: (threadId, path) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            if (
              threadState.activeTab.kind === "file" &&
              threadState.activeTab.path === path &&
              threadState.openFiles.includes(path)
            ) {
              return threadState;
            }
            const openFiles = threadState.openFiles.includes(path)
              ? threadState.openFiles
              : [...threadState.openFiles, path];
            return {
              ...threadState,
              openFiles,
              activeTab: { kind: "file", path },
            };
          }),
        })),
      closeFile: (threadId, path) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            if (!threadState.openFiles.includes(path)) {
              return threadState;
            }
            const openFiles = threadState.openFiles.filter((entry) => entry !== path);
            const activeTab =
              threadState.activeTab.kind === "file" && threadState.activeTab.path === path
                ? openFiles[0]
                  ? { kind: "file" as const, path: openFiles[0] }
                  : { kind: "review" as const }
                : threadState.activeTab;
            return {
              ...threadState,
              openFiles,
              activeTab,
            };
          }),
        })),
      selectReview: (threadId) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) =>
            threadState.activeTab.kind === "review"
              ? threadState
              : {
                  ...threadState,
                  activeTab: { kind: "review" },
                },
          ),
        })),
      toggleDirectory: (threadId, path) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const expandedDirectories = threadState.expandedDirectories.includes(path)
              ? threadState.expandedDirectories.filter((entry) => entry !== path)
              : [...threadState.expandedDirectories, path];
            return {
              ...threadState,
              expandedDirectories,
            };
          }),
        })),
      toggleMarkdownRichView: (threadId, filePath) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const plainViewMarkdownFiles = threadState.plainViewMarkdownFiles.includes(filePath)
              ? threadState.plainViewMarkdownFiles.filter((entry) => entry !== filePath)
              : [...threadState.plainViewMarkdownFiles, filePath];
            return {
              ...threadState,
              plainViewMarkdownFiles,
            };
          }),
        })),
      toggleCodeWordWrap: (threadId, filePath) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const noWrapCodeFiles = threadState.noWrapCodeFiles.includes(filePath)
              ? threadState.noWrapCodeFiles.filter((entry) => entry !== filePath)
              : [...threadState.noWrapCodeFiles, filePath];
            return {
              ...threadState,
              noWrapCodeFiles,
            };
          }),
        })),
      addComment: (threadId, filePath, line, text, side) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const now = new Date().toISOString();
            const existing = threadState.commentsByFilePath[filePath] ?? [];
            return {
              ...threadState,
              commentsByFilePath: {
                ...threadState.commentsByFilePath,
                [filePath]: [
                  ...existing,
                  {
                    id: crypto.randomUUID(),
                    line,
                    ...(side ? { side } : {}),
                    text,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              },
            };
          }),
        })),
      updateComment: (threadId, filePath, commentId, text) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const existingComments = threadState.commentsByFilePath[filePath] ?? [];
            const existingComment = existingComments.find((comment) => comment.id === commentId);
            if (!existingComment || existingComment.text === text) {
              return threadState;
            }
            return {
              ...threadState,
              commentsByFilePath: {
                ...threadState.commentsByFilePath,
                [filePath]: existingComments.map((comment) =>
                  comment.id === commentId
                    ? {
                        ...comment,
                        text,
                        updatedAt: new Date().toISOString(),
                      }
                    : comment,
                ),
              },
            };
          }),
        })),
      deleteComment: (threadId, filePath, commentId) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) => {
            const existingComments = threadState.commentsByFilePath[filePath] ?? [];
            if (!existingComments.some((comment) => comment.id === commentId)) {
              return threadState;
            }
            return {
              ...threadState,
              commentsByFilePath: {
                ...threadState.commentsByFilePath,
                [filePath]: existingComments.filter((comment) => comment.id !== commentId),
              },
            };
          }),
        })),
      clearComments: (threadId) =>
        set((state) => ({
          byThreadId: nextThreadState(state.byThreadId, threadId, (threadState) =>
            Object.keys(threadState.commentsByFilePath).length === 0
              ? threadState
              : {
                  ...threadState,
                  commentsByFilePath: {},
                },
          ),
        })),
    }),
    {
      name: FILE_PANEL_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => {
        const normalizedByThreadId = Object.fromEntries(
          Object.entries((persistedState as Partial<FilePanelStore> | undefined)?.byThreadId ?? {}).map(
            ([threadId, threadState]) => [threadId, normalizeFilePanelThreadState(threadState)],
          ),
        ) as Record<string, FilePanelThreadState | undefined>;

        return {
          ...currentState,
          ...(persistedState as object),
          byThreadId: normalizedByThreadId,
        };
      },
    },
  ),
);
