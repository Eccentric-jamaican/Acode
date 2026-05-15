export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export type ComputerUseCapturePreview = {
  url: string;
  captureId?: string;
  width?: number;
  height?: number;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function collectComputerUseCaptures(
  value: unknown,
  captures: ComputerUseCapturePreview[] = [],
  seen = new Set<unknown>(),
  depth = 0,
): ComputerUseCapturePreview[] {
  if (depth > 6 || value === null || value === undefined || seen.has(value)) return captures;
  const record = recordValue(value);
  if (!record) return captures;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectComputerUseCaptures(entry, captures, seen, depth + 1);
    return captures;
  }

  const url = trimmedString(record.url) ?? trimmedString(record.previewUrl);
  if (url && url.startsWith("/attachments/")) {
    const capture: ComputerUseCapturePreview = { url };
    const captureId = trimmedString(record.captureId);
    if (captureId) capture.captureId = captureId;
    if (typeof record.width === "number") capture.width = record.width;
    if (typeof record.height === "number") capture.height = record.height;
    captures.push(capture);
  }

  for (const child of Object.values(record)) {
    collectComputerUseCaptures(child, captures, seen, depth + 1);
  }
  return captures;
}
