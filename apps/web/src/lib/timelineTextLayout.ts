import { layout, prepare, type PreparedText } from "@chenglou/pretext";

import { LRUCache } from "./lruCache";

const PRETEXT_PREPARED_TEXT_CACHE_ENTRIES = 300;
const PRETEXT_PREPARED_TEXT_CACHE_BYTES = 3 * 1024 * 1024;
const PRETEXT_MIN_TEXT_WIDTH_PX = 1;

const preparedTextCache = new LRUCache<PreparedText>(
  PRETEXT_PREPARED_TEXT_CACHE_ENTRIES,
  PRETEXT_PREPARED_TEXT_CACHE_BYTES,
);
let pretextDisabled = false;

export interface TimelineTextMetrics {
  font: string;
  lineHeightPx: number;
  fallbackCharsPerLine: number;
  fallbackAvgCharWidthPx: number;
  fallbackTextWidthPx: number;
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function canUsePretext(): boolean {
  if (pretextDisabled) return false;
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function pretextCacheKey(text: string, metrics: TimelineTextMetrics): string {
  return `${metrics.font}:${metrics.lineHeightPx}:${text}`;
}

function readCachedPreparedText(text: string, metrics: TimelineTextMetrics): PreparedText | null {
  if (!canUsePretext()) return null;
  const cacheKey = pretextCacheKey(text, metrics);
  const cached = preparedTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const preparedText = prepare(text, metrics.font);
    preparedTextCache.set(cacheKey, preparedText, Math.max(text.length * 2, 32));
    return preparedText;
  } catch {
    pretextDisabled = true;
    preparedTextCache.clear();
    return null;
  }
}

function estimateLineCountWithPretext(
  text: string,
  maxWidthPx: number,
  metrics: TimelineTextMetrics,
): number | null {
  const preparedText = readCachedPreparedText(text, metrics);
  if (!preparedText) return null;

  try {
    const result = layout(
      preparedText,
      Math.max(PRETEXT_MIN_TEXT_WIDTH_PX, Math.floor(maxWidthPx)),
      metrics.lineHeightPx,
    );
    return Math.max(result.lineCount, 1);
  } catch {
    pretextDisabled = true;
    preparedTextCache.clear();
    return null;
  }
}

function estimateLineCountWithFallback(
  text: string,
  textWidthPx: number,
  metrics: TimelineTextMetrics,
): number {
  const normalizedTextWidthPx = isFinitePositiveNumber(textWidthPx)
    ? textWidthPx
    : metrics.fallbackTextWidthPx;
  const charsPerLine = Math.max(
    metrics.fallbackCharsPerLine,
    Math.floor(normalizedTextWidthPx / metrics.fallbackAvgCharWidthPx),
  );
  return estimateWrappedLineCount(text, charsPerLine);
}

export function estimateTimelineTextLineCount(input: {
  text: string;
  textWidthPx: number;
  metrics: TimelineTextMetrics;
}): number {
  const pretextLineCount = estimateLineCountWithPretext(
    input.text,
    input.textWidthPx,
    input.metrics,
  );
  if (pretextLineCount !== null) {
    return pretextLineCount;
  }

  return estimateLineCountWithFallback(input.text, input.textWidthPx, input.metrics);
}

export function resetTimelineTextLayoutStateForTests(): void {
  pretextDisabled = false;
  preparedTextCache.clear();
}

