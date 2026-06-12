import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Maximize2Icon, MessageCircleIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  type PointerEvent,
  type RefObject,
  type TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";

import type { ComposerPdfAnnotationDraft, PdfAnnotationCapture } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type PdfJsMapCompatibilityPrototype = Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown;
};

type PdfZoomMode = "fit-width" | "fit-page" | "custom";

type PinchGestureState = {
  contentX: number;
  contentY: number;
  distance: number;
  scale: number;
  viewportX: number;
  viewportY: number;
};

type ReactTouchList = TouchEvent<HTMLDivElement>["touches"];

type PdfAnnotationSelectionMarker = {
  id: string;
  pageNumber: number;
  boundingBox: PdfAnnotationCapture["boundingBox"];
};

const MIN_ZOOM_SCALE = 0.35;
const MAX_ZOOM_SCALE = 3.5;
const ZOOM_STEP = 0.15;
const DEFAULT_SCALE = 1.25;
const PAGE_GAP_PX = 20;
const PANEL_PADDING_X_PX = 48;
const EMBEDDED_PADDING_X_PX = 24;
const WHEEL_ZOOM_SENSITIVITY = 0.002;
const RENDER_SCALE_SETTLE_MS = 140;
const RENDER_SCALE_QUALITY_GAP = 0.18;
const PDF_RENDER_ROOT_MARGIN = "240px 0px";
const ESTIMATED_PAGE_SIZE = {
  height: 792,
  width: 612,
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

function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return DEFAULT_SCALE;
  }
  return Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, scale));
}

function clampZoomScaleToMax(scale: number, maxScale: number): number {
  if (!Number.isFinite(scale)) {
    return DEFAULT_SCALE;
  }
  return Math.max(MIN_ZOOM_SCALE, Math.min(maxScale, scale));
}

function getPdfDisplayName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.at(-1) || filePath;
}

function getTouchDistance(touches: ReactTouchList): number {
  const firstTouch = touches.item(0);
  const secondTouch = touches.item(1);
  if (!firstTouch || !secondTouch) {
    return 0;
  }
  return Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY);
}

function getTouchMidpoint(touches: ReactTouchList): { clientX: number; clientY: number } | null {
  const firstTouch = touches.item(0);
  const secondTouch = touches.item(1);
  if (!firstTouch || !secondTouch) {
    return null;
  }
  return {
    clientX: (firstTouch.clientX + secondTouch.clientX) / 2,
    clientY: (firstTouch.clientY + secondTouch.clientY) / 2,
  };
}

function PdfPreviewEmptyState(props: { message: string }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground/80">
      {props.message}
    </div>
  );
}

