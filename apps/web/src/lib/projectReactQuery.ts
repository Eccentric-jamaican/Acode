import type {
  ProjectListDirectoryResult,
  ProjectListTreeResult,
  ProjectFileMetadataResult,
  ProjectReadFileResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const PROJECT_READ_FILE_PREVIEW_VERSION = "document-preview-v2";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  listDirectory: (cwd: string | null, relativePath: string | null) =>
    ["projects", "list-directory", cwd, relativePath] as const,
  listTree: (cwd: string | null) => ["projects", "list-tree", cwd] as const,
  fileMetadata: (cwd: string | null, relativePath: string | null) =>
    ["projects", "file-metadata", cwd, relativePath] as const,
  readFile: (cwd: string | null, relativePath: string | null) =>
    ["projects", "read-file", PROJECT_READ_FILE_PREVIEW_VERSION, cwd, relativePath] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_LIST_DIRECTORY_RESULT: ProjectListDirectoryResult = {
  relativePath: null,
  entries: [],
};
const EMPTY_LIST_TREE_RESULT: ProjectListTreeResult = {
  entries: [],
  truncated: false,
};
const EMPTY_READ_FILE_RESULT: ProjectReadFileResult = {
  relativePath: "",
  status: "missing",
  message: "File unavailable.",
};
const EMPTY_FILE_METADATA_RESULT: ProjectFileMetadataResult = {
  relativePath: "",
  status: "missing",
  message: "File unavailable.",
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectListDirectoryQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listDirectory(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace directory listing is unavailable.");
      }
      return api.projects.listDirectory({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_LIST_DIRECTORY_RESULT,
  });
}

export function projectListTreeQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listTree(input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace tree is unavailable.");
      }
      return api.projects.listTree({
        cwd: input.cwd,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_LIST_TREE_RESULT,
  });
}

export function projectReadFileQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.relativePath) {
        throw new Error("Workspace file viewer is unavailable.");
      }
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.relativePath !== null,
    ...(input.refetchInterval !== undefined ? { refetchInterval: input.refetchInterval } : {}),
    ...(input.refetchIntervalInBackground !== undefined
      ? { refetchIntervalInBackground: input.refetchIntervalInBackground }
      : {}),
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_READ_FILE_RESULT,
  });
}

export function projectFileMetadataQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.fileMetadata(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.relativePath) {
        throw new Error("Workspace file metadata is unavailable.");
      }
      return api.projects.fileMetadata({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.relativePath !== null,
    ...(input.refetchInterval !== undefined ? { refetchInterval: input.refetchInterval } : {}),
    refetchIntervalInBackground: false,
    staleTime: 0,
    placeholderData: (previous) => previous ?? EMPTY_FILE_METADATA_RESULT,
  });
}
