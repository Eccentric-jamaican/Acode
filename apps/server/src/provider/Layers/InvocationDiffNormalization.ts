export interface InvocationDiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: "added" | "deleted" | "modified";
  readonly patch?: string;
  readonly before?: string;
  readonly after?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatus(value: unknown): InvocationDiffFile["status"] | undefined {
  const normalized = asString(value)?.toLowerCase();
  if (normalized === "added" || normalized === "deleted" || normalized === "modified") {
    return normalized;
  }
  return undefined;
}

function toInvocationDiffFile(value: unknown): InvocationDiffFile | null {
  const record = asRecord(value);
  if (!record) return null;

  const path =
    asString(record.path) ??
    asString(record.file) ??
    asString(record.filePath) ??
    asString(record.relativePath) ??
    asString(record.newPath);
  if (!path) return null;

  const patch = asString(record.patch) ?? asString(record.diff) ?? undefined;
  const before = asString(record.before) ?? undefined;
  const after = asString(record.after) ?? undefined;
  const status = normalizeStatus(record.status);
  const additions = asNumber(record.additions);
  const deletions = asNumber(record.deletions);
  const hasStats = additions !== null || deletions !== null;
  const hasRenderableDiff = Boolean(patch || before !== undefined || after !== undefined);

  if (!hasStats && !hasRenderableDiff) {
    return null;
  }

  return {
    path,
    additions: additions ?? 0,
    deletions: deletions ?? 0,
    ...(status ? { status } : {}),
    ...(patch ? { patch } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

function collectFileCandidates(value: unknown): unknown[] {
  const record = asRecord(value);
  if (!record) return [];
  const candidates: unknown[] = [];
  const filediff = asRecord(record.filediff);
  if (filediff) {
    candidates.push(filediff);
  }
  const diffRecord = asRecord(record.diff);
  if (diffRecord && Array.isArray(diffRecord.files)) {
    candidates.push(...diffRecord.files);
  }
  if (Array.isArray(record.files)) {
    candidates.push(...record.files);
  }
  return candidates;
}

export function normalizeInvocationDiffFiles(value: unknown): InvocationDiffFile[] {
  const root = asRecord(value);
  if (!root) return [];

  const files: InvocationDiffFile[] = [];
  const seen = new Set<string>();
  const sources: unknown[] = [root, asRecord(root.metadata), asRecord(root.data), asRecord(root.args)].filter(
    (entry): entry is Record<string, unknown> => entry !== null,
  );

  for (const source of sources) {
    for (const candidate of collectFileCandidates(source)) {
      const file = toInvocationDiffFile(candidate);
      if (!file) continue;
      const key = `${file.path}:${file.additions}:${file.deletions}:${file.patch ?? ""}:${file.before ?? ""}:${file.after ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
  }

  return files;
}
