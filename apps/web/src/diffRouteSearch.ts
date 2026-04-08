import { TurnId } from "@t3tools/contracts";

export type RightPanelMode = "diff" | "browser";
export type ResolvedRightPanelMode = RightPanelMode | "none";
export type ChatRightPanel = RightPanelMode;

export interface DiffRouteSearch {
  panel?: RightPanelMode;
  diff?: "1";
  diffTurnId?: TurnId;
  diffFilePath?: string;
  splitViewId?: string;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePanelMode(value: unknown): RightPanelMode | undefined {
  const normalized = normalizeSearchString(value);
  if (normalized === "diff" || normalized === "browser") {
    return normalized;
  }
  return undefined;
}

export function resolveRightPanelMode(search: Pick<DiffRouteSearch, "panel" | "diff">): ResolvedRightPanelMode {
  if (search.panel === "browser") {
    return "browser";
  }
  if (search.panel === "diff" || search.diff === "1") {
    return "diff";
  }
  return "none";
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "panel" | "diff" | "diffTurnId" | "diffFilePath" | "splitViewId"> {
  const {
    panel: _panel,
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    splitViewId: _splitViewId,
    ...rest
  } = params;
  return rest as Omit<T, "panel" | "diff" | "diffTurnId" | "diffFilePath" | "splitViewId">;
}

export const stripRightPanelSearchParams = stripDiffSearchParams;

export function withRightPanelMode<T extends Record<string, unknown>>(
  params: T,
  mode: ResolvedRightPanelMode,
): Record<string, unknown> {
  const rest = stripDiffSearchParams(params);
  if (mode === "diff") {
    return { ...rest, panel: "diff", diff: "1" };
  }
  if (mode === "browser") {
    return { ...rest, panel: "browser" };
  }
  return rest;
}

export function withDiffSelection<T extends Record<string, unknown>>(
  params: T,
  input: { turnId?: TurnId; filePath?: string },
): Record<string, unknown> {
  const base = withRightPanelMode(params, "diff");
  if (!input.turnId) {
    return base;
  }
  return input.filePath
    ? { ...base, diffTurnId: input.turnId, diffFilePath: input.filePath }
    : { ...base, diffTurnId: input.turnId };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const panel = normalizePanelMode(search.panel);
  const legacyDiffOpen = isDiffOpenValue(search.diff);
  const resolvedMode: RightPanelMode | undefined = panel ?? (legacyDiffOpen ? "diff" : undefined);
  const diff = resolvedMode === "diff" ? "1" : undefined;
  const diffTurnIdRaw = resolvedMode === "diff" ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath =
    resolvedMode === "diff" && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const splitViewId = normalizeSearchString(search.splitViewId);

  return {
    ...(resolvedMode ? { panel: resolvedMode } : {}),
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(splitViewId ? { splitViewId } : {}),
  };
}
