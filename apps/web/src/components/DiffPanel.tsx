import { parsePatchFiles, setLanguageOverride, type SupportedLanguages } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import {
  AlignLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FileDiffIcon,
  GitForkIcon,
  Rows3Icon,
} from "lucide-react";
import { type WheelEvent as ReactWheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, withDiffSelection, withRightPanelMode } from "../diffRouteSearch";
import { isElectronRuntime } from "../env";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { normalizeSyntaxLanguage } from "../lib/syntaxLanguage";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";
type DiffSurfaceMode = "review" | "summary" | "total";

interface PatchSummaryFileStat {
  path: string;
  additions: number;
  deletions: number;
}

interface PatchSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  renamedFiles: number;
  createdFiles: number;
  deletedFiles: number;
  topFiles: PatchSummaryFileStat[];
}

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function normalizeFileDiffLanguage(fileDiff: FileDiffMetadata): FileDiffMetadata {
  if (!fileDiff.lang) {
    return fileDiff;
  }
  const normalized = normalizeSyntaxLanguage(fileDiff.lang);
  if (normalized === fileDiff.lang) {
    return fileDiff;
  }
  return setLanguageOverride(fileDiff, normalized as SupportedLanguages);
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function formatTurnChipTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function summarizePatch(patch: string | undefined): PatchSummary | null {
  if (!patch || patch.trim().length === 0) {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const touchedPaths = new Set<string>();
  const perFileStats = new Map<string, PatchSummaryFileStat>();
  let currentPath: string | null = null;
  let additions = 0;
  let deletions = 0;
  let renamedFiles = 0;
  let createdFiles = 0;
  let deletedFiles = 0;

  const ensureFileStat = (path: string): PatchSummaryFileStat => {
    const existing = perFileStats.get(path);
    if (existing) return existing;
    const created: PatchSummaryFileStat = { path, additions: 0, deletions: 0 };
    perFileStats.set(path, created);
    return created;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) {
        currentPath = match[2] ?? match[1] ?? null;
      } else {
        currentPath = null;
      }
      if (currentPath) {
        touchedPaths.add(currentPath);
        ensureFileStat(currentPath);
      }
      continue;
    }

    if (line.startsWith("rename from ")) {
      renamedFiles += 1;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      createdFiles += 1;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      deletedFiles += 1;
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      if (currentPath) {
        const stat = ensureFileStat(currentPath);
        stat.additions += 1;
      }
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
      if (currentPath) {
        const stat = ensureFileStat(currentPath);
        stat.deletions += 1;
      }
    }
  }

  const filesChanged = Math.max(touchedPaths.size, perFileStats.size);
  const topFiles = Array.from(perFileStats.values())
    .filter((file) => file.additions > 0 || file.deletions > 0)
    .toSorted((left, right) => {
      const leftMagnitude = left.additions + left.deletions;
      const rightMagnitude = right.additions + right.deletions;
      if (leftMagnitude !== rightMagnitude) {
        return rightMagnitude - leftMagnitude;
      }
      return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
    })
    .slice(0, 8);

  return {
    filesChanged,
    additions,
    deletions,
    renamedFiles,
    createdFiles,
    deletedFiles,
    topFiles,
  };
}

