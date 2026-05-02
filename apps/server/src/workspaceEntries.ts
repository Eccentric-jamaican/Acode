import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { runProcess } from "./processRunner";

import {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectDirectoryEntry,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectListTreeInput,
  ProjectListTreeResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const PROJECT_READ_FILE_MAX_BYTES = 256 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: ProjectEntry[];
  truncated: boolean;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

export function invalidateWorkspaceIndex(cwd: string): void {
  workspaceIndexCache.delete(cwd);
  inFlightWorkspaceIndexBuilds.delete(cwd);
}

function compareProjectEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function projectEntryForPath(relativePath: string, kind: ProjectEntry["kind"]): ProjectEntry {
  return {
    path: relativePath,
    kind,
    parentPath: parentPathOf(relativePath),
  };
}

function mutateCachedWorkspaceIndex(
  cwd: string,
  updater: (entriesByPath: Map<string, ProjectEntry>) => void,
): void {
  const cached = workspaceIndexCache.get(cwd);
  if (!cached) {
    return;
  }

  const entriesByPath = new Map(cached.entries.map((entry) => [entry.path, entry]));
  updater(entriesByPath);
  const entries = [...entriesByPath.values()].toSorted(compareProjectEntries);

  workspaceIndexCache.set(cwd, {
    scannedAt: Date.now(),
    entries,
    truncated: cached.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  });
}

function ensureDirectoryAncestors(
  entriesByPath: Map<string, ProjectEntry>,
  relativePath: string,
): void {
  for (const directoryPath of directoryAncestorsOf(relativePath)) {
    if (!entriesByPath.has(directoryPath)) {
      entriesByPath.set(directoryPath, projectEntryForPath(directoryPath, "directory"));
    }
  }
}

export function recordWorkspaceFileWrite(cwd: string, relativePath: string): void {
  mutateCachedWorkspaceIndex(cwd, (entriesByPath) => {
    ensureDirectoryAncestors(entriesByPath, relativePath);
    entriesByPath.set(relativePath, projectEntryForPath(relativePath, "file"));
  });
}

function recordWorkspaceDirectoryCreate(cwd: string, relativePath: string): void {
  mutateCachedWorkspaceIndex(cwd, (entriesByPath) => {
    ensureDirectoryAncestors(entriesByPath, relativePath);
    entriesByPath.set(relativePath, projectEntryForPath(relativePath, "directory"));
  });
}

function recordWorkspaceEntryRename(input: {
  cwd: string;
  fromRelativePath: string;
  kind: ProjectEntry["kind"];
  toRelativePath: string;
}): void {
  mutateCachedWorkspaceIndex(input.cwd, (entriesByPath) => {
    const movedEntries: ProjectEntry[] = [];
    for (const entry of entriesByPath.values()) {
      if (
        entry.path === input.fromRelativePath ||
        entry.path.startsWith(`${input.fromRelativePath}/`)
      ) {
        movedEntries.push(entry);
      }
    }

    if (movedEntries.length === 0) {
      ensureDirectoryAncestors(entriesByPath, input.toRelativePath);
      entriesByPath.set(input.toRelativePath, projectEntryForPath(input.toRelativePath, input.kind));
      return;
    }

    for (const entry of movedEntries) {
      entriesByPath.delete(entry.path);
    }
    ensureDirectoryAncestors(entriesByPath, input.toRelativePath);

    for (const entry of movedEntries) {
      const suffix =
        entry.path === input.fromRelativePath
          ? ""
          : entry.path.slice(input.fromRelativePath.length);
      const nextPath = `${input.toRelativePath}${suffix}`;
      entriesByPath.set(nextPath, projectEntryForPath(nextPath, entry.kind));
    }
  });
}

function recordWorkspaceEntryDelete(cwd: string, relativePath: string): void {
  mutateCachedWorkspaceIndex(cwd, (entriesByPath) => {
    for (const entryPath of entriesByPath.keys()) {
      if (entryPath === relativePath || entryPath.startsWith(`${relativePath}/`)) {
        entriesByPath.delete(entryPath);
      }
    }
  });
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function resolveWorkspaceTargetPath(input: {
  cwd: string;
  relativePath: string | null;
}): { absolutePath: string; relativePath: string | null } {
  const normalizedRelativePath = input.relativePath?.trim() ?? null;
  if (!normalizedRelativePath) {
    return {
      absolutePath: input.cwd,
      relativePath: null,
    };
  }

  if (path.isAbsolute(normalizedRelativePath)) {
    throw new Error("Workspace path must be relative to the project root.");
  }

  const absolutePath = path.resolve(input.cwd, normalizedRelativePath);
  const relativeToRoot = toPosixPath(path.relative(input.cwd, absolutePath));
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Workspace path must stay within the project root.");
  }

  return {
    absolutePath,
    relativePath: relativeToRoot,
  };
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

function scoreEntry(entry: ProjectEntry, query: string): number {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const normalizedPath = entry.path.toLowerCase();
  const normalizedName = basenameOf(normalizedPath);

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  return 5;
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  // If output was truncated, the final token can be partial.
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const insideWorkTree = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    maxBufferBytes: 4_096,
  }).catch(() => null);
  return Boolean(
    insideWorkTree && insideWorkTree.code === 0 && insideWorkTree.stdout.trim() === "true",
  );
}

