import { SidebarDesktopBrandTrigger, useSidebar } from "~/components/ui/sidebar";
import { AppNavigationControls } from "~/components/AppNavigationControls";

type DesktopShellTitlebarBandProps = {
  hasDesktopShellChrome: boolean;
};

export default function DesktopShellTitlebarBand({
  hasDesktopShellChrome,
}: DesktopShellTitlebarBandProps) {
  const { isMobile, open } = useSidebar();

  if (!hasDesktopShellChrome || isMobile) {
    return null;
  }

  const sidebarBandWidth = open ? "var(--sidebar-width)" : "var(--desktop-leading-slot-width)";

  return (
    <div
      className="fixed inset-x-0 top-0 z-30 hidden md:flex"
      data-testid="desktop-titlebar-band"
      style={{ height: "var(--desktop-native-titlebar-height)" }}
    >
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 bg-[var(--app-desktop-main-surface)]"
          data-testid="desktop-titlebar-band-main-surface"
        />
        <div
          className="absolute inset-y-0 left-0 bg-[var(--app-sidebar-surface)]"
          data-testid="desktop-titlebar-band-sidebar-surface"
          style={{ width: sidebarBandWidth }}
        />
      </div>
      <div
        className="relative flex h-full min-w-0 flex-1 items-center"
        style={{ paddingLeft: "var(--desktop-native-leading-safe-area-width, 0px)" }}
      >
        <div
          className="flex h-full w-[var(--desktop-leading-slot-width)] shrink-0 items-center justify-center [-webkit-app-region:no-drag]"
          data-testid="desktop-leading-slot"
        >
          <SidebarDesktopBrandTrigger className="[-webkit-app-region:no-drag]" />
        </div>
        <AppNavigationControls
          buttonClassName="size-[var(--desktop-titlebar-trigger-size)] rounded-[10px]"
          className="shrink-0 [-webkit-app-region:no-drag]"
        />
        <div className="drag-region h-full min-w-0 flex-1" />
      </div>
    </div>
  );
}
