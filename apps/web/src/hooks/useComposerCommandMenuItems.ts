import type {
  ProjectEntry,
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
    searchableModelOptions,
    selectedServiceTierSetting,
  } = input;

  return useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
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
      const slashSkillItems: ComposerCommandItem[] = providerSkills
        .filter((skill) =>
          normalizedQuery ? buildSkillSearchBlob(skill).includes(normalizedQuery) : true,
        )
        .map((skill) => {
          const iconUrl = pluginComposerIcon(pluginForSkill(skill, providerPlugins));
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
      const slashPluginItems: ComposerCommandItem[] = providerPlugins
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
      return [...builtInItems, ...providerCommandItems, ...slashPluginItems, ...slashSkillItems];
    }

    if (composerTrigger.kind === "skill") {
      const normalizedQuery = normalizeProviderDiscoveryText(composerTrigger.query);
      const pluginItems: ComposerCommandItem[] = providerPlugins
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
      const skillItems: ComposerCommandItem[] = providerSkills
        .filter((skill) =>
          normalizedQuery ? buildSkillSearchBlob(skill).includes(normalizedQuery) : true,
        )
        .map((skill) => {
          const iconUrl = pluginComposerIcon(pluginForSkill(skill, providerPlugins));
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
    workspaceEntries,
  ]);
}
