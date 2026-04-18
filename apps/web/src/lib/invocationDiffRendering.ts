import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

import { buildPatchCacheKey } from "./diffRendering";
import type { InvocationDiffFile } from "../session-logic";

export interface RenderableInvocationDiffFile {
  path: string;
  additions: number;
  deletions: number;
  fileDiff: FileDiffMetadata;
}

const renderableInvocationDiffCache = new Map<string, RenderableInvocationDiffFile | null>();

function normalizeFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function parseFromPatch(
  file: InvocationDiffFile,
  cacheScope: string,
): FileDiffMetadata | null {
  if (!file.patch) return null;
  const parsed = parsePatchFiles(file.patch, buildPatchCacheKey(file.patch, cacheScope));
  const matched = parsed
    .flatMap((patch) => patch.files)
    .find((candidate) => normalizeFileDiffPath(candidate) === file.path);
  return matched ?? parsed.flatMap((patch) => patch.files)[0] ?? null;
}

function parseFromText(file: InvocationDiffFile): FileDiffMetadata | null {
  if (file.before === undefined && file.after === undefined) return null;
  return parseDiffFromFile(
    { name: file.path, contents: file.before ?? "" },
    { name: file.path, contents: file.after ?? "" },
  );
}

function buildInvocationDiffFileCacheKey(
  file: InvocationDiffFile,
  cacheScope: string,
): string {
  return `${cacheScope}:${file.path}:${file.additions}:${file.deletions}:${file.status ?? ""}:${file.patch ?? ""}:${file.before ?? ""}:${file.after ?? ""}`;
}

export function toRenderableInvocationDiffFile(
  file: InvocationDiffFile,
  cacheScope = "invocation-diff",
): RenderableInvocationDiffFile | null {
  const cacheKey = buildInvocationDiffFileCacheKey(file, cacheScope);
  const cached = renderableInvocationDiffCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const fileDiff = parseFromPatch(file, cacheScope) ?? parseFromText(file);
  if (!fileDiff) {
    renderableInvocationDiffCache.set(cacheKey, null);
    return null;
  }

  const renderable: RenderableInvocationDiffFile = {
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    fileDiff,
  };
  renderableInvocationDiffCache.set(cacheKey, renderable);
  return renderable;
}

export function toRenderableInvocationDiffFiles(
  files: ReadonlyArray<InvocationDiffFile>,
  cacheScope = "invocation-diff",
): RenderableInvocationDiffFile[] {
  return files
    .map((file) => toRenderableInvocationDiffFile(file, cacheScope))
    .filter((entry): entry is RenderableInvocationDiffFile => entry !== null);
}
