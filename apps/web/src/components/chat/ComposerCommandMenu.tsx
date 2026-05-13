import type {
  ModelSlug,
  ComputerUseAppSummary,
  ProjectEntry,
  ProviderKind,
  ProviderNativeCommandDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { memo, type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArrowLeftRight,
  BotIcon,
  Brain,
  DiffIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  KanbanSquareIcon,
  MessageSquareIcon,
  BoxIcon,
  MonitorIcon,
  PlugIcon,
  Terminal,
  ZapIcon,
} from "lucide-react";
import { type ComposerTriggerKind, type ComposerSlashCommand } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { getVscodeIconUrlForEntry } from "../../vscode-icons";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "desktop-app";
      app: ComputerUseAppSummary;
      label: string;
      description: string;
      iconUrl?: string | null | undefined;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-native-command";
      provider: ProviderKind;
      command: ProviderNativeCommandDescriptor["name"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ProviderSkillDescriptor;
      label: string;
      description: string;
      iconUrl?: string | undefined;
    }
  | {
      id: string;
      type: "plugin";
      plugin: ProviderPluginDescriptor;
      label: string;
      description: string;
      iconUrl?: string | undefined;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      model: ModelSlug;
      label: string;
      description: string;
      showFastBadge: boolean;
    };

type ComposerCommandGroupModel = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

function humanizeSlashCommandName(command: string): string {
  return command
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function commandMenuTitle(
  item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-native-command" }>,
): string {
  switch (item.command) {
    case "model":
      return "Model";
    case "plan":
      return "Plan Mode";
    case "default":
      return "Default Mode";
    case "review":
      return "Code Review";
    case "status":
      return "Status";
    case "browser":
      return "T3 Browser";
    case "fork":
      return "Fork";
    case "fast":
      return "Fast Mode";
    case "init":
    case "agentmd":
    case "agent-md":
    case "agentsmd":
    case "agents":
      return "Agents.md";
    default:
      return humanizeSlashCommandName(item.command);
  }
}

function resolveSlashLikeCommandIcon(commandName: string): ReactElement {
  const normalized = commandName.trim().toLowerCase();
  const className = "size-3.5 text-muted-foreground/60";

  switch (normalized) {
    case "model":
    case "reasoning":
      return <Brain className={className} />;
    case "plan":
    case "plan-mode":
    case "planmode":
    case "plan mode":
      return <KanbanSquareIcon className={className} />;
    case "default":
      return <BotIcon className={className} />;
    case "review":
    case "code-review":
    case "codereview":
    case "code review":
      return <DiffIcon className={className} />;
    case "status":
      return <ActivityIcon className={className} />;
    case "browser":
      return <GlobeIcon className={className} />;
    case "fork":
    case "handoff":
      return <ArrowLeftRight className={className} />;
    case "fast":
      return <ZapIcon className={className} />;
    case "feedback":
      return <MessageSquareIcon className={className} />;
    case "init":
    case "agentmd":
    case "agent-md":
    case "agentsmd":
    case "agents":
      return <FileTextIcon className={className} />;
    case "cloud":
      return <GlobeIcon className={className} />;
    case "mcp":
      return <PlugIcon className={className} />;
    case "personality":
      return <BotIcon className={className} />;
    default:
      return <Terminal className={className} />;
  }
}

function groupComposerCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
): ComposerCommandGroupModel[] {
  if (triggerKind === "path") {
    const pathItems = items.filter((item) => item.type === "path");
    const appItems = items.filter((item) => item.type === "desktop-app");
    const pluginItems = items.filter((item) => item.type === "plugin");
    const skillItems = items.filter((item) => item.type === "skill");
    const groups: ComposerCommandGroupModel[] = [];
    if (pathItems.length > 0) {
      groups.push({ id: "paths", label: "Files and folders", items: pathItems });
    }
    if (appItems.length > 0) {
      groups.push({ id: "desktop-apps", label: "Desktop apps", items: appItems });
    }
    if (pluginItems.length > 0) {
      groups.push({ id: "plugins", label: "Plugins", items: pluginItems });
    }
    if (skillItems.length > 0) {
      groups.push({ id: "skills", label: "Skills", items: skillItems });
    }
    return groups;
  }

  if (triggerKind !== "slash-command") {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-native-command");
  const otherItems = items.filter(
    (item) => item.type !== "slash-command" && item.type !== "provider-native-command",
  );

  const groups: ComposerCommandGroupModel[] = [];
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  if (otherItems.length > 0) {
    groups.push({ id: "other", label: null, items: otherItems });
  }
  return groups;
}

const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );
  const failed = failedIconUrl === iconUrl;

  if (failed) {
    return props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 text-muted-foreground/80", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 text-muted-foreground/80", props.className)} />
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={cn("size-4 shrink-0", props.className)}
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
});

