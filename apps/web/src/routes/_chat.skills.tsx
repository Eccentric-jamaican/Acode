import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const PluginCatalogRouteView = lazy(() => import("../components/PluginCatalogRouteView"));

export const Route = createFileRoute("/_chat/skills")({
  component: function SkillsRoute() {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading skills...
          </div>
        }
      >
        <PluginCatalogRouteView mode="skills" />
      </Suspense>
    );
  },
});