installPdfJsMapCompatibilityShim();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function PdfCanvasPreview(props: {
  annotations?: readonly ComposerPdfAnnotationDraft[] | undefined;
  bytes: Uint8Array;
  filePath: string;
  layout?: "embedded" | "panel";
  mimeType: string;
  onAddAnnotation?: ((capture: PdfAnnotationCapture) => void) | undefined;
}) {
  const layout = props.layout ?? "panel";
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const pinchGestureRef = useRef<PinchGestureState | null>(null);
  const effectiveScaleRef = useRef(DEFAULT_SCALE);
  const scrollAnchorFrameRef = useRef<number | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>("fit-width");
  const [customScale, setCustomScale] = useState(DEFAULT_SCALE);
  const [renderScale, setRenderScale] = useState(DEFAULT_SCALE);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pageSizesByPage, setPageSizesByPage] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [renderablePages, setRenderablePages] = useState<ReadonlySet<number>>(() => new Set([1]));

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      setViewportSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pdfDocument]);

  useEffect(() => {
    let cancelled = false;
    setPdfDocument(null);
    setPageSizesByPage({});
    setRenderablePages(new Set([1]));
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

  const pageSizes = useMemo(() => {
    const measuredSizes = Object.values(pageSizesByPage);
    return measuredSizes.length > 0 ? measuredSizes : [ESTIMATED_PAGE_SIZE];
  }, [pageSizesByPage]);
  const fitScales = useMemo(() => {
    const maxPageWidth = Math.max(...pageSizes.map((size) => size.width), 0);
    const maxPageHeight = Math.max(...pageSizes.map((size) => size.height), 0);
    const horizontalPadding = layout === "panel" ? PANEL_PADDING_X_PX : EMBEDDED_PADDING_X_PX;
    const availableWidth = Math.max(1, viewportSize.width - horizontalPadding);
    const availableHeight = Math.max(1, viewportSize.height - PAGE_GAP_PX * 2);
    const fitWidth = maxPageWidth > 0 ? availableWidth / maxPageWidth : DEFAULT_SCALE;
    const fitPage =
      maxPageWidth > 0 && maxPageHeight > 0
        ? Math.min(fitWidth, availableHeight / maxPageHeight)
        : fitWidth;
    return {
      fitPage: clampZoomScale(fitPage),
      fitWidth: clampZoomScale(fitWidth),
    };
  }, [layout, pageSizes, viewportSize.height, viewportSize.width]);
  const effectiveScale =
    zoomMode === "fit-width"
      ? fitScales.fitWidth
      : zoomMode === "fit-page"
        ? fitScales.fitPage
        : clampZoomScaleToMax(customScale, fitScales.fitWidth);
  const maxCustomScale = fitScales.fitWidth;
  const zoomPercent = Math.round(effectiveScale * 100);
  const displayName = getPdfDisplayName(props.filePath);
  const annotationMarkers = useMemo(
    () =>
      (props.annotations ?? []).map((annotation) => ({
        id: annotation.id,
        pageNumber: annotation.capture.pageNumber,
        boundingBox: annotation.capture.boundingBox,
      })),
    [props.annotations],
  );
  const annotationCount = annotationMarkers.length;
  const previousAnnotationCountRef = useRef(annotationCount);
  const onAddAnnotation = props.onAddAnnotation;
  const canAnnotate = typeof onAddAnnotation === "function";

  useEffect(() => {
    effectiveScaleRef.current = effectiveScale;
  }, [effectiveScale]);

  useEffect(
    () => () => {
      if (scrollAnchorFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollAnchorFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (Math.abs(renderScale - effectiveScale) < 0.001) {
      return;
    }

    if (effectiveScale > renderScale && effectiveScale / renderScale > 1 + RENDER_SCALE_QUALITY_GAP) {
      setRenderScale(effectiveScale);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRenderScale(effectiveScale);
    }, RENDER_SCALE_SETTLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [effectiveScale, renderScale]);

  useEffect(() => {
    if (!canAnnotate) {
      setAnnotationMode(false);
    }
  }, [canAnnotate]);

  useEffect(() => {
    if (previousAnnotationCountRef.current !== annotationCount) {
      setAnnotationMode(false);
      previousAnnotationCountRef.current = annotationCount;
    }
  }, [annotationCount]);

  const setCustomZoomFromCurrent = useCallback(
    (delta: number) => {
      setZoomMode("custom");
      setCustomScale(clampZoomScaleToMax(effectiveScale + delta, maxCustomScale));
    },
    [effectiveScale, maxCustomScale],
  );

  const zoomAroundPoint = useCallback(
    (
      scrollArea: HTMLDivElement,
      nextScale: number,
      anchor: { contentX: number; contentY: number; viewportX: number; viewportY: number },
      sourceScale = effectiveScaleRef.current,
      options?: { anchorScroll?: boolean; maxScale?: number },
    ) => {
      const clampedScale = clampZoomScaleToMax(nextScale, options?.maxScale ?? MAX_ZOOM_SCALE);
      if (Math.abs(clampedScale - sourceScale) < 0.001) {
        return;
      }

      setZoomMode("custom");
      effectiveScaleRef.current = clampedScale;
      setCustomScale(clampedScale);
      if (options?.anchorScroll === false) {
        return;
      }
      if (scrollAnchorFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollAnchorFrameRef.current);
      }
      scrollAnchorFrameRef.current = window.requestAnimationFrame(() => {
        scrollAnchorFrameRef.current = null;
        const scaleRatio = clampedScale / sourceScale;
        scrollArea.scrollLeft = anchor.contentX * scaleRatio - anchor.viewportX;
        scrollArea.scrollTop = anchor.contentY * scaleRatio - anchor.viewportY;
      });
    },
    [],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const scrollArea = event.currentTarget;
      const bounds = scrollArea.getBoundingClientRect();
      const viewportX = event.clientX - bounds.left;
      const viewportY = event.clientY - bounds.top;
      const sourceScale = effectiveScaleRef.current;
      const zoomFactor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const clampedScale = clampZoomScaleToMax(sourceScale * zoomFactor, maxCustomScale);
      zoomAroundPoint(
        scrollArea,
        clampedScale,
        {
          contentX: scrollArea.scrollLeft + viewportX,
          contentY: scrollArea.scrollTop + viewportY,
          viewportX,
          viewportY,
        },
        sourceScale,
        { anchorScroll: false, maxScale: maxCustomScale },
      );
    },
    [maxCustomScale, zoomAroundPoint],
  );

  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (event.touches.length !== 2) {
        pinchGestureRef.current = null;
        return;
      }

      const midpoint = getTouchMidpoint(event.touches);
      const distance = getTouchDistance(event.touches);
      if (!midpoint || distance <= 0) {
        return;
      }

      const scrollArea = event.currentTarget;
      const bounds = scrollArea.getBoundingClientRect();
      const viewportX = midpoint.clientX - bounds.left;
      const viewportY = midpoint.clientY - bounds.top;
      pinchGestureRef.current = {
        contentX: scrollArea.scrollLeft + viewportX,
        contentY: scrollArea.scrollTop + viewportY,
        distance,
        scale: effectiveScaleRef.current,
        viewportX,
        viewportY,
      };
    },
    [],
  );

  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const gesture = pinchGestureRef.current;
      if (!gesture || event.touches.length !== 2) {
        return;
      }

      const distance = getTouchDistance(event.touches);
      if (distance <= 0) {
        return;
      }

      event.preventDefault();
      zoomAroundPoint(
        event.currentTarget,
        gesture.scale * (distance / gesture.distance),
        gesture,
        gesture.scale,
        { maxScale: maxCustomScale },
      );
    },
    [maxCustomScale, zoomAroundPoint],
  );

  const handleTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length < 2) {
      pinchGestureRef.current = null;
    }
  }, []);

  const handleAnnotationCapture = useCallback(
    (capture: PdfAnnotationCapture) => {
      setAnnotationMode(false);
      onAddAnnotation?.(capture);
    },
    [onAddAnnotation],
  );

  const recordPageSize = useCallback((pageNumber: number, size: { width: number; height: number }) => {
    setPageSizesByPage((current) => {
      const existing = current[pageNumber];
      if (existing?.width === size.width && existing.height === size.height) {
        return current;
      }
      return {
        ...current,
        [pageNumber]: size,
      };
    });
  }, []);

  const markPageRenderable = useCallback((pageNumber: number) => {
    setRenderablePages((current) => {
      if (current.has(pageNumber)) {
        return current;
      }
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  if (error) {
    return <PdfPreviewEmptyState message={error} />;
  }

  if (!pdfDocument) {
    return <PdfPreviewEmptyState message="Loading PDF..." />;
  }

  return (
    <div
      ref={viewportRef}
      className={cn(
        "min-h-0 bg-muted/28",
        layout === "panel" ? "flex h-full flex-col" : "flex max-h-full flex-col",
      )}
    >
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background/94 px-2.5 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="min-w-0" title={props.filePath}>
          <div className="truncate text-xs font-medium text-foreground/88">{displayName}</div>
          <div className="truncate text-[10px] leading-3 text-muted-foreground/70">
            {annotationMode ? "Annotating" : "PDF preview"}
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-background/70 p-0.5"
          aria-label="PDF controls"
        >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Zoom out"
              title="Zoom out"
              className="rounded-md"
              disabled={effectiveScale <= MIN_ZOOM_SCALE + 0.001}
              onClick={() => setCustomZoomFromCurrent(-ZOOM_STEP)}
            >
              <MinusIcon className="size-3.5" />
            </Button>
            <span className="w-11 text-center font-mono text-[11px] leading-4 text-muted-foreground">
              {zoomPercent}%
            </span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Zoom in"
              title="Zoom in"
              className="rounded-md"
              disabled={effectiveScale >= maxCustomScale - 0.001}
              onClick={() => setCustomZoomFromCurrent(ZOOM_STEP)}
            >
              <PlusIcon className="size-3.5" />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border/70" />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-pressed={zoomMode === "fit-width" ? "" : undefined}
              className="rounded-md px-2.5"
              aria-label="Fit PDF to width"
              title="Fit width"
              onClick={() => setZoomMode("fit-width")}
            >
              Width
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-pressed={zoomMode === "fit-page" ? "" : undefined}
              className="rounded-md"
              aria-label="Fit PDF page"
              title="Fit page"
              onClick={() => setZoomMode("fit-page")}
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border/70" />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-pressed={annotationMode ? "" : undefined}
              aria-pressed={annotationMode}
              className="relative rounded-md"
              aria-label={annotationMode ? "Stop annotating PDF" : "Annotate PDF"}
              title={annotationMode ? "Stop annotating" : canAnnotate ? "Annotate PDF" : "Annotations"}
              disabled={!canAnnotate}
              onClick={() => setAnnotationMode((current) => !current)}
            >
              <MessageCircleIcon className="size-3.5" />
              {annotationCount > 0 ? (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-amber-500 px-0.5 text-[8px] leading-3 text-white">
                  {Math.min(annotationCount, 9)}
                </span>
              ) : null}
            </Button>
        </div>
      </div>
      <div
        ref={scrollAreaRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto overscroll-contain",
          annotationMode && "cursor-crosshair select-none",
          layout === "panel" ? "px-6 py-6" : "px-3 py-3",
        )}
        onTouchCancel={handleTouchEnd}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        onWheel={handleWheel}
        style={{ touchAction: "pan-x pan-y" }}
      >
        <div
          className="mx-auto flex flex-col items-center gap-5"
          style={{
            maxWidth:
              pageSizes.length > 0
                ? `${Math.max(...pageSizes.map((size) => size.width)) * effectiveScale}px`
                : undefined,
          }}
        >
          {Array.from({ length: pdfDocument.numPages }, (_, pageIndex) => {
            const pageNumber = pageIndex + 1;
            return (
              <PdfPage
                key={`${props.filePath}:${props.mimeType}:page-${pageNumber}`}
                document={pdfDocument}
                pageNumber={pageNumber}
                renderScale={renderScale}
                scrollRootRef={scrollAreaRef}
                shouldRender={renderablePages.has(pageNumber)}
                visualScale={effectiveScale}
                annotationMode={annotationMode}
                annotationMarkers={annotationMarkers.filter(
                  (marker) => marker.pageNumber === pageNumber,
                )}
                filePath={props.filePath}
                onPageNearViewport={markPageRenderable}
                onPageSize={recordPageSize}
                onAnnotationCapture={canAnnotate ? handleAnnotationCapture : undefined}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PdfPage(props: {
  annotationMarkers: PdfAnnotationSelectionMarker[];
  annotationMode: boolean;
  document: PDFDocumentProxy;
  filePath: string;
  pageNumber: number;
  renderScale: number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  shouldRender: boolean;
  visualScale: number;
  onAnnotationCapture?: ((capture: PdfAnnotationCapture) => void) | undefined;
  onPageNearViewport: (pageNumber: number) => void;
  onPageSize: (pageNumber: number, size: { width: number; height: number }) => void;
}) {
  const {
    annotationMarkers,
    annotationMode,
    document,
    filePath,
    onAnnotationCapture,
    onPageNearViewport,
    onPageSize,
    pageNumber,
    renderScale,
    scrollRootRef,
    shouldRender,
    visualScale,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const selectionPointerIdRef = useRef<number | null>(null);
  const hasRenderedPageRef = useRef(false);
  const [renderState, setRenderState] = useState<"queued" | "loading" | "rendered" | "error">(
    shouldRender ? "loading" : "queued",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [basePageSize, setBasePageSize] = useState<{ height: number; width: number } | null>(null);
  const [draftSelection, setDraftSelection] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  useEffect(() => {
    const root = pageRootRef.current;
    const scrollRoot = scrollRootRef.current;
    if (!root) {
      return;
    }
    if (pageNumber === 1 || typeof IntersectionObserver === "undefined" || !scrollRoot) {
      onPageNearViewport(pageNumber);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onPageNearViewport(pageNumber);
          observer.disconnect();
        }
      },
      {
        root: scrollRoot,
        rootMargin: PDF_RENDER_ROOT_MARGIN,
        threshold: 0,
      },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [onPageNearViewport, pageNumber, scrollRootRef]);

  useEffect(() => {
    if (!shouldRender) {
      if (!hasRenderedPageRef.current) {
        setRenderState("queued");
      }
      return;
    }

    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    if (!hasRenderedPageRef.current) {
      setRenderState("loading");
    }
    setErrorMessage(null);
    let cleanupRender: (() => void) | null = null;
    void document
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) {
          return;
        }
        const baseViewport = page.getViewport({ scale: 1 });
        const baseSize = {
          height: Math.ceil(baseViewport.height),
          width: Math.ceil(baseViewport.width),
        };
        setBasePageSize(baseSize);
        onPageSize(pageNumber, baseSize);
        const viewport = page.getViewport({ scale: renderScale });
        const outputScale = window.devicePixelRatio || 1;
        const cssWidth = Math.ceil(viewport.width);
        const cssHeight = Math.ceil(viewport.height);
        const renderCanvas = globalThis.document.createElement("canvas");
        renderCanvas.width = Math.ceil(cssWidth * outputScale);
        renderCanvas.height = Math.ceil(cssHeight * outputScale);
        const renderContext = renderCanvas.getContext("2d", { alpha: false });
        if (!renderContext) {
          throw new Error("Canvas rendering is unavailable.");
        }
        renderContext.save();
        renderContext.fillStyle = "#ffffff";
        renderContext.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
        renderContext.restore();
        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
        const renderTask = page.render({
          annotationMode: AnnotationMode.ENABLE_STORAGE,
          background: "rgb(255, 255, 255)",
          canvas: renderCanvas,
          canvasContext: renderContext,
          transform,
          viewport,
        });
        cleanupRender = () => renderTask.cancel();
        await renderTask.promise;
        if (!cancelled) {
          canvas.width = renderCanvas.width;
          canvas.height = renderCanvas.height;
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          const visibleContext = canvas.getContext("2d", { alpha: false });
          if (!visibleContext) {
            throw new Error("Canvas rendering is unavailable.");
          }
          visibleContext.drawImage(renderCanvas, 0, 0);
          hasRenderedPageRef.current = true;
          setRenderState("rendered");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : "Unable to render this page.";
          if (!message.includes("cancelled")) {
            setErrorMessage(message);
            setRenderState("error");
          }
        }
      });

    return () => {
      cancelled = true;
      cleanupRender?.();
    };
  }, [document, onPageSize, pageNumber, renderScale, shouldRender]);

  const effectivePageSize = basePageSize ?? ESTIMATED_PAGE_SIZE;
  const visualPageSize = {
    height: Math.ceil(effectivePageSize.height * visualScale),
    width: Math.ceil(effectivePageSize.width * visualScale),
  };
  const draftBoundingBox = draftSelection
    ? normalizeCssRectToBoundingBox({
        x1: draftSelection.startX,
        y1: draftSelection.startY,
        x2: draftSelection.currentX,
        y2: draftSelection.currentY,
        width: visualPageSize.width,
        height: visualPageSize.height,
      })
    : null;

  const handleAnnotationPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!annotationMode || renderState !== "rendered" || !onAnnotationCapture || event.button !== 0) {
        return;
      }

      const root = pageRootRef.current;
      if (!root) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const rect = root.getBoundingClientRect();
      const startX = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
      const startY = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
      selectionPointerIdRef.current = event.pointerId;
      root.setPointerCapture(event.pointerId);
      setDraftSelection({
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      });
    },
    [annotationMode, onAnnotationCapture, renderState],
  );

  const handleAnnotationPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!annotationMode || selectionPointerIdRef.current !== event.pointerId) {
        return;
      }

      const root = pageRootRef.current;
      if (!root) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const rect = root.getBoundingClientRect();
      const currentX = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
      const currentY = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
      setDraftSelection((current) =>
        current
          ? {
              ...current,
              currentX,
              currentY,
            }
          : current,
      );
    },
    [annotationMode],
  );

  const finishAnnotationSelection = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!annotationMode || selectionPointerIdRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectionPointerIdRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const selection = draftSelection;
      setDraftSelection(null);
      const root = pageRootRef.current;
      const canvas = canvasRef.current;
      if (!selection || !root || !canvas || !onAnnotationCapture) {
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const boundingBox = normalizeCssRectToBoundingBox({
        x1: selection.startX,
        y1: selection.startY,
        x2: selection.currentX,
        y2: selection.currentY,
        width: rootRect.width,
        height: rootRect.height,
      });
      if (boundingBox.width < 0.01 || boundingBox.height < 0.01) {
        return;
      }

      onAnnotationCapture({
        filePath,
        pageNumber,
        boundingBox,
        zoomPercent: Math.round(visualScale * 100),
        screenshotDataUrl: cropCanvasToDataUrl(canvas, boundingBox),
        capturedAt: new Date().toISOString(),
      });
    },
    [annotationMode, draftSelection, filePath, onAnnotationCapture, pageNumber, visualScale],
  );

  return (
    <div
      ref={pageRootRef}
      className="relative max-w-full rounded-md border border-border/55 bg-white shadow-sm transition-[width] duration-150 ease-out"
      style={{
        aspectRatio: `${effectivePageSize.width} / ${effectivePageSize.height}`,
        width: `${visualPageSize.width}px`,
      }}
      onPointerCancel={finishAnnotationSelection}
      onPointerDown={handleAnnotationPointerDown}
      onPointerMove={handleAnnotationPointerMove}
      onPointerUp={finishAnnotationSelection}
    >
      <canvas
        ref={canvasRef}
        aria-label={`Page ${pageNumber}`}
        className={cn(
          "block h-auto w-full rounded-md bg-white transition-opacity duration-150",
          renderState === "rendered" ? "opacity-100" : "opacity-60",
        )}
      />
      {renderState !== "rendered" ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-white/75 text-xs text-muted-foreground/70">
          {renderState === "error"
            ? (errorMessage ?? "Unable to render this page.")
            : renderState === "queued"
              ? "Page preview queued"
              : "Rendering page..."}
        </div>
      ) : null}
      {annotationMarkers.map((marker, markerIndex) => (
        <PdfAnnotationOverlay
          key={marker.id}
          boundingBox={marker.boundingBox}
          label={markerIndex + 1}
        />
      ))}
      {draftBoundingBox ? <PdfAnnotationOverlay boundingBox={draftBoundingBox} /> : null}
    </div>
  );
}

