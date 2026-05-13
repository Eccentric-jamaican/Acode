import AppPageShell from "./AppPageShell";
import { isElectron, isElectronRuntime } from "../env";
import { SidebarInsetTrigger } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";

export type ChatHomeSurfaceVariant = "no-projects" | "no-thread" | "hydrating" | "error";

const HOME_COPY_BY_VARIANT: Record<ChatHomeSurfaceVariant, string> = {
  "no-projects": "Open or add a project to get started.",
  "no-thread": "Select a thread or create a new one to get started.",
  hydrating: "Restoring your workspace.",
  error: "The app could not restore your workspace state.",
};

export function resolveChatHomeSurfaceVariant(input: {
  projectsCount: number;
  threadsCount: number;
}): Exclude<ChatHomeSurfaceVariant, "hydrating"> {
  if (input.projectsCount === 0 && input.threadsCount === 0) {
    return "no-projects";
  }
  return "no-thread";
}

export default function ChatHomeSurface(props: { variant: ChatHomeSurfaceVariant }) {
  const usesDesktopAppChrome = isElectronRuntime();
  const topStatusLabel =
    props.variant === "hydrating"
      ? "Restoring threads..."
      : props.variant === "error"
        ? "Workspace restore failed"
        : "No active thread";

  return (
    <AppPageShell
      className="text-muted-foreground/40"
      data-testid="chat-home-surface"
      data-home-variant={props.variant}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-page-shell-surface)] text-muted-foreground/40">
        {!isElectron && (
          <header className="px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarInsetTrigger className="shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}

        {usesDesktopAppChrome && (
          <div
            className="flex h-[var(--app-desktop-content-header-height)] shrink-0 items-center px-3 sm:px-5"
            data-testid="chat-home-top-row"
          >
            <span className="text-xs text-muted-foreground/50">{topStatusLabel}</span>
          </div>
        )}

        <div className="flex flex-1 items-center justify-center px-6">
          {props.variant === "hydrating" ? (
            <WorkspaceHydrationSkeleton />
          ) : (
            <div className="max-w-sm space-y-2 text-center">
              <h1 className="text-base font-medium tracking-tight text-foreground">
                Let&apos;s build
              </h1>
              <p className="text-sm text-muted-foreground/80" data-testid="chat-home-variant-copy">
                {HOME_COPY_BY_VARIANT[props.variant]}
              </p>
              {props.variant === "error" && (
                <p className="text-xs text-muted-foreground/55" data-testid="chat-home-error-line">
                  Check the server log or restart the app to retry hydration.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </AppPageShell>
  );
}

function WorkspaceHydrationSkeleton() {
  return (
    <div
      className="w-full max-w-2xl space-y-5 px-2"
      aria-label="Restoring workspace"
      data-testid="chat-home-loading-line"
    >
      <div className="mx-auto w-full max-w-md space-y-2 text-center">
        <Skeleton className="mx-auto h-4 w-32" />
        <Skeleton className="mx-auto h-3 w-56" />
      </div>
      <div className="space-y-3 rounded-lg border border-border/45 bg-card/25 p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-[92%] rounded-md" />
        <Skeleton className="h-14 w-[78%] rounded-md" />
      </div>
    </div>
  );
}