const ProviderExtensionIcon = memo(function ProviderExtensionIcon(props: {
  kind: "plugin" | "skill";
  iconUrl?: string | undefined;
  className?: string;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const failed = props.iconUrl !== undefined && failedIconUrl === props.iconUrl;
  const Icon = props.kind === "plugin" ? PlugIcon : BoxIcon;

  if (props.iconUrl && !failed) {
    return (
      <img
        src={props.iconUrl}
        alt=""
        aria-hidden="true"
        className={cn("size-4 shrink-0 object-contain", props.className)}
        loading="lazy"
        draggable={false}
        onError={() => setFailedIconUrl(props.iconUrl ?? null)}
      />
    );
  }

  return <Icon className={cn("size-4 text-muted-foreground", props.className)} />;
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  itemRef: (node: HTMLElement | null) => void;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const icon = (() => {
    switch (props.item.type) {
      case "path":
        return (
          <VscodeEntryIcon
            pathValue={props.item.path}
            kind={props.item.pathKind}
            theme={props.resolvedTheme}
            className="size-4 text-muted-foreground"
          />
        );
      case "desktop-app":
        return props.item.iconUrl ? (
          <img
            src={props.item.iconUrl}
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0 rounded-sm object-contain"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <MonitorIcon className="size-4 text-muted-foreground" />
        );
      case "slash-command":
      case "provider-native-command":
        return resolveSlashLikeCommandIcon(props.item.command);
      case "skill":
        return <ProviderExtensionIcon kind="skill" iconUrl={props.item.iconUrl} />;
      case "plugin":
        return <ProviderExtensionIcon kind="plugin" iconUrl={props.item.iconUrl} />;
      case "model":
        return <Brain className="size-4 text-muted-foreground" />;
      default:
        return null;
    }
  })();

  return (
    <CommandItem
      ref={props.itemRef}
      value={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-2.5 py-1 transition-colors",
        "hover:bg-accent/40 data-highlighted:bg-accent/40 data-highlighted:text-accent-foreground",
        props.isActive && "bg-accent/40 text-accent-foreground",
      )}
      onMouseMove={() => {
        if (!props.isActive) {
          props.onHighlight(props.item.id);
        }
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      <span className="flex shrink-0 text-muted-foreground/60">{icon}</span>

      <div className="min-w-0 flex flex-1 items-center gap-2">
        <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">
            {props.item.type === "slash-command" || props.item.type === "provider-native-command"
              ? commandMenuTitle(props.item)
              : props.item.label}
          </span>
          {props.item.description && (
            <span className="truncate text-[11px] text-muted-foreground/55">
              {props.item.description}
            </span>
          )}
        </div>
        {(props.item.type === "slash-command" || props.item.type === "provider-native-command") && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground/45">
            /{props.item.command}
          </span>
        )}
      </div>

      {props.item.type === "model" && (
        <Badge variant="outline" className="px-1 py-0 text-[9px]">
          model
        </Badge>
      )}
      {props.item.type === "plugin" && (
        <Badge variant="outline" className="px-1 py-0 text-[9px]">
          plugin
        </Badge>
      )}
    </CommandItem>
  );
});

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const groups = useMemo(
    () => groupComposerCommandItems(props.items, props.triggerKind),
    [props.items, props.triggerKind],
  );

  useEffect(() => {
    if (!props.activeItemId) {
      return;
    }

    itemRefs.current[props.activeItemId]?.scrollIntoView({
      block: "nearest",
    });
  }, [props.activeItemId]);

  return (
    <Command
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]">
        <CommandList className="max-h-72 py-1">
          {groups.map((group, index) => (
            <div key={group.id}>
              {index > 0 ? <CommandSeparator className="my-0.5" /> : null}
              <CommandGroup>
                {group.label ? (
                  <CommandGroupLabel className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
                    {group.label}
                  </CommandGroupLabel>
                ) : null}
                {group.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    item={item}
                    resolvedTheme={props.resolvedTheme}
                    isActive={props.activeItemId === item.id}
                    itemRef={(node) => {
                      itemRefs.current[item.id] = node;
                    }}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            </div>
          ))}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground/50">
            {props.isLoading
              ? props.triggerKind === "path"
                ? "Searching mentions..."
                : "Loading commands..."
              : props.triggerKind === "path"
                ? "No matching files, apps, plugins, or skills."
                : props.triggerKind === "skill"
                  ? "No matching skill."
                  : "No matching command."}
          </p>
        )}
      </div>
    </Command>
  );
});
