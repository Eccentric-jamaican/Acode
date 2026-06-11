import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BrushIcon,
  GlobeIcon,
  KeyboardIcon,
  LockIcon,
  MessageSquareTextIcon,
  MousePointer2Icon,
  PlugIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useCallback } from "react";

import { cn } from "../lib/utils";
import {
  normalizeSettingsSectionId,
  SETTINGS_SECTION_IDS,
  SETTINGS_SIDEBAR_SECTIONS,
  type SettingsSectionId,
} from "../settingsSections";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

function settingsSectionIcon(sectionId: SettingsSectionId) {
  switch (sectionId) {
    case SETTINGS_SECTION_IDS.appearance:
      return BrushIcon;
    case SETTINGS_SECTION_IDS.models:
      return SlidersHorizontalIcon;
    case SETTINGS_SECTION_IDS.remoteAccess:
      return GlobeIcon;
    case SETTINGS_SECTION_IDS.responses:
      return MessageSquareTextIcon;
    case SETTINGS_SECTION_IDS.computerUse:
      return MousePointer2Icon;
    case SETTINGS_SECTION_IDS.keybindings:
      return KeyboardIcon;
    case SETTINGS_SECTION_IDS.safety:
      return LockIcon;
    case SETTINGS_SECTION_IDS.providers:
      return PlugIcon;
    case SETTINGS_SECTION_IDS.archived:
      return ArchiveIcon;
    default:
      return Settings2Icon;
  }
}

const SETTINGS_SIDEBAR_GROUPS: ReadonlyArray<{
  label: string;
  sectionIds: ReadonlyArray<SettingsSectionId>;
}> = [
  {
    label: "Workspace",
    sectionIds: [
      SETTINGS_SECTION_IDS.appearance,
      SETTINGS_SECTION_IDS.responses,
      SETTINGS_SECTION_IDS.keybindings,
    ],
  },
  {
    label: "Agents",
    sectionIds: [SETTINGS_SECTION_IDS.models, SETTINGS_SECTION_IDS.providers],
  },
  {
    label: "Access",
    sectionIds: [
      SETTINGS_SECTION_IDS.remoteAccess,
      SETTINGS_SECTION_IDS.browserUse,
      SETTINGS_SECTION_IDS.computerUse,
    ],
  },
  {
    label: "Guardrails",
    sectionIds: [SETTINGS_SECTION_IDS.safety, SETTINGS_SECTION_IDS.archived],
  },
];

const SETTINGS_SECTION_BY_ID = new Map(
  SETTINGS_SIDEBAR_SECTIONS.map((section) => [section.id, section] as const),
);

export default function SettingsSidebar() {
  const navigate = useNavigate();
  const activeSection = useRouterState({
    select: (state) => normalizeSettingsSectionId(state.location.search.section),
  });

  const handleOpenSection = useCallback(
    (sectionId: SettingsSectionId) => {
      void navigate({ to: "/settings", search: { section: sectionId } });
    },
    [navigate],
  );

  return (
    <>
      <SidebarHeader
        className="h-[var(--app-desktop-content-header-height)] px-4 py-0"
        data-testid="settings-sidebar-top-header"
      >
        <div className="flex h-full items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent/45 text-muted-foreground">
            <Settings2Icon className="size-3.5" />
          </span>
          <span className="text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
            Settings
          </span>
        </div>
      </SidebarHeader>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-sidebar="content"
        data-slot="sidebar-content"
        data-testid="settings-sidebar"
      >
        <SidebarContent className="min-h-0 flex-1 px-3 pb-3 pt-2">
          <SidebarGroup className="gap-4 p-0">
            {SETTINGS_SIDEBAR_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1.5">
                <div className="px-3 text-[10px] font-medium tracking-[0.14em] text-muted-foreground/45 uppercase">
                  {group.label}
                </div>
                <SidebarMenu className="gap-0.5">
                  {group.sectionIds.map((sectionId) => {
                    const section = SETTINGS_SECTION_BY_ID.get(sectionId);
                    if (!section) return null;
                    const Icon = settingsSectionIcon(section.id);
                    const isActive = activeSection === section.id;
                    return (
                      <SidebarMenuItem key={section.id}>
                        <SidebarMenuButton
                          render={
                            <button
                              type="button"
                              data-testid={`settings-sidebar-item-${section.id}`}
                            />
                          }
                          isActive={isActive}
                          className={cn(
                            "relative h-8 cursor-pointer gap-3 rounded-md px-3 pl-4 text-[13px] font-normal text-foreground/78",
                            "hover:bg-accent/45 hover:text-foreground",
                            "data-[active=true]:bg-accent/55 data-[active=true]:text-foreground",
                            isActive && "font-medium",
                          )}
                          onClick={() => handleOpenSection(section.id)}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute left-1 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity",
                              isActive && "opacity-100",
                            )}
                          />
                          <Icon
                            className={cn(
                              "size-4 shrink-0 transition-colors",
                              isActive ? "text-foreground/90" : "text-muted-foreground/62",
                            )}
                          />
                          <span className="truncate">{section.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}
          </SidebarGroup>
        </SidebarContent>
      </div>

      <SidebarFooter className="border-t border-border/35 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" data-testid="settings-sidebar-back-to-chat" />}
              className={cn(
                "h-9 cursor-pointer gap-3 rounded-md px-3 text-[13px] font-normal text-muted-foreground",
                "hover:bg-accent/45 hover:text-foreground",
              )}
            >
              <ArrowLeftIcon className="size-4 shrink-0 text-muted-foreground/75" />
              <span>Back to chats</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
