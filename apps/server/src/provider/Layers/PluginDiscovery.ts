import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderListPluginsResult,
  ProviderPluginAppSummary,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderPluginInterface,
  ProviderPluginMarketplaceDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";

const PLUGIN_JSON_RELATIVE_PATH = path.join(".codex-plugin", "plugin.json");
const MAX_PLUGIN_SCAN_DEPTH = 4;
const MAX_SKILL_SCAN_DEPTH = 3;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(asString).filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
}

function readJsonFile(filePath: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function normalizeRelativeAsset(pluginRoot: string, value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  if (
    raw.startsWith("data:") ||
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("/")
  ) {
    return raw;
  }

  const assetPath = path.resolve(pluginRoot, raw);
  const normalizedRoot = path.resolve(pluginRoot);
  if (!assetPath.startsWith(normalizedRoot)) {
    return undefined;
  }

  try {
    const bytes = fs.readFileSync(assetPath);
    const ext = path.extname(assetPath).toLowerCase();
    const mimeType =
      ext === ".svg"
        ? "image/svg+xml"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png";
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function toPluginInterface(pluginRoot: string, rawInterface: unknown): ProviderPluginInterface | undefined {
  const ui = asObject(rawInterface);
  if (!ui) return undefined;

  const displayName = asString(ui.displayName);
  const shortDescription = asString(ui.shortDescription);
  const longDescription = asString(ui.longDescription);
  const developerName = asString(ui.developerName);
  const category = asString(ui.category);
  const capabilities = asStringArray(ui.capabilities);
  const websiteUrl = asString(ui.websiteUrl) ?? asString(ui.websiteURL);
  const privacyPolicyUrl = asString(ui.privacyPolicyUrl) ?? asString(ui.privacyPolicyURL);
  const termsOfServiceUrl = asString(ui.termsOfServiceUrl) ?? asString(ui.termsOfServiceURL);
  const defaultPrompt = asStringArray(ui.defaultPrompt);
  const brandColor = asString(ui.brandColor);
  const composerIcon = normalizeRelativeAsset(pluginRoot, ui.composerIcon);
  const logo = normalizeRelativeAsset(pluginRoot, ui.logo);
  const screenshots = asStringArray(ui.screenshots);

  return {
    ...(displayName ? { displayName } : {}),
    ...(shortDescription ? { shortDescription } : {}),
    ...(longDescription ? { longDescription } : {}),
    ...(developerName ? { developerName } : {}),
    ...(category ? { category } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}),
    ...(termsOfServiceUrl ? { termsOfServiceUrl } : {}),
    ...(defaultPrompt ? { defaultPrompt } : {}),
    ...(brandColor ? { brandColor } : {}),
    ...(composerIcon ? { composerIcon } : {}),
    ...(logo ? { logo } : {}),
    ...(screenshots ? { screenshots } : {}),
  };
}

function findPluginJsonFiles(rootDir: string, depth = 0, output: string[] = []): string[] {
  if (depth > MAX_PLUGIN_SCAN_DEPTH) return output;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("plugin-install-")) continue;
    const entryPath = path.join(rootDir, entry.name);
    const pluginJsonPath = path.join(entryPath, PLUGIN_JSON_RELATIVE_PATH);
    if (fs.existsSync(pluginJsonPath)) {
      output.push(pluginJsonPath);
      continue;
    }
    findPluginJsonFiles(entryPath, depth + 1, output);
  }
  return output;
}

function toPluginDescriptor(pluginJsonPath: string): ProviderPluginDescriptor | undefined {
  const pluginRoot = path.dirname(path.dirname(pluginJsonPath));
  const raw = readJsonFile(pluginJsonPath);
  if (!raw) return undefined;
  const name = asString(raw.name) ?? path.basename(pluginRoot);
  const description = asString(raw.description);
  const pluginInterface = toPluginInterface(pluginRoot, raw.interface);

  return {
    id: `${path.basename(path.dirname(path.dirname(pluginRoot)))}:${name}`,
    name,
    source: {
      type: "local",
      path: pluginRoot,
    },
    installed: true,
    enabled: true,
    installPolicy: "INSTALLED_BY_DEFAULT",
    authPolicy: "ON_USE",
    interface: {
      ...(description ? { shortDescription: description } : {}),
      ...pluginInterface,
    },
  };
}

