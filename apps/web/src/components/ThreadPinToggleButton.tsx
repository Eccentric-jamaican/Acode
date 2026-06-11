import type React from "react";
import { PinIcon } from "lucide-react";
import { cn } from "../lib/utils";

export function ThreadPinToggleButton(props: {
  pinned: boolean;
  presentation: "overlay" | "inline";
  toneClassName?: string;
  onToggle: (event: React.MouseEvent<HTMLButtonElement> | React.MouseEvent) => void;
}) {
  const label = props.pinned ? "Unpin thread" : "Pin thread";

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={props.pinned}
      title={label}
      className={cn(
        "pointer-events-auto inline-flex size-5 items-center justify-center rounded-md transition-all hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        props.toneClassName ?? "text-muted-foreground/34",
        props.presentation === "overlay"
          ? cn(
              "absolute left-[18px] top-1/2 z-30 -translate-y-1/2",
              props.pinned
                ? "opacity-100"
                : "opacity-0 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100",
            )
          : "relative z-10 shrink-0",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={props.onToggle}
    >
      <PinIcon className="size-3.5" />
    </button>
  );
}
