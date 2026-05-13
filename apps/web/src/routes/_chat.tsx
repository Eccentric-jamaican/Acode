import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef } from "react";

import DesktopShellTitlebarBand from "../components/DesktopShellTitlebarBand";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import SettingsSidebar from "../components/SettingsSidebar";
import ThreadSidebar from "../components/Sidebar";
import { emitToggleSidebarSearchPalette } from "../lib/sidebarSearchPalette";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { SETTINGS_SECTION_IDS } from "../settingsSections";
import { useSidebar } from "~/components/ui/sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function ChatRouteGlobalShortcuts() {
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
        },
      });
      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        emitToggleSidebarSearchPalette();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [keybindings, toggleSidebar]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "toggle-sidebar") {
        toggleSidebar();
        return;
      }
      if (action !== "open-settings") return;
      void navigate({
        to: "/settings",
        search: { section: SETTINGS_SECTION_IDS.appearance },
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, toggleSidebar]);

  return null;
}

function ChatRouteSidebarSync({ collapseSidebar }: { collapseSidebar: boolean }) {
  const { open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const previousCollapseSidebarRef = useRef(collapseSidebar);

  useEffect(() => {
    const enteredCollapsedRoute = collapseSidebar && !previousCollapseSidebarRef.current;
    previousCollapseSidebarRef.current = collapseSidebar;
    if (!enteredCollapsedRoute) return;
    if (open) void setOpen(false);
    if (openMobile) setOpenMobile(false);
  }, [collapseSidebar, open, openMobile, setOpen, setOpenMobile]);

  return null;
}

function ChatRouteLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isThreadRoute =
    pathname.startsWith("/") &&
    !pathname.startsWith("/settings") &&
    !pathname.startsWith("/orchestrate") &&
    pathname.split("/").filter(Boolean).length === 1;
  const isSettingsRoute = pathname.startsWith("/settings");
  const isCatalogRoute = pathname.startsWith("/plugins") || pathname.startsWith("/skills");
  const hasDesktopShellChrome =
    typeof window !== "undefined" &&
    (window.desktopBridge !== undefined || window.nativeApi !== undefined);

  return (
    <SidebarProvider
      defaultOpen={!isCatalogRoute}
      style={
        {
          "--app-desktop-main-surface": isThreadRoute
            ? "var(--app-thread-surface)"
            : "var(--app-page-shell-surface)",
        } as CSSProperties
      }
    >
      <ChatRouteGlobalShortcuts />
      <ChatRouteSidebarSync collapseSidebar={isCatalogRoute} />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="bg-[var(--app-sidebar-surface)] text-foreground"
      >
        {isSettingsRoute ? <SettingsSidebar /> : <ThreadSidebar />}
      </Sidebar>
      <DesktopShellTitlebarBand hasDesktopShellChrome={hasDesktopShellChrome} />
      <div
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--app-desktop-main-surface)]"
        style={{ paddingTop: "var(--desktop-native-titlebar-height, 0px)" }}
      >
        <DiffWorkerPoolProvider>
          <Outlet />
        </DiffWorkerPoolProvider>
      </div>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
