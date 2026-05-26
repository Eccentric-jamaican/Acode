import type { PdfAnnotationCapture } from "./composerDraftStore";

export function pdfAnnotationLabel(capture: Pick<PdfAnnotationCapture, "filePath" | "pageNumber">): string {
  const parts = capture.filePath.split(/[\\/]/);
  const fileName = parts.at(-1) || capture.filePath;
  return `${fileName} p.${capture.pageNumber}`;
}

export function buildPdfAnnotationPrompt(capture: PdfAnnotationCapture): string {
  const metadata = {
    source: {
      kind: "t3_pdf_annotation_capture",
      appSurface: "pdf-preview",
      capturedAt: capture.capturedAt,
    },
    filePath: capture.filePath,
    pageNumber: capture.pageNumber,
    boundingBox: capture.boundingBox,
    zoomPercent: capture.zoomPercent,
    screenshotAttached: true,
  };
  return [
    "[T3_PDF_ANNOTATION]",
    "Source: This region was annotated in the T3 PDF preview.",
    "Use the attached image and metadata as the selected PDF context for the next response.",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
  ].join("\n");
}
