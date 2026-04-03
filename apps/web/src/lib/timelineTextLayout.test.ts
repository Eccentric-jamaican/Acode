import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrepare, mockLayout } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockLayout: vi.fn(),
}));

vi.mock("@chenglou/pretext", () => ({
  prepare: mockPrepare,
  layout: mockLayout,
}));

import {
  estimateTimelineTextLineCount,
  resetTimelineTextLayoutStateForTests,
  type TimelineTextMetrics,
} from "./timelineTextLayout";

const TEST_METRICS: TimelineTextMetrics = {
  font: '400 14px "DM Sans", sans-serif',
  lineHeightPx: 20,
  fallbackCharsPerLine: 4,
  fallbackAvgCharWidthPx: 10,
  fallbackTextWidthPx: 40,
};

describe("estimateTimelineTextLineCount", () => {
  beforeEach(() => {
    resetTimelineTextLayoutStateForTests();
    mockPrepare.mockReset();
    mockLayout.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses fallback wrapping when browser globals are unavailable", () => {
    const result = estimateTimelineTextLineCount({
      text: "abcd\nefghij",
      textWidthPx: 20,
      metrics: TEST_METRICS,
    });

    expect(result).toBe(3);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockLayout).not.toHaveBeenCalled();
  });

  it("uses pretext layout when browser globals are available", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    mockPrepare.mockReturnValue({ prepared: true });
    mockLayout.mockReturnValue({ lineCount: 5, height: 100 });

    const result = estimateTimelineTextLineCount({
      text: "hello world",
      textWidthPx: 180,
      metrics: TEST_METRICS,
    });

    expect(result).toBe(5);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockLayout).toHaveBeenCalledTimes(1);
  });

  it("reuses prepared text from cache for repeated measurements", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    mockPrepare.mockReturnValue({ prepared: true });
    mockLayout.mockReturnValue({ lineCount: 2, height: 40 });

    const input = {
      text: "cache me",
      textWidthPx: 160,
      metrics: TEST_METRICS,
    } as const;

    estimateTimelineTextLineCount(input);
    estimateTimelineTextLineCount(input);

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockLayout).toHaveBeenCalledTimes(2);
  });

  it("disables pretext after a prepare failure and stays on fallback", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    mockPrepare.mockImplementation(() => {
      throw new Error("prepare failed");
    });

    const firstResult = estimateTimelineTextLineCount({
      text: "abcdefgh",
      textWidthPx: 20,
      metrics: TEST_METRICS,
    });
    const secondResult = estimateTimelineTextLineCount({
      text: "abcdefgh",
      textWidthPx: 20,
      metrics: TEST_METRICS,
    });

    expect(firstResult).toBe(2);
    expect(secondResult).toBe(2);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockLayout).not.toHaveBeenCalled();
  });
});

