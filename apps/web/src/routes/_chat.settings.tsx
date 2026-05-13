import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { normalizeSettingsSectionId } from "../settingsSections";

const SettingsRouteView = lazy(() => import("../components/SettingsRouteView"));

function SettingsLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading settings...
    </div>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: (search) => ({
    section: normalizeSettingsSectionId(search.section),
  }),
  component: function SettingsRoute() {
    return (
      <Suspense fallback={<SettingsLoadingFallback />}>
        <SettingsRouteView />
      </Suspense>
    );
  },
});
