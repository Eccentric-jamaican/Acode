import { createFileRoute } from "@tanstack/react-router";

import PluginCatalogRouteView from "../components/PluginCatalogRouteView";

export const Route = createFileRoute("/_chat/skills")({
  component: function SkillsRoute() {
    return <PluginCatalogRouteView mode="skills" />;
  },
});
