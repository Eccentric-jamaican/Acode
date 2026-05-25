import { memo, useEffect } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";

export interface ExpandedImageItem {
  src: string;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string;
    type?: "image" | "pdf";
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.type === "pdf" || !image.previewUrl
      ? []
      : [{ id: image.id, src: image.previewUrl, name: image.name }],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({ src: image.src, name: image.name })),
    index: selectedIndex,
  };
}

export const ExpandedImagePreview = memo(function ExpandedImagePreviewDialog(props: {
  preview: ExpandedImagePreview | null;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
}) {
  const { preview, onClose, onNavigate } = props;

  useEffect(() => {
    if (!preview) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNavigate, preview]);

  const previewItem = preview ? preview.images[preview.index] : null;
  if (!preview || !previewItem) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => {
            onNavigate(-1);
          }}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={previewItem.src}
          alt={previewItem.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {previewItem.name}
          {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => {
            onNavigate(1);
          }}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