interface DiffPanelProps {
  mode?: "inline" | "sheet" | "sidebar";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const usesDesktopAppChrome = isElectronRuntime();
  const { resolvedTheme } = useTheme();
  const [surfaceMode, setSurfaceMode] = useState<DiffSurfaceMode>("review");
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
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
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const fullThreadCheckpointRange = useMemo(
    () =>
      typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount],
  );
  const reviewCheckpointRange = selectedTurn ? selectedCheckpointRange : fullThreadCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries]);
  const reviewCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: reviewCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: reviewCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
    }),
  );
  const totalCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: fullThreadCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: fullThreadCheckpointRange?.toTurnCount ?? null,
      cacheScope: conversationCacheScope ? `${conversationCacheScope}:total` : "conversation:total",
    }),
  );

  const reviewPatch = reviewCheckpointDiffQuery.data?.diff;
  const totalPatch = totalCheckpointDiffQuery.data?.diff;
  const activePatch = surfaceMode === "review" ? reviewPatch : totalPatch;
  const activeDiffIsLoading =
    surfaceMode === "review" ? reviewCheckpointDiffQuery.isLoading : totalCheckpointDiffQuery.isLoading;
  const activeDiffError =
    surfaceMode === "review"
      ? reviewCheckpointDiffQuery.error instanceof Error
        ? reviewCheckpointDiffQuery.error.message
        : reviewCheckpointDiffQuery.error
          ? "Failed to load checkpoint diff."
          : null
      : totalCheckpointDiffQuery.error instanceof Error
        ? totalCheckpointDiffQuery.error.message
        : totalCheckpointDiffQuery.error
          ? "Failed to load total diff."
          : null;
  const canShowTotal = Boolean(activeThreadId && fullThreadCheckpointRange);
  const canShowSummary = canShowTotal;

  useEffect(() => {
    if (!canShowTotal && (surfaceMode === "total" || surfaceMode === "summary")) {
      setSurfaceMode("review");
    }
  }, [canShowTotal, surfaceMode]);

  const hasResolvedPatch = typeof activePatch === "string";
  const hasNoNetChanges = hasResolvedPatch && activePatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(activePatch, `diff-panel:${surfaceMode}:${resolvedTheme}`),
    [activePatch, resolvedTheme, surfaceMode],
  );
  const patchSummary = useMemo(() => summarizePatch(totalPatch), [totalPatch]);
  const hasResolvedSummaryPatch = typeof totalPatch === "string";
  const hasNoSummaryChanges = hasResolvedSummaryPatch && totalPatch.trim().length === 0;
  const summaryError =
    totalCheckpointDiffQuery.error instanceof Error
      ? totalCheckpointDiffQuery.error.message
      : totalCheckpointDiffQuery.error
        ? "Failed to load total diff."
        : null;
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void api.shell.openInEditor(targetPath, preferredTerminalEditor()).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    setSurfaceMode("review");
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) =>
        withDiffSelection(previous as Record<string, unknown>, {
          turnId,
        }),
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    setSurfaceMode("review");
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) =>
        withRightPanelMode(previous as Record<string, unknown>, "diff"),
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {canScrollTurnStripLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatTurnChipTimestamp(summary.completedAt)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div
        className="desktop-top-edge-actions-safe flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
        data-testid="diff-panel-header-actions"
      >
        <ToggleGroup
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
      </div>
    </>
  );
  const headerRowClassName = cn(
    "desktop-top-edge-actions-safe flex min-w-0 items-center gap-2 pl-4 sm:pl-4",
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
          {headerRow}
        </div>
        <div
          className="desktop-top-edge-actions-safe flex h-10 items-end gap-5 border-t border-border/60 px-4 [-webkit-app-region:no-drag]"
          data-testid="diff-panel-surface-tabs"
        >
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-[13px] font-semibold transition-colors",
              surfaceMode === "summary"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              !canShowSummary && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
            )}
            disabled={!canShowSummary}
            onClick={() => setSurfaceMode("summary")}
            aria-pressed={surfaceMode === "summary"}
          >
            <AlignLeftIcon className="size-3.5" />
            <span>Summary</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-[13px] font-semibold transition-colors",
              surfaceMode === "review"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setSurfaceMode("review")}
            aria-pressed={surfaceMode === "review"}
          >
            <FileDiffIcon className="size-3.5" />
            <span>Review</span>
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-[13px] font-semibold transition-colors",
              surfaceMode === "total"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              !canShowTotal && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
            )}
            disabled={!canShowTotal}
            onClick={() => setSurfaceMode("total")}
            aria-pressed={surfaceMode === "total"}
          >
            <GitForkIcon className="size-3.5" />
            <span>Total</span>
          </button>
        </div>
      </div>

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          {surfaceMode === "summary" ? (
            <div className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-auto p-3">
              <div className="rounded-md border border-border/70 bg-background/70 p-3">
                <p className="text-xs font-semibold tracking-wide text-foreground">Summary</p>
                <p className="mt-1 text-[11px] text-muted-foreground/75">
                  Generated from the total thread diff.
                </p>
                {summaryError ? (
                  <p className="mt-3 text-[11px] text-red-500/80">{summaryError}</p>
                ) : totalCheckpointDiffQuery.isLoading ? (
                  <p className="mt-3 text-[11px] text-muted-foreground/80">Loading summary...</p>
                ) : hasNoSummaryChanges ? (
                  <p className="mt-3 text-[11px] text-muted-foreground/80">No changes to summarize.</p>
                ) : !patchSummary ? (
                  <p className="mt-3 text-[11px] text-muted-foreground/80">
                    Summary unavailable for the current diff.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3 text-[11px]">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <div className="rounded border border-border/70 bg-background px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/75">
                          Files
                        </p>
                        <p className="text-sm font-medium text-foreground">{patchSummary.filesChanged}</p>
                      </div>
                      <div className="rounded border border-border/70 bg-background px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/75">Added</p>
                        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                          +{patchSummary.additions}
                        </p>
                      </div>
                      <div className="rounded border border-border/70 bg-background px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/75">
                          Deleted
                        </p>
                        <p className="text-sm font-medium text-rose-600 dark:text-rose-400">
                          -{patchSummary.deletions}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <p className="rounded border border-border/70 bg-background px-2 py-1.5 text-muted-foreground/85">
                        Renamed files: <span className="font-medium text-foreground">{patchSummary.renamedFiles}</span>
                      </p>
                      <p className="rounded border border-border/70 bg-background px-2 py-1.5 text-muted-foreground/85">
                        Created files: <span className="font-medium text-foreground">{patchSummary.createdFiles}</span>
                      </p>
                      <p className="rounded border border-border/70 bg-background px-2 py-1.5 text-muted-foreground/85">
                        Deleted files: <span className="font-medium text-foreground">{patchSummary.deletedFiles}</span>
                      </p>
                    </div>
                    {patchSummary.topFiles.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">
                          Most changed files
                        </p>
                        <ul className="space-y-1">
                          {patchSummary.topFiles.map((file) => (
                            <li
                              key={file.path}
                              className="flex items-center justify-between rounded border border-border/60 bg-background px-2 py-1"
                            >
                              <button
                                type="button"
                                className="truncate text-left text-foreground hover:text-primary hover:underline"
                                title={file.path}
                                onClick={() => openDiffFileInEditor(file.path)}
                              >
                                {file.path}
                              </button>
                              <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/80">
                                +{file.additions} / -{file.deletions}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              ref={patchViewportRef}
              className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {activeDiffError && !renderablePatch && (
                <div className="px-3">
                  <p className="mb-2 text-[11px] text-red-500/80">{activeDiffError}</p>
                </div>
              )}
              {!renderablePatch ? (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {activeDiffIsLoading
                      ? surfaceMode === "total"
                        ? "Loading total diff..."
                        : "Loading checkpoint diff..."
                      : hasNoNetChanges
                        ? surfaceMode === "total"
                          ? "No total changes in this thread."
                          : "No net changes in this selection."
                        : "No patch available for this selection."}
                  </p>
                </div>
              ) : renderablePatch.kind === "files" ? (
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{
                    overscrollSize: 600,
                    intersectionObserverMargin: 1200,
                  }}
                >
                  {renderableFiles.map((fileDiff) => {
                    const normalizedFileDiff = normalizeFileDiffLanguage(fileDiff);
                    const filePath = resolveFileDiffPath(fileDiff);
                    const fileKey = buildFileDiffRenderKey(fileDiff);
                    const themedFileKey = `${fileKey}:${resolvedTheme}`;
                    return (
                      <div
                        key={themedFileKey}
                        data-diff-file-path={filePath}
                        className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                        onClickCapture={(event) => {
                          const nativeEvent = event.nativeEvent as MouseEvent;
                          const composedPath = nativeEvent.composedPath?.() ?? [];
                          const clickedHeader = composedPath.some((node) => {
                            if (!(node instanceof Element)) return false;
                            return node.hasAttribute("data-title");
                          });
                          if (!clickedHeader) return;
                          openDiffFileInEditor(filePath);
                        }}
                      >
                        <FileDiff
                          fileDiff={normalizedFileDiff}
                          options={{
                            diffStyle: diffRenderMode === "split" ? "split" : "unified",
                            lineDiffType: "none",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                          }}
                        />
                      </div>
                    );
                  })}
                </Virtualizer>
              ) : (
                <div className="h-full overflow-auto p-2">
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                    <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                      {renderablePatch.text}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