function normalizeCssRectToBoundingBox(input: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}): PdfAnnotationCapture["boundingBox"] {
  const left = Math.max(0, Math.min(input.x1, input.x2));
  const top = Math.max(0, Math.min(input.y1, input.y2));
  const right = Math.min(input.width, Math.max(input.x1, input.x2));
  const bottom = Math.min(input.height, Math.max(input.y1, input.y2));
  return {
    x: left / input.width,
    y: top / input.height,
    width: (right - left) / input.width,
    height: (bottom - top) / input.height,
  };
}

function cropCanvasToDataUrl(
  canvas: HTMLCanvasElement,
  boundingBox: PdfAnnotationCapture["boundingBox"],
): string {
  const sourceX = Math.floor(boundingBox.x * canvas.width);
  const sourceY = Math.floor(boundingBox.y * canvas.height);
  const sourceWidth = Math.max(1, Math.floor(boundingBox.width * canvas.width));
  const sourceHeight = Math.max(1, Math.floor(boundingBox.height * canvas.height));
  const cropCanvas = globalThis.document.createElement("canvas");
  cropCanvas.width = sourceWidth;
  cropCanvas.height = sourceHeight;
  const context = cropCanvas.getContext("2d", { alpha: false });
  if (!context) {
    return canvas.toDataURL("image/png");
  }
  context.drawImage(
    canvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  return cropCanvas.toDataURL("image/png");
}

function PdfAnnotationOverlay(props: {
  boundingBox: PdfAnnotationCapture["boundingBox"];
  label?: number | undefined;
}) {
  return (
    <div
      className="pointer-events-none absolute rounded-[2px] border border-dashed border-blue-500 bg-blue-500/16"
      style={{
        height: `${props.boundingBox.height * 100}%`,
        left: `${props.boundingBox.x * 100}%`,
        top: `${props.boundingBox.y * 100}%`,
        width: `${props.boundingBox.width * 100}%`,
      }}
    >
      {props.label ? (
        <span className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-semibold leading-none text-white shadow-sm">
          {props.label}
        </span>
      ) : null}
    </div>
  );
}
