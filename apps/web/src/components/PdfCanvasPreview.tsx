import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";

type PdfJsMapCompatibilityPrototype = Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
};

function pdfJsMapGetOrInsertComputed(
  this: Map<unknown, unknown>,
  key: unknown,
  callback: (key: unknown) => unknown,
): unknown {
  if (this.has(key)) {
    return this.get(key);
  }
  const value = callback(key);
  this.set(key, value);
  return value;
}

function installPdfJsMapCompatibilityShim(): void {
  const mapPrototype = Map.prototype as PdfJsMapCompatibilityPrototype;
  if (mapPrototype.getOrInsertComputed) {
    return;
  }
  Object.defineProperty(mapPrototype, "getOrInsertComputed", {
    configurable: true,
    value: pdfJsMapGetOrInsertComputed,
    writable: true,
  });
}

installPdfJsMapCompatibilityShim();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function PdfPreviewEmptyState(props: { message: string }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground/80">
      {props.message}
    </div>
  );
}

export function PdfCanvasPreview(props: {
  bytes: Uint8Array;
  filePath: string;
  layout?: "embedded" | "panel";
  mimeType: string;
}) {
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfDocument(null);
    setError(null);
    const loadingTask = getDocument({
      data: props.bytes.slice(),
      enableXfa: true,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      useSystemFonts: true,
      useWasm: false,
    });
    void loadingTask.promise
      .then((document) => {
        if (!cancelled) {
          setPdfDocument(document);
        } else {
          void document.destroy();
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to preview PDF.");
        }
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [props.bytes]);

  if (error) {
    return <PdfPreviewEmptyState message={error} />;
  }

  if (!pdfDocument) {
    return <PdfPreviewEmptyState message="Loading PDF..." />;
  }

  const layout = props.layout ?? "panel";

  return (
    <div
      className={cn(
        "bg-muted/28",
        layout === "panel" ? "h-full overflow-auto px-6 py-6" : "px-3 py-3",
      )}
    >
      <div
        className={cn(
          "mx-auto flex flex-col items-center gap-5",
          layout === "panel" ? "max-w-5xl" : "max-w-full",
        )}
      >
        {Array.from({ length: pdfDocument.numPages }, (_, pageIndex) => {
          const pageNumber = pageIndex + 1;
          return (
            <PdfPage
              key={`${props.filePath}:${props.mimeType}:page-${pageNumber}`}
              document={pdfDocument}
              pageNumber={pageNumber}
            />
          );
        })}
      </div>
    </div>
  );
}

function PdfPage(props: { document: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "rendered" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ height: number; width: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    setRenderState("loading");
    setErrorMessage(null);
    let cleanupRender: (() => void) | null = null;
    void props.document
      .getPage(props.pageNumber)
      .then(async (page) => {
        if (cancelled) {
          return;
        }
        const viewport = page.getViewport({ scale: 1.75 });
        const outputScale = window.devicePixelRatio || 1;
        const cssWidth = Math.ceil(viewport.width);
        const cssHeight = Math.ceil(viewport.height);
        setPageSize({ height: cssHeight, width: cssWidth });
        canvas.width = Math.ceil(cssWidth * outputScale);
        canvas.height = Math.ceil(cssHeight * outputScale);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("Canvas rendering is unavailable.");
        }
        context.save();
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
        const renderTask = page.render({
          annotationMode: AnnotationMode.ENABLE_STORAGE,
          background: "rgb(255, 255, 255)",
          canvas,
          canvasContext: context,
          transform,
          viewport,
        });
        cleanupRender = () => renderTask.cancel();
        await renderTask.promise;
        if (!cancelled) {
          setRenderState("rendered");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setErrorMessage(cause instanceof Error ? cause.message : "Unable to render this page.");
          setRenderState("error");
        }
      });

    return () => {
      cancelled = true;
      cleanupRender?.();
    };
  }, [props.document, props.pageNumber]);

  return (
    <div
      className="relative max-w-full rounded-md border border-border/55 bg-white shadow-sm"
      style={{
        aspectRatio: pageSize ? `${pageSize.width} / ${pageSize.height}` : undefined,
        width: pageSize ? `${pageSize.width}px` : "min(100%, 820px)",
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label={`Page ${props.pageNumber}`}
        className="block h-auto w-full rounded-md bg-white"
      />
      {renderState !== "rendered" ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-white text-xs text-muted-foreground/70">
          {renderState === "error"
            ? (errorMessage ?? "Unable to render this page.")
            : "Loading page..."}
        </div>
      ) : null}
    </div>
  );
}
