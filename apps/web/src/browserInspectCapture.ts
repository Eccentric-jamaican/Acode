import type { BrowserInspectCapture } from "@t3tools/contracts";

export function inspectCaptureLabel(capture: Pick<BrowserInspectCapture, "tagName" | "textSummary">): string {
  const tagName = capture.tagName.toLowerCase();
  const text = capture.textSummary.trim().replace(/\s+/g, " ");
  return text.length > 0 ? `${tagName}: ${text.slice(0, 48)}` : tagName;
}

export function buildInspectPrompt(capture: BrowserInspectCapture): string {
  const metadata = {
    source: {
      kind: "t3_integrated_browser_inspect_capture",
      appSurface: "desktop-integrated-browser-pane",
      projectId: capture.projectId,
      sessionId: capture.sessionId,
      capturedAt: capture.capturedAt,
    },
    selector: capture.selector,
    tagName: capture.tagName,
    url: capture.url,
    ancestry: capture.ancestry,
    textSummary: capture.textSummary,
    accessibilitySummary: capture.accessibilitySummary,
    sourceUrl: capture.sourceUrl,
    sourceLocation: capture.sourceLocation,
    boundingBox: capture.boundingBox,
    computedStyle: capture.computedStyle,
  };
  return [
    "[T3_BROWSER_INSPECT_CAPTURE]",
    "Source: This element/DOM context was captured from the T3 integrated browser pane.",
    "Provenance: Do not assume this came from external Chrome MCP context.",
    "Use this inspected element as the target for the next edit.",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
  ].join("\n");
}
