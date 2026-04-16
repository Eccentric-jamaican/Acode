import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

import { buildPatchCacheKey } from "./diffRendering";
import type { InvocationDiffFile } from "../session-logic";

export interface RenderableInvocationDiffFile {
  path: string;
  additions: number;
  deletions: number;
  fileDiff: FileDiffMetadata;
}

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

export function toRenderableInvocationDiffFiles(
  files: ReadonlyArray<InvocationDiffFile>,
  cacheScope = "invocation-diff",
): RenderableInvocationDiffFile[] {
  return files
    .map((file) => {
      const fileDiff = parseFromPatch(file, cacheScope) ?? parseFromText(file);
      if (!fileDiff) return null;
      return {
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        fileDiff,
      };
    })
    .filter((entry): entry is RenderableInvocationDiffFile => entry !== null);
}

