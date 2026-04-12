import type {
  ProviderNativeCommandDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";

export function resolveProviderDiscoveryCwd(options: {
  activeThreadWorktreePath: string | null;
  activeProjectCwd: string | null;
  serverCwd: string | null;
}): string | null {
  return options.activeThreadWorktreePath ?? options.activeProjectCwd ?? options.serverCwd;
}

export function normalizeProviderDiscoveryText(value: string | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[:/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSkillSearchBlob(
  skill: Pick<ProviderSkillDescriptor, "name" | "description" | "interface">,
): string {
  return normalizeProviderDiscoveryText(
    [skill.name, skill.interface?.displayName, skill.interface?.shortDescription, skill.description]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );
}

export function buildPluginSearchBlob(
  plugin: Pick<ProviderPluginDescriptor, "name" | "interface">,
): string {
  return normalizeProviderDiscoveryText(
    [
      plugin.name,
      plugin.interface?.displayName,
      plugin.interface?.shortDescription,
      plugin.interface?.category,
      plugin.interface?.developerName,
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );
}

export function buildCommandSearchBlob(
  command: Pick<ProviderNativeCommandDescriptor, "name" | "description">,
): string {
  return normalizeProviderDiscoveryText(
    [command.name, command.description].filter(Boolean).join("\n"),
  );
}
