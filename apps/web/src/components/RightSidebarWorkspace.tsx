import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from "react";
import { Maximize2Icon, Minimize2Icon, PanelRightCloseIcon, PlusIcon, XIcon } from "lucide-react";

import type { ChatRightPanel } from "../diffRouteSearch";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

export type RightSidebarWorkspaceTabId = Exclude<ChatRightPanel, "picker">;
const BROWSER_NATIVE_OVERLAY_BLOCK_EVENT = "t3code:browser-native-overlay-block";

export interface RightSidebarWorkspaceTab {
  id: RightSidebarWorkspaceTabId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  keepMounted?: boolean;
  render: () => ReactNode;
}

interface RightSidebarWorkspaceProps {
  activeTab: ChatRightPanel;
  tabs: ReadonlyArray<RightSidebarWorkspaceTab>;
  onSelectTab: (tab: RightSidebarWorkspaceTabId) => void;
  onOpenPicker: () => void;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  className?: string;
}

export default function RightSidebarWorkspace(props: RightSidebarWorkspaceProps) {
  const tabsById = useMemo(() => new Map(props.tabs.map((tab) => [tab.id, tab])), [props.tabs]);
  const [openTabIds, setOpenTabIds] = useState<RightSidebarWorkspaceTabId[]>(() =>
    isWorkspaceTabId(props.activeTab) ? [props.activeTab] : [],
  );
  const [draggedTabId, setDraggedTabId] = useState<RightSidebarWorkspaceTabId | null>(null);
  const [addTabMenuOpen, setAddTabMenuOpen] = useState(false);
  const activeTab = tabsById.get(props.activeTab as RightSidebarWorkspaceTabId) ?? null;
  const showingPicker = props.activeTab === "picker";
  const openTabs = openTabIds.map((id) => tabsById.get(id)).filter(isDefined);
  const hiddenTabs = props.tabs.filter((tab) => !openTabIds.includes(tab.id));
  const mountedTabs = openTabs.filter(
    (tab) => tab.keepMounted !== false || (!showingPicker && props.activeTab === tab.id),
  );
  const renderedTabs =
    !showingPicker && activeTab && !mountedTabs.some((tab) => tab.id === activeTab.id)
      ? [...mountedTabs, activeTab]
      : mountedTabs;

  useEffect(() => {
    setOpenTabIds((currentIds) => {
      const validIds = currentIds.filter((id) => tabsById.has(id));
      if (!isWorkspaceTabId(props.activeTab) || validIds.includes(props.activeTab)) {
        return arraysEqual(validIds, currentIds) ? currentIds : validIds;
      }
      return [...validIds, props.activeTab];
    });
  }, [props.activeTab, tabsById]);

  useEffect(() => {
    const blocked = addTabMenuOpen && props.activeTab === "browser";
    window.dispatchEvent(
      new CustomEvent(BROWSER_NATIVE_OVERLAY_BLOCK_EVENT, { detail: { blocked } }),
    );
    return () => {
      if (blocked) {
        window.dispatchEvent(
          new CustomEvent(BROWSER_NATIVE_OVERLAY_BLOCK_EVENT, { detail: { blocked: false } }),
        );
      }
    };
  }, [addTabMenuOpen, props.activeTab]);

  const addTab = (tabId: RightSidebarWorkspaceTabId) => {
    setOpenTabIds((currentIds) =>
      currentIds.includes(tabId) ? currentIds : [...currentIds, tabId],
    );
    props.onSelectTab(tabId);
  };

  const closeTab = (tabId: RightSidebarWorkspaceTabId) => {
    const closedIndex = openTabIds.indexOf(tabId);
    const nextOpenTabIds = openTabIds.filter((id) => id !== tabId);
    setOpenTabIds(nextOpenTabIds);

    if (props.activeTab !== tabId) {
      return;
    }

    const nextActiveTab = nextOpenTabIds[Math.min(closedIndex, nextOpenTabIds.length - 1)] ?? null;
    if (nextActiveTab) {
      props.onSelectTab(nextActiveTab);
      return;
    }
    props.onOpenPicker();
  };

  const moveTab = (sourceId: RightSidebarWorkspaceTabId, targetId: RightSidebarWorkspaceTabId) => {
    if (sourceId === targetId) return;
    setOpenTabIds((currentIds) => {
      const sourceIndex = currentIds.indexOf(sourceId);
      const targetIndex = currentIds.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return currentIds;
      const nextIds = currentIds.filter((id) => id !== sourceId);
      nextIds.splice(targetIndex, 0, sourceId);
      return nextIds;
    });
  };

  const handleTabDrop = (
    event: DragEvent<HTMLDivElement>,
    targetId: RightSidebarWorkspaceTabId,
  ) => {
    event.preventDefault();
    const sourceId = parseWorkspaceTabId(event.dataTransfer.getData("text/plain")) ?? draggedTabId;
    if (sourceId) {
      moveTab(sourceId, targetId);
    }
    setDraggedTabId(null);
  };

  return (
    <section
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-background text-foreground",
        props.className,
      )}
    >
      <div className="flex h-[var(--app-desktop-content-header-height)] shrink-0 items-center justify-between gap-2 border-b border-border/55 bg-background/95 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {openTabs.map(({ id, label, Icon }) => (
            <div
              key={id}
              className={cn(
                "group/tab flex h-7 shrink-0 cursor-grab select-none items-center rounded-md border transition-colors active:cursor-grabbing",
                props.activeTab === id
                  ? "border-border/70 bg-muted/60 text-foreground shadow-[inset_0_1px_0_hsl(var(--background)/0.72)]"
                  : "border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground",
                draggedTabId === id ? "scale-[0.98] opacity-60" : "",
              )}
              draggable
              onDragEnd={() => setDraggedTabId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDragStart={(event) => {
                setDraggedTabId(id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", id);
              }}
              onDrop={(event) => handleTabDrop(event, id)}
            >
              <button
                type="button"
                className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md py-0 pl-2.5 pr-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={label === "Open file" ? "Open file" : `Open ${label}`}
                onClick={() => props.onSelectTab(id)}
              >
                <Icon
                  className={cn(
                    "size-3.5 shrink-0",
                    props.activeTab === id ? "text-foreground/90" : "text-muted-foreground",
                  )}
                />
                <span className="max-w-32 truncate">{label}</span>
              </button>
              <button
                type="button"
                className={cn(
                  "mr-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  "opacity-0 group-hover/tab:opacity-80 focus-visible:opacity-80",
                )}
                aria-label={`Close ${label} tab`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(id);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
          <Menu onOpenChange={setAddTabMenuOpen}>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant={showingPicker ? "outline" : "ghost"}
                  className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/42 hover:text-foreground"
                  aria-label="Add right sidebar tab"
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              }
            />
            <MenuPopup align="start" className="min-w-48">
              {hiddenTabs.length > 0 ? (
                hiddenTabs.map(({ id, label, Icon }) => (
                  <MenuItem key={id} onClick={() => addTab(id)}>
                    <Icon className="size-4" />
                    <span className="min-w-0 flex-1">{label}</span>
                  </MenuItem>
                ))
              ) : (
                <MenuItem disabled>All tabs are open</MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.onToggleExpanded ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label={
                props.expanded
                  ? "Collapse right sidebar workspace"
                  : "Expand right sidebar workspace"
              }
              title={
                props.expanded
                  ? "Collapse right sidebar workspace"
                  : "Expand right sidebar workspace"
              }
              onClick={props.onToggleExpanded}
            >
              {props.expanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
            aria-label="Collapse right sidebar workspace"
            title="Collapse right sidebar workspace"
            onClick={props.onClose}
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {showingPicker ? (
          <RightSidebarWorkspacePicker
            tabs={hiddenTabs.length > 0 ? hiddenTabs : props.tabs}
            onSelectTab={addTab}
          />
        ) : activeTab === null ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-sm text-muted-foreground">
            Choose a workspace tab.
          </div>
        ) : null}
        {renderedTabs.map((tab) => (
          <div
            aria-hidden={showingPicker || props.activeTab !== tab.id}
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-hidden",
              !showingPicker && props.activeTab === tab.id ? "flex" : "hidden",
            )}
            key={tab.id}
          >
            {tab.render()}
          </div>
        ))}
      </div>
    </section>
  );
}

function isWorkspaceTabId(value: ChatRightPanel): value is RightSidebarWorkspaceTabId {
  return value !== "picker";
}

function parseWorkspaceTabId(value: string): RightSidebarWorkspaceTabId | null {
  if (
    value === "diff" ||
    value === "terminal" ||
    value === "browser" ||
    value === "files" ||
    value === "side-chat"
  ) {
    return value;
  }
  return null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function RightSidebarWorkspacePicker(props: {
  tabs: ReadonlyArray<RightSidebarWorkspaceTab>;
  onSelectTab: (tab: RightSidebarWorkspaceTabId) => void;
}) {
  return (
    <div className="grid h-full min-h-0 w-full place-items-center px-6">
      <div className="w-[min(18rem,100%)] space-y-1.5">
        {props.tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="flex h-12 w-full items-center gap-3 rounded-md border border-border/35 bg-card/55 px-3 text-left text-sm text-foreground transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => props.onSelectTab(id)}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