function toMarketplaceDescriptor(marketplacePath: string): ProviderPluginMarketplaceDescriptor {
  const plugins = findPluginJsonFiles(marketplacePath)
    .map(toPluginDescriptor)
    .filter((plugin): plugin is ProviderPluginDescriptor => Boolean(plugin))
    .toSorted((left, right) => left.name.localeCompare(right.name));

  return {
    name: path.basename(marketplacePath),
    path: marketplacePath,
    interface: {
      displayName:
        path.basename(marketplacePath) === "openai-curated" ? "Built by OpenAI" : "OpenAI bundled",
    },
    plugins,
  };
}

function resolveCodexPluginsRoot(preferredHomePath?: string): string {
  const homePath = preferredHomePath?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(homePath, "plugins", "cache");
}

function discoverMarketplacePaths(preferredHomePath?: string): string[] {
  const pluginsRoot = resolveCodexPluginsRoot(preferredHomePath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsRoot, entry.name))
    .filter((entryPath) => findPluginJsonFiles(entryPath).length > 0)
    .toSorted((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

export function discoverPlugins(preferredHomePath?: string): ProviderListPluginsResult {
  const marketplaces = discoverMarketplacePaths(preferredHomePath).map(toMarketplaceDescriptor);
  const featuredPluginIds = marketplaces.flatMap((marketplace) =>
    marketplace.plugins
      .filter((plugin) => plugin.name === "browser-use")
      .map((plugin) => plugin.id),
  );
  return {
    marketplaces,
    marketplaceLoadErrors: [],
    remoteSyncError: null,
    featuredPluginIds,
    source: "codex-home",
    cached: false,
  };
}

function readSkillSummary(skillFilePath: string): { name: string; description?: string | undefined } {
  const fallbackName = path.basename(path.dirname(skillFilePath));
  try {
    const raw = fs.readFileSync(skillFilePath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!frontmatter?.[1]) return { name: fallbackName };
    const name = /^name:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim() ?? fallbackName;
    const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim();
    return {
      name,
      ...(description ? { description } : {}),
    };
  } catch {
    return { name: fallbackName };
  }
}

function collectPluginSkillFiles(rootDir: string, depth = 0, output: string[] = []): string[] {
  if (depth > MAX_SKILL_SCAN_DEPTH) return output;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      output.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      collectPluginSkillFiles(entryPath, depth + 1, output);
    }
  }
  return output;
}

function readPluginSkills(pluginRoot: string, rawPlugin: JsonObject): ProviderSkillDescriptor[] {
  const skillsPath = asString(rawPlugin.skills);
  if (!skillsPath) return [];
  const skillsRoot = path.resolve(pluginRoot, skillsPath);
  return collectPluginSkillFiles(skillsRoot)
    .map((skillFilePath): ProviderSkillDescriptor => {
      const summary = readSkillSummary(skillFilePath);
      if (summary.description) {
        return {
          name: summary.name,
          description: summary.description,
          path: path.dirname(skillFilePath),
          enabled: true,
          scope: "plugin",
          interface: {
            displayName: summary.name,
            shortDescription: summary.description,
          },
        };
      }
      return {
        name: summary.name,
        path: path.dirname(skillFilePath),
        enabled: true,
        scope: "plugin",
        interface: {
          displayName: summary.name,
        },
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readPluginApps(pluginRoot: string, rawPlugin: JsonObject): ProviderPluginAppSummary[] {
  const appsPath = asString(rawPlugin.apps);
  if (!appsPath) return [];
  const rawApps = readJsonFile(path.resolve(pluginRoot, appsPath));
  const apps = asObject(rawApps?.apps);
  if (!apps) return [];
  return Object.entries(apps).map(([name, value]) => ({
    id: asString(asObject(value)?.id) ?? name,
    name,
    description: asString(rawPlugin.description),
    needsAuth: true,
  }));
}

export function readDiscoveredPlugin(input: {
  marketplacePath: string;
  pluginName: string;
}): ProviderPluginDetail | undefined {
  const marketplace = toMarketplaceDescriptor(input.marketplacePath);
  const summary = marketplace.plugins.find((plugin) => plugin.name === input.pluginName);
  if (!summary) return undefined;
  const pluginJsonPath = path.join(summary.source.path, PLUGIN_JSON_RELATIVE_PATH);
  const rawPlugin = readJsonFile(pluginJsonPath);
  if (!rawPlugin) return undefined;

  return {
    marketplaceName: marketplace.name,
    marketplacePath: marketplace.path,
    summary,
    ...(summary.interface?.longDescription ? { description: summary.interface.longDescription } : {}),
    skills: readPluginSkills(summary.source.path, rawPlugin),
    apps: readPluginApps(summary.source.path, rawPlugin),
    mcpServers: [],
  };
}
