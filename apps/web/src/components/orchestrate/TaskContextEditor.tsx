import type { ProjectEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Command, CommandItem, CommandList } from "~/components/ui/command";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImagePlusIcon, XIcon } from "lucide-react";

import {
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "~/composer-logic";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { Button } from "~/components/ui/button";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { basenameOfPath, getVscodeIconUrlForEntry } from "~/vscode-icons";
import {
  TASK_CONTEXT_IMAGE_SIZE_LIMIT_LABEL,
  type TaskDraftImageAttachment,
  createTaskDraftImageAttachments,
  revokeTaskDraftAttachmentPreviewUrl,
} from "./taskContextAttachments";

type TaskContextCommandItem = {
  id: string;
  path: string;
  pathKind: ProjectEntry["kind"];
  label: string;
  description: string;
};

function resolveThemeFromDocument(): "light" | "dark" {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function TaskContextCommandMenuItem(props: {
  readonly item: TaskContextCommandItem;
  readonly resolvedTheme: "light" | "dark";
  readonly isActive: boolean;
  readonly onSelect: (item: TaskContextCommandItem) => void;
}) {
  return (
    <CommandItem
      value={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 py-1.5",
        props.isActive && "bg-accent text-accent-foreground",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      <img
        alt=""
        aria-hidden="true"
        className="size-4 shrink-0 opacity-85"
        loading="lazy"
        src={getVscodeIconUrlForEntry(props.item.path, props.item.pathKind, props.resolvedTheme)}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{props.item.label}</span>
        <span className="truncate text-xs text-muted-foreground/72">{props.item.description}</span>
      </span>
    </CommandItem>
  );
}

export function TaskContextEditor(props: {
  readonly workspaceRoot: string | null;
  readonly value: string;
  readonly cursor: number;
  readonly attachments: ReadonlyArray<TaskDraftImageAttachment>;
  readonly disabled?: boolean;
  readonly placeholder: string;
  readonly onChange: (nextValue: string, nextCursor: number) => void;
  readonly onAttachmentsChange: (nextAttachments: Array<TaskDraftImageAttachment>) => void;
  readonly onError: (message: string) => void;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef(props.value);
  const menuItemsRef = useRef<TaskContextCommandItem[]>([]);
  const highlightedItemRef = useRef<TaskContextCommandItem | null>(null);
  const selectLockRef = useRef(false);
  const dragDepthRef = useRef(0);

  const [trigger, setTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(props.value, props.value.length),
  );
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const promptCursor = props.cursor;
  const promptValue = props.value;

  useEffect(() => {
    promptRef.current = promptValue;
  }, [promptValue]);

  useEffect(() => {
    setTrigger((current) => {
      const nextTrigger = detectComposerTrigger(
        promptValue,
        expandCollapsedComposerCursor(promptValue, promptCursor),
      );
      if (
        current?.kind === nextTrigger?.kind &&
        current?.query === nextTrigger?.query &&
        current?.rangeStart === nextTrigger?.rangeStart &&
        current?.rangeEnd === nextTrigger?.rangeEnd
      ) {
        return current;
      }
      return nextTrigger;
    });
  }, [promptCursor, promptValue]);

  const pathTriggerQuery = trigger?.kind === "path" ? trigger.query : "";
  const isPathTrigger = trigger?.kind === "path";
  const [debouncedPathQuery, pathQueryDebouncer] = useDebouncedValue(pathTriggerQuery, {
    wait: 120,
  });
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.workspaceRoot,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? [];
  const menuItems = useMemo<Array<TaskContextCommandItem>>(
    () =>
      workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      })),
    [workspaceEntries],
  );

  useEffect(() => {
    menuItemsRef.current = menuItems;
    const nextHighlighted =
      menuItems.find((item) => item.id === highlightedItemId) ?? menuItems[0] ?? null;
    highlightedItemRef.current = nextHighlighted;
    if (nextHighlighted?.id !== highlightedItemId) {
      setHighlightedItemId(nextHighlighted?.id ?? null);
    }
  }, [highlightedItemId, menuItems]);

  const resolvedTheme = resolveThemeFromDocument();
  const isMenuLoading =
    isPathTrigger &&
    ((pathTriggerQuery.length > 0 && pathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const applyPromptReplacement = useCallback(
    (rangeStart: number, rangeEnd: number, replacement: string, options?: { expectedText?: string }) => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }

      const next = replaceTextRange(currentText, safeStart, safeEnd, replacement);
      promptRef.current = next.text;
      props.onChange(next.text, next.cursor);
      setTrigger(detectComposerTrigger(next.text, next.cursor));
      window.requestAnimationFrame(() => {
        editorRef.current?.focusAt(next.cursor);
      });
      return true;
    },
    [props],
  );

  const readEditorSnapshot = useCallback(() => {
    return editorRef.current?.readSnapshot() ?? { value: promptRef.current, cursor: promptCursor };
  }, [promptCursor]);

  const resolveActiveTrigger = useCallback(() => {
    const snapshot = readEditorSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(
        snapshot.value,
        expandCollapsedComposerCursor(snapshot.value, snapshot.cursor),
      ),
    };
  }, [readEditorSnapshot]);

  const onSelectMenuItem = useCallback(
    (item: TaskContextCommandItem) => {
      if (selectLockRef.current) {
        return;
      }
      selectLockRef.current = true;
      window.requestAnimationFrame(() => {
        selectLockRef.current = false;
      });

      const { snapshot, trigger: activeTrigger } = resolveActiveTrigger();
      if (!activeTrigger || activeTrigger.kind !== "path") {
        return;
      }
      const expectedToken = snapshot.value.slice(activeTrigger.rangeStart, activeTrigger.rangeEnd);
      const applied = applyPromptReplacement(
        activeTrigger.rangeStart,
        activeTrigger.rangeEnd,
        `@${item.path} `,
        { expectedText: expectedToken },
      );
      if (applied) {
        setHighlightedItemId(null);
      }
    },
    [applyPromptReplacement, resolveActiveTrigger],
  );

  const nudgeHighlightedItem = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (menuItems.length === 0) {
        return;
      }
      const highlightedIndex = menuItems.findIndex((item) => item.id === highlightedItemId);
      const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex = (normalizedIndex + offset + menuItems.length) % menuItems.length;
      setHighlightedItemId(menuItems[nextIndex]?.id ?? null);
    },
    [highlightedItemId, menuItems],
  );

  const onCommandKeyDown = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Backspace", event: KeyboardEvent) => {
      if (key === "Backspace") {
        return false;
      }
      const { trigger: activeTrigger } = resolveActiveTrigger();
      const menuIsActive =
        activeTrigger?.kind === "path" && (menuItemsRef.current.length > 0 || isMenuLoading);

      if (!menuIsActive) {
        return false;
      }

      if (key === "ArrowDown" && menuItemsRef.current.length > 0) {
        nudgeHighlightedItem("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && menuItemsRef.current.length > 0) {
        nudgeHighlightedItem("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = highlightedItemRef.current ?? menuItemsRef.current[0];
        if (selectedItem) {
          onSelectMenuItem(selectedItem);
          return true;
        }
      }
      if (key === "Tab") {
        event.preventDefault();
        return true;
      }
      return false;
    },
    [isMenuLoading, nudgeHighlightedItem, onSelectMenuItem, resolveActiveTrigger],
  );

  const appendImageFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return;
      }
      const next = createTaskDraftImageAttachments({
        files,
        existingCount: props.attachments.length,
      });

      if (next.attachments.length > 0) {
        props.onAttachmentsChange([...props.attachments, ...next.attachments]);
      }
      if (next.error) {
        props.onError(next.error);
      }
    },
    [props],
  );

  const onPaste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      appendImageFiles(files);
    },
    [appendImageFiles],
  );

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      appendImageFiles(Array.from(event.dataTransfer.files));
    },
    [appendImageFiles],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      const removed = props.attachments.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeTaskDraftAttachmentPreviewUrl(removed);
      }
      props.onAttachmentsChange(props.attachments.filter((attachment) => attachment.id !== attachmentId));
    },
    [props],
  );

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/80 bg-muted/15 transition-colors",
        isDragOver && "border-primary/70 bg-accent/25",
        props.disabled && "opacity-70",
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isPathTrigger ? (
        <div className="border-b border-border/65 px-2.5 py-2">
          <Command
            mode="none"
            onItemHighlighted={(value) => {
              setHighlightedItemId(typeof value === "string" ? value : null);
            }}
          >
            <div className="relative overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs">
              <CommandList className="max-h-56">
                {menuItems.map((item) => (
                  <TaskContextCommandMenuItem
                    key={item.id}
                    item={item}
                    resolvedTheme={resolvedTheme}
                    isActive={highlightedItemId === item.id}
                    onSelect={onSelectMenuItem}
                  />
                ))}
                {isMenuLoading ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
                ) : null}
                {!isMenuLoading && menuItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
                ) : null}
              </CommandList>
            </div>
          </Command>
        </div>
      ) : null}

      {props.attachments.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {props.attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group/attachment relative size-18 shrink-0 overflow-hidden rounded-xl border border-border/75 bg-background"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
                  {attachment.name}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-1 top-1 bg-background/88 opacity-0 transition group-hover/attachment:opacity-100"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2 px-2.5 py-2.5">
        <div className="min-w-0 flex-1">
          <ComposerPromptEditor
            ref={editorRef}
            value={promptValue}
            cursor={promptCursor}
            disabled={props.disabled ?? false}
            placeholder={props.placeholder}
            className="max-h-[160px] min-h-[72px] text-[13px] leading-[1.45]"
            onChange={(nextValue, nextCursor, cursorAdjacentToMention) => {
              promptRef.current = nextValue;
              props.onChange(nextValue, nextCursor);
              setTrigger(
                cursorAdjacentToMention
                  ? null
                  : detectComposerTrigger(
                      nextValue,
                      expandCollapsedComposerCursor(nextValue, nextCursor),
                    ),
              );
            }}
            onCommandKeyDown={onCommandKeyDown}
            onPaste={onPaste}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              appendImageFiles(files);
              event.currentTarget.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label={`Attach images up to ${TASK_CONTEXT_IMAGE_SIZE_LIMIT_LABEL}`}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlusIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