async function filterGitIgnoredPaths(cwd: string, relativePaths: string[]): Promise<string[]> {
  if (relativePaths.length === 0) {
    return relativePaths;
  }

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) {
      return true;
    }

    const checkIgnore = await runProcess("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
      stdin: `${chunk.join("\0")}\0`,
    }).catch(() => null);
    chunk = [];
    chunkBytes = 0;

    if (!checkIgnore) {
      return false;
    }

    // git-check-ignore exits with 1 when no paths match.
    if (checkIgnore.code !== 0 && checkIgnore.code !== 1) {
      return false;
    }

    const matchedIgnoredPaths = splitNullSeparatedPaths(
      checkIgnore.stdout,
      Boolean(checkIgnore.stdoutTruncated),
    );
    for (const ignoredPath of matchedIgnoredPaths) {
      ignoredPaths.add(ignoredPath);
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return relativePaths;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return relativePaths;
    }
  }

  if (!(await flushChunk())) {
    return relativePaths;
  }

  if (ignoredPaths.size === 0) {
    return relativePaths;
  }

  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}

async function buildWorkspaceIndexFromGit(cwd: string): Promise<WorkspaceIndex | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }

  const listedFiles = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!listedFiles || listedFiles.code !== 0) {
    return null;
  }

  const listedPaths = splitNullSeparatedPaths(
    listedFiles.stdout,
    Boolean(listedFiles.stdoutTruncated),
  )
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
  const filePaths = await filterGitIgnoredPaths(cwd, listedPaths);

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInIgnoredDirectory(directoryPath)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries: ProjectEntry[] = [...directorySet]
    .toSorted((left, right) => left.localeCompare(right))
    .map((directoryPath) => ({
      path: directoryPath,
      kind: "directory",
      parentPath: parentPathOf(directoryPath),
    }));
  const fileEntries: ProjectEntry[] = [...new Set(filePaths)]
    .toSorted((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      path: filePath,
      kind: "file",
      parentPath: parentPathOf(filePath),
    }));

  const entries = [...directoryEntries, ...fileEntries];
  return {
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated: Boolean(listedFiles.stdoutTruncated) || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  };
}

async function buildWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(cwd);
  if (gitIndexed) {
    return gitIndexed;
  }
  const shouldFilterWithGitIgnore = await isInsideGitWorkTree(cwd);

  let pendingDirectories: string[] = [""];
  const entries: ProjectEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        if (isPathInIgnoredDirectory(relativePath)) {
          continue;
        }
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
      candidateEntries.map((entry) => entry.relativePath),
    );
    const allowedPathSet = shouldFilterWithGitIgnore
      ? new Set(await filterGitIgnoredPaths(cwd, candidatePaths))
      : null;

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
          continue;
        }

        const entry: ProjectEntry = {
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(candidate.relativePath),
        };
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
        }

        if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    scannedAt: Date.now(),
    entries,
    truncated,
  };
}

async function getWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (cached && Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = inFlightWorkspaceIndexBuilds.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = buildWorkspaceIndex(cwd)
    .then((next) => {
      workspaceIndexCache.set(cwd, next);
      while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
        const oldestKey = workspaceIndexCache.keys().next().value;
        if (!oldestKey) break;
        workspaceIndexCache.delete(oldestKey);
      }
      return next;
    })
    .finally(() => {
      inFlightWorkspaceIndexBuilds.delete(cwd);
    });
  inFlightWorkspaceIndexBuilds.set(cwd, nextPromise);
  return nextPromise;
}

export async function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const index = await getWorkspaceIndex(input.cwd);
  const normalizedQuery = normalizeQuery(input.query);
  const candidates = normalizedQuery
    ? index.entries.filter((entry) => entry.path.toLowerCase().includes(normalizedQuery))
    : index.entries;

  const ranked = candidates.toSorted((left, right) => {
    const scoreDelta = scoreEntry(left, normalizedQuery) - scoreEntry(right, normalizedQuery);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });

  return {
    entries: ranked.slice(0, input.limit),
    truncated: index.truncated || ranked.length > input.limit,
  };
}

