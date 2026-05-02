import { createFileRoute } from "@tanstack/react-router";

import PluginCatalogRouteView from "../components/PluginCatalogRouteView";

type PluginsSearch = {
  pluginName?: string;
  marketplacePath?: string;
};

function parsePluginsSearch(search: Record<string, unknown>): PluginsSearch {
  const pluginName =
    typeof search.pluginName === "string" && search.pluginName.trim().length > 0
      ? search.pluginName
      : undefined;
  const marketplacePath =
    typeof search.marketplacePath === "string" && search.marketplacePath.trim().length > 0
      ? search.marketplacePath
      : undefined;
  const parsed: PluginsSearch = {};
  if (pluginName) {
    parsed.pluginName = pluginName;
  }
  if (marketplacePath) {
    parsed.marketplacePath = marketplacePath;
  }
  return parsed;
}

export const Route = createFileRoute("/_chat/plugins")({
  validateSearch: (search) => parsePluginsSearch(search),
  component: function PluginsRoute() {
    const search = Route.useSearch();
    return (
      <PluginCatalogRouteView
        mode="plugins"
        pluginName={search.pluginName}
        marketplacePath={search.marketplacePath}
      />
    );
  },
});
