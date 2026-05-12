import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const OrchestrateRouteView = lazy(() => import("../components/orchestrate/OrchestrateRouteView"));

type OrchestrateSearch = {
  projectId?: string;
  taskId?: string;
  view?: "board" | "list" | "inbox";
};

function parseOrchestrateSearch(search: Record<string, unknown>): OrchestrateSearch {
  const projectId =
    typeof search.projectId === "string" &&
    (search.projectId === "all" || search.projectId.trim().length > 0)
      ? search.projectId
      : undefined;
  const taskId =
    typeof search.taskId === "string" && search.taskId.trim().length > 0 ? search.taskId : undefined;
  const view =
    search.view === "list"
      ? "list"
      : search.view === "board"
        ? "board"
        : search.view === "inbox"
          ? "inbox"
          : undefined;
  return {
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(view ? { view } : {}),
  };
}

export const Route = createFileRoute("/_chat/orchestrate")({
  validateSearch: (search) => parseOrchestrateSearch(search),
  component: function OrchestrateRoute() {
    const search = Route.useSearch();
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading orchestrate...
          </div>
        }
      >
        <OrchestrateRouteView
          projectIdFromSearch={search.projectId}
          taskIdFromSearch={search.taskId}
          viewFromSearch={search.view}
        />
      </Suspense>
    );
  },
});
