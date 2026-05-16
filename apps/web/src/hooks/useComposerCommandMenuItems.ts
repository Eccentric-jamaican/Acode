import type {
  ProjectEntry,
  ComputerUseAppSummary,
  ProviderKind,
  ProviderNativeCommandDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { useMemo } from "react";
import {
  buildCommandSearchBlob,
  buildPluginSearchBlob,
  buildSkillSearchBlob,
  normalizeProviderDiscoveryText,
} from "~/lib/providerDiscovery";
import type { ModelSlug } from "@t3tools/contracts";
import type { ComposerTrigger } from "../composer-logic";
import {
  filterComposerSlashCommands,
  getAvailableComposerSlashCommands,
  getProviderNativeSlashCommandSearchTerms,
} from "../composerSlashCommands";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import { basenameOfPath } from "../vscode-icons";
import { shouldShowFastTierIcon, type AppServiceTier } from "../appSettings";

type SearchableModelOption = {
  provider: ProviderKind;
  providerLabel: string;
  slug: ModelSlug;
  name: string;
  searchSlug: string;
  searchName: string;
  searchProvider: string;
};

function pluginComposerIcon(plugin: ProviderPluginDescriptor | undefined): string | undefined {
  return plugin?.interface?.composerIcon ?? plugin?.interface?.logo;
}

function pluginForSkill(
  skill: ProviderSkillDescriptor,
  plugins: readonly ProviderPluginDescriptor[],
): ProviderPluginDescriptor | undefined {
  return plugins.find((plugin) => skill.path.startsWith(plugin.source.path));
}

function pluginItemsForComposer(
  plugins: readonly ProviderPluginDescriptor[],
  normalizedQuery: string,
): ComposerCommandItem[] {
  return plugins
    .filter((plugin) =>
      normalizedQuery ? buildPluginSearchBlob(plugin).includes(normalizedQuery) : true,
    )
    .map((plugin) => {
      const iconUrl = pluginComposerIcon(plugin);
      const item: ComposerCommandItem = {
        id: `plugin:${plugin.id}`,
        type: "plugin" as const,
        plugin,
        label: plugin.interface?.displayName ?? plugin.name,
        description:
          plugin.interface?.shortDescription ??
          plugin.interface?.longDescription ??
          plugin.interface?.category ??
          "Codex plugin",
      };
      if (iconUrl) item.iconUrl = iconUrl;
      return item;
    });
}

function skillItemsForComposer(
  skills: readonly ProviderSkillDescriptor[],
  plugins: readonly ProviderPluginDescriptor[],
  normalizedQuery: string,
): ComposerCommandItem[] {
  return skills
    .filter((skill) =>
      normalizedQuery ? buildSkillSearchBlob(skill).includes(normalizedQuery) : true,
    )
    .map((skill) => {
      const iconUrl = pluginComposerIcon(pluginForSkill(skill, plugins));
      const item: ComposerCommandItem = {
        id: `skill:${skill.path}`,
        type: "skill" as const,
        skill,
        label: skill.interface?.displayName ?? skill.name,
        description: skill.interface?.shortDescription ?? skill.description ?? skill.path,
      };
      if (iconUrl) item.iconUrl = iconUrl;
      return item;
    });
}

function desktopAppSearchBlob(app: ComputerUseAppSummary): string {
  const windowTitles = app.windows.map((window) => window.title).join("\n");
  const mentionName = app.name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]+/g, "")
    .replace(/^-+|-+$/g, "");
  return normalizeProviderDiscoveryText(
    [
      app.name,
      mentionName,
      app.appId,
      app.launchId ?? "",
      windowTitles,
      app.isRunning === false ? "installed app" : `${app.windows.length} windows`,
    ].join("\n"),
  );
}

