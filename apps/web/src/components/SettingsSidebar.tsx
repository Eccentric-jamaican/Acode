import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BrushIcon,
  KeyboardIcon,
  LockIcon,
  MessageSquareTextIcon,
  MousePointer2Icon,
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
    case SETTINGS_SECTION_IDS.codexAppServer:
      return Settings2Icon;
    case SETTINGS_SECTION_IDS.models:
      return SlidersHorizontalIcon;
    case SETTINGS_SECTION_IDS.responses:
      return MessageSquareTextIcon;
    case SETTINGS_SECTION_IDS.computerUse:
      return MousePointer2Icon;
    case SETTINGS_SECTION_IDS.keybindings:
      return KeyboardIcon;
    case SETTINGS_SECTION_IDS.safety:
      return LockIcon;
    case SETTINGS_SECTION_IDS.archived:
      return ArchiveIcon;
    default:
      return Settings2Icon;
  }
}

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
        <div className="flex h-full items-center">
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
        <SidebarContent className="min-h-0 flex-1 px-3 pb-3 pt-3">
          <SidebarGroup className="gap-2 p-0">
            <SidebarMenu>
              {SETTINGS_SIDEBAR_SECTIONS.map((section) => {
                const Icon = settingsSectionIcon(section.id);
                return (
                  <SidebarMenuItem key={section.id}>
                    <SidebarMenuButton
                      render={
                        <button type="button" data-testid={`settings-sidebar-item-${section.id}`} />
                      }
                      isActive={activeSection === section.id}
                      className={cn(
                        "h-9 gap-3 rounded-md px-3 text-[13px] font-normal text-foreground/85",
                        "hover:bg-accent/70 data-[active=true]:bg-accent data-[active=true]:text-foreground",
                      )}
                      onClick={() => handleOpenSection(section.id)}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground/75" />
                      <span>{section.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </div>

      <SidebarFooter className="p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" data-testid="settings-sidebar-back-to-chat" />}
              className={cn(
                "h-9 gap-3 rounded-md px-3 text-[13px] font-normal text-foreground/85",
                "hover:bg-accent/70",
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