export async function listWorkspaceDirectory(
  input: ProjectListDirectoryInput,
): Promise<ProjectListDirectoryResult> {
  const target = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.relativePath,
  });
  const directoryEntries = await fs.readdir(target.absolutePath, { withFileTypes: true });
  const candidateRelativePaths = directoryEntries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) =>
      toPosixPath(
        target.relativePath === null ? entry.name : path.join(target.relativePath, entry.name),
      ),
    )
    .filter((relativePath) => !isPathInIgnoredDirectory(relativePath));
  const allowedRelativePaths = new Set(await filterGitIgnoredPaths(input.cwd, candidateRelativePaths));

  const entries: ProjectDirectoryEntry[] = directoryEntries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const relativePath = toPosixPath(
        target.relativePath === null ? entry.name : path.join(target.relativePath, entry.name),
      );
      return {
        entry,
        relativePath,
      };
    })
    .filter((candidate) => allowedRelativePaths.has(candidate.relativePath))
    .map(({ entry, relativePath }) => ({
      path: relativePath,
      name: entry.name,
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      ...(parentPathOf(relativePath) ? { parentPath: parentPathOf(relativePath) } : {}),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.path.localeCompare(right.path, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  return {
    relativePath: target.relativePath,
    entries,
  };
}

export async function listWorkspaceTree(input: ProjectListTreeInput): Promise<ProjectListTreeResult> {
  const index = await getWorkspaceIndex(input.cwd);
  return {
    entries: index.entries,
    truncated: index.truncated,
  };
}

export async function readWorkspaceFile(
  input: ProjectReadFileInput,
): Promise<ProjectReadFileResult> {
  const target = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.relativePath,
  });
  if (target.relativePath === null) {
    return {
      relativePath: input.relativePath,
      status: "unreadable",
      message: "Cannot open the workspace root as a file.",
    };
  }

  let stats;
  try {
    stats = await fs.stat(target.absolutePath);
  } catch {
    return {
      relativePath: target.relativePath,
      status: "missing",
      message: "File not found.",
    };
  }

  if (!stats.isFile()) {
    return {
      relativePath: target.relativePath,
      status: "unreadable",
      message: "Only files can be opened in the viewer.",
    };
  }

  if (stats.size > PROJECT_READ_FILE_MAX_BYTES) {
    return {
      relativePath: target.relativePath,
      status: "too-large",
      message: "File is too large to display in the viewer.",
    };
  }

  const bytes = await fs.readFile(target.absolutePath);
  if (bytes.includes(0)) {
    return {
      relativePath: target.relativePath,
      status: "binary",
      message: "Binary files are not supported in the viewer yet.",
    };
  }

  return {
    relativePath: target.relativePath,
    status: "text",
    contents: bytes.toString("utf8"),
  };
}

export async function createWorkspaceDirectory(
  input: ProjectCreateDirectoryInput,
): Promise<ProjectCreateDirectoryResult> {
  const target = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.relativePath,
  });
  if (target.relativePath === null) {
    throw new Error("Cannot create the workspace root.");
  }

  await fs.mkdir(target.absolutePath, { recursive: true });
  recordWorkspaceDirectoryCreate(input.cwd, target.relativePath);

  return {
    relativePath: target.relativePath,
  };
}

export async function renameWorkspaceEntry(
  input: ProjectRenameEntryInput,
): Promise<ProjectRenameEntryResult> {
  const fromTarget = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.fromRelativePath,
  });
  const toTarget = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.toRelativePath,
  });
  if (fromTarget.relativePath === null || toTarget.relativePath === null) {
    throw new Error("Cannot rename the workspace root.");
  }

  const fromStats = await fs.stat(fromTarget.absolutePath);
  const fromKind = fromStats.isDirectory() ? "directory" : "file";

  await fs.mkdir(path.dirname(toTarget.absolutePath), { recursive: true });
  await fs.rename(fromTarget.absolutePath, toTarget.absolutePath);
  recordWorkspaceEntryRename({
    cwd: input.cwd,
    fromRelativePath: fromTarget.relativePath,
    kind: fromKind,
    toRelativePath: toTarget.relativePath,
  });

  return {
    fromRelativePath: fromTarget.relativePath,
    toRelativePath: toTarget.relativePath,
  };
}

export async function deleteWorkspaceEntry(
  input: ProjectDeleteEntryInput,
): Promise<ProjectDeleteEntryResult> {
  const target = resolveWorkspaceTargetPath({
    cwd: input.cwd,
    relativePath: input.relativePath,
  });
  if (target.relativePath === null) {
    throw new Error("Cannot delete the workspace root.");
  }

  await fs.rm(target.absolutePath, { recursive: true, force: false });
  recordWorkspaceEntryDelete(input.cwd, target.relativePath);

  return {
    relativePath: target.relativePath,
  };
}