export function useComposerCommandMenuItems(input: {
  composerTrigger: ComposerTrigger | null;
  provider: ProviderKind;
  supportsFastSlashCommand: boolean;
  canOfferReviewCommand: boolean;
  canOfferForkCommand: boolean;
  providerNativeCommands: readonly ProviderNativeCommandDescriptor[];
  providerNativeCommandNames: readonly string[];
  providerPlugins: readonly ProviderPluginDescriptor[];
  providerSkills: readonly ProviderSkillDescriptor[];
  workspaceEntries: readonly ProjectEntry[];
  desktopApps: readonly ComputerUseAppSummary[];
  searchableModelOptions: readonly SearchableModelOption[];
  selectedServiceTierSetting: AppServiceTier;
}): ComposerCommandItem[] {
  const {
    composerTrigger,
    provider,
    supportsFastSlashCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    providerNativeCommands,
    providerNativeCommandNames,
    providerPlugins,
    providerSkills,
    workspaceEntries,
    desktopApps,
    searchableModelOptions,
    selectedServiceTierSetting,
  } = input;

  return useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      const normalizedQuery = normalizeProviderDiscoveryText(composerTrigger.query);
      const pathItems: ComposerCommandItem[] = workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
      const appItems: ComposerCommandItem[] = desktopApps
        .filter((app) => {
          if (!normalizedQuery) return true;
          return desktopAppSearchBlob(app).includes(normalizedQuery);
        })
        .map((app) => ({
          id: `desktop-app:${app.appId}`,
          type: "desktop-app" as const,
          app,
          label: app.name,
          description:
            app.windows.find((window) => window.isFocused || window.isMain)?.title ??
            (app.isRunning === false
              ? "Installed app"
              : `${app.windows.length} window${app.windows.length === 1 ? "" : "s"}`),
          iconUrl: app.iconUrl,
        }));
      const pluginItems = pluginItemsForComposer(providerPlugins, normalizedQuery);
      const skillItems = skillItemsForComposer(providerSkills, providerPlugins, normalizedQuery);
      return [...pathItems, ...appItems, ...pluginItems, ...skillItems];
    }

    if (composerTrigger.kind === "slash-command") {
      const normalizedQuery = normalizeProviderDiscoveryText(composerTrigger.query);
      const builtInItems = filterComposerSlashCommands(
        composerTrigger.query,
        getAvailableComposerSlashCommands({
          provider,
          supportsFastSlashCommand,
          canOfferReviewCommand,
          canOfferForkCommand,
          providerNativeCommandNames,
        }),
      ).map((definition) => ({
        id: `slash:${definition.command}`,
        type: "slash-command" as const,
        command: definition.command,
        label: definition.label,
        description: definition.description,
      }));
      const providerCommandItems = providerNativeCommands
        .filter((command) => {
          if (!normalizedQuery) return true;
          return (
            buildCommandSearchBlob(command).includes(normalizedQuery) ||
            getProviderNativeSlashCommandSearchTerms(provider, command.name).some((term) =>
              term.includes(normalizedQuery),
            )
          );
        })
        .map((command) => ({
          id: `provider-command:${provider}:${command.name}`,
          type: "provider-native-command" as const,
          provider,
          command: command.name,
          label: `/${command.name}`,
          description: command.description ?? `Run ${provider} native command`,
        }));
      const slashPluginItems = pluginItemsForComposer(providerPlugins, normalizedQuery);
      const slashSkillItems = skillItemsForComposer(
        providerSkills,
        providerPlugins,
        normalizedQuery,
      );
      return [...builtInItems, ...providerCommandItems, ...slashPluginItems, ...slashSkillItems];
    }

    if (composerTrigger.kind === "skill") {
      const normalizedQuery = normalizeProviderDiscoveryText(composerTrigger.query);
      const pluginItems = pluginItemsForComposer(providerPlugins, normalizedQuery);
      const skillItems = skillItemsForComposer(providerSkills, providerPlugins, normalizedQuery);
      return [...pluginItems, ...skillItems];
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider: modelProvider, providerLabel, slug, name }) => ({
        id: `model:${modelProvider}:${slug}`,
        type: "model",
        provider: modelProvider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
        showFastBadge:
          modelProvider === "codex" && shouldShowFastTierIcon(slug, selectedServiceTierSetting),
      }));
  }, [
    composerTrigger,
    provider,
    supportsFastSlashCommand,
    canOfferReviewCommand,
    canOfferForkCommand,
    providerNativeCommandNames,
    providerNativeCommands,
    providerPlugins,
    providerSkills,
    searchableModelOptions,
    selectedServiceTierSetting,
    desktopApps,
    workspaceEntries,
  ]);
}
