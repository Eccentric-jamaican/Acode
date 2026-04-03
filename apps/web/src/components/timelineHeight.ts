import {
  estimateTimelineTextLineCount,
  type TimelineTextMetrics,
} from "../lib/timelineTextLayout";

const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 56;
const ASSISTANT_LINE_HEIGHT_PX = 22;
const USER_LINE_HEIGHT_PX = 20;
const ASSISTANT_BASE_HEIGHT_PX = 78;
const USER_BASE_HEIGHT_PX = 86;
const ATTACHMENTS_PER_ROW = 2;
// Attachment thumbnails render with `max-h-[220px]` plus ~6px row gap.
const USER_ATTACHMENT_ROW_HEIGHT_PX = 226;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 24;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const USER_MONO_AVG_CHAR_WIDTH_PX = 8.4;
const ASSISTANT_AVG_CHAR_WIDTH_PX = 7.2;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;
const ASSISTANT_FONT = '400 14px "DM Sans", sans-serif';
const USER_FONT = '400 14px "DM Sans", sans-serif';

interface TimelineMessageHeightInput {
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string }>;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx: number | null;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveUserTextWidthPx(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) {
    return USER_CHARS_PER_LINE_FALLBACK * USER_MONO_AVG_CHAR_WIDTH_PX;
  }
  const bubbleWidthPx = timelineWidthPx * USER_BUBBLE_WIDTH_RATIO;
  return Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
}

function resolveAssistantTextWidthPx(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) {
    return ASSISTANT_CHARS_PER_LINE_FALLBACK * ASSISTANT_AVG_CHAR_WIDTH_PX;
  }
  return Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0);
}

const USER_TEXT_METRICS: TimelineTextMetrics = {
  font: USER_FONT,
  lineHeightPx: USER_LINE_HEIGHT_PX,
  fallbackCharsPerLine: MIN_USER_CHARS_PER_LINE,
  fallbackAvgCharWidthPx: USER_MONO_AVG_CHAR_WIDTH_PX,
  fallbackTextWidthPx: USER_CHARS_PER_LINE_FALLBACK * USER_MONO_AVG_CHAR_WIDTH_PX,
};

const ASSISTANT_TEXT_METRICS: TimelineTextMetrics = {
  font: ASSISTANT_FONT,
  lineHeightPx: ASSISTANT_LINE_HEIGHT_PX,
  fallbackCharsPerLine: MIN_ASSISTANT_CHARS_PER_LINE,
  fallbackAvgCharWidthPx: ASSISTANT_AVG_CHAR_WIDTH_PX,
  fallbackTextWidthPx: ASSISTANT_CHARS_PER_LINE_FALLBACK * ASSISTANT_AVG_CHAR_WIDTH_PX,
};

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  if (message.role === "assistant") {
    const estimatedLines = estimateTimelineTextLineCount({
      text: message.text,
      textWidthPx: resolveAssistantTextWidthPx(layout.timelineWidthPx),
      metrics: ASSISTANT_TEXT_METRICS,
    });
    return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * ASSISTANT_LINE_HEIGHT_PX;
  }

  if (message.role === "user") {
    const estimatedLines = estimateTimelineTextLineCount({
      text: message.text,
      textWidthPx: resolveUserTextWidthPx(layout.timelineWidthPx),
      metrics: USER_TEXT_METRICS,
    });
    const attachmentCount = message.attachments?.length ?? 0;
    const attachmentRows = Math.ceil(attachmentCount / ATTACHMENTS_PER_ROW);
    const attachmentHeight = attachmentRows * USER_ATTACHMENT_ROW_HEIGHT_PX;
    return USER_BASE_HEIGHT_PX + estimatedLines * USER_LINE_HEIGHT_PX + attachmentHeight;
  }

  // `system` messages are not rendered in the chat timeline, but keep a stable
  // explicit branch in case they are present in timeline data.
  const estimatedLines = estimateTimelineTextLineCount({
    text: message.text,
    textWidthPx: resolveAssistantTextWidthPx(layout.timelineWidthPx),
    metrics: ASSISTANT_TEXT_METRICS,
  });
  return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * ASSISTANT_LINE_HEIGHT_PX;
}

