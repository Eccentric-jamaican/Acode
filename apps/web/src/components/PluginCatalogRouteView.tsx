import type {
  ProviderKind,
  ProviderPluginDetail,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceDescriptor,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BlocksIcon,
  BookOpenIcon,
  BoxIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  PlayIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import AppPageShell from "./AppPageShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarInsetTrigger } from "./ui/sidebar";
import { cn } from "~/lib/utils";
import {
  providerPluginsQueryOptions,
  providerReadPluginQueryOptions,
  providerSkillsQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import { useStore } from "~/store";

type CatalogMode = "plugins" | "skills";

type PluginEntry = {
  plugin: ProviderPluginDescriptor;
  marketplace: ProviderPluginMarketplaceDescriptor;
};

type CatalogSection<T> = {
  title: string;
  items: T[];
};

const PROVIDER: ProviderKind = "codex";
const ALL_BUILDERS_FILTER = "__all_builders__";
const ALL_CATEGORIES_FILTER = "__all_categories__";

function displayPluginName(plugin: ProviderPluginDescriptor) {
  return plugin.interface?.displayName ?? plugin.name;
}

function displaySkillName(skill: ProviderSkillDescriptor) {
  return skill.interface?.displayName ?? skill.name;
}

function pluginDescription(plugin: ProviderPluginDescriptor) {
  return plugin.interface?.shortDescription ?? plugin.interface?.longDescription ?? "Extend Codex.";
}

function skillDescription(skill: ProviderSkillDescriptor) {
  return skill.interface?.shortDescription ?? skill.description ?? skill.path;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function includesQuery(parts: Array<string | undefined>, query: string) {
  if (!query) return true;
  return parts.filter(Boolean).join(" ").toLowerCase().includes(query);
}

function getPluginCategory(plugin: ProviderPluginDescriptor) {
  return plugin.interface?.category?.trim() || "Featured";
}

function getPluginBuilder(entry: PluginEntry) {
  const marketplaceName = entry.marketplace.name.toLowerCase();
  const marketplacePath = entry.marketplace.path.toLowerCase();
  if (marketplaceName.includes("openai") || marketplacePath.includes("openai-")) {
    return "OpenAI";
  }
  return (
    entry.marketplace.interface?.displayName?.trim() ||
    entry.marketplace.name ||
    entry.plugin.interface?.developerName?.trim() ||
    "Unknown"
  );
}

function getSkillCategory(skill: ProviderSkillDescriptor) {
  const scope = skill.scope?.trim().toLowerCase();
  if (scope === "personal" || scope === "workspace") return "Personal";
  return "System";
}

function getInitials(name: string) {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function CatalogIcon({
  name,
  logo,
  brandColor,
  kind,
}: {
  name: string;
  logo?: string | undefined;
  brandColor?: string | undefined;
  kind: "plugin" | "skill";
}) {
  const canUseImage =
    typeof logo === "string" &&
    (logo.startsWith("https://") ||
      logo.startsWith("http://") ||
      logo.startsWith("data:") ||
      logo.startsWith("/"));
  const iconStyle = brandColor ? { backgroundColor: brandColor } : undefined;

  if (canUseImage) {
    return (
      <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/95">
        <img src={logo} alt="" className="size-full object-cover" draggable={false} />
      </span>
    );
  }

  const lowerName = name.toLowerCase();
  const Icon =
    lowerName.includes("calendar")
      ? CalendarDaysIcon
      : lowerName.includes("doc") || lowerName.includes("book")
        ? BookOpenIcon
        : lowerName.includes("pdf")
          ? FileTextIcon
          : lowerName.includes("image")
            ? ImageIcon
            : lowerName.includes("browser") || lowerName.includes("playwright")
              ? PlayIcon
              : kind === "plugin"
                ? PuzzleIcon
                : BlocksIcon;

  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm",
        brandColor ? "" : "bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50",
      )}
      style={iconStyle}
      aria-hidden="true"
    >
      {brandColor ? (
        <span className="text-sm font-semibold">{getInitials(name) || "C"}</span>
      ) : (
        <Icon className="size-5" />
      )}
    </span>
  );
}

function CatalogTabs({ mode }: { mode: CatalogMode }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-1 rounded-full p-1">
      {(["plugins", "skills"] as const).map((tab) => {
        const active = mode === tab;
        return (
          <button
            key={tab}
            type="button"
            className={cn(
              "h-9 rounded-xl px-3 text-sm font-medium capitalize text-muted-foreground transition-colors hover:text-foreground",
              active && "bg-zinc-200/70 text-foreground dark:bg-zinc-800/85",
            )}
            onClick={() => void navigate({ to: tab === "plugins" ? "/plugins" : "/skills" })}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}

function FilterMenu({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-zinc-200/70 px-3 text-sm text-foreground hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          />
        }
      >
        {label}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={value}
          onValueChange={(nextValue) => {
            if (!nextValue || nextValue === value) return;
            onValueChange(nextValue);
          }}
        >
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function PluginRow({ entry }: { entry: PluginEntry }) {
  const plugin = entry.plugin;
  const name = displayPluginName(plugin);
  const installed = plugin.installed || plugin.installPolicy === "INSTALLED_BY_DEFAULT";
  const navigate = useNavigate();

  return (
    <article
      className="grid min-h-20 cursor-pointer grid-cols-[1fr_auto] items-center gap-4 rounded-lg px-3 py-3 transition-colors hover:bg-zinc-200/50 dark:hover:bg-zinc-900/70"
      onClick={() =>
        void navigate({
          to: "/plugins",
          search: {
            pluginName: plugin.name,
            marketplacePath: entry.marketplace.path,
          },
        })
      }
    >
      <div className="flex min-w-0 items-center gap-4">
        <CatalogIcon
          name={name}
          logo={plugin.interface?.logo ?? plugin.interface?.composerIcon}
          brandColor={plugin.interface?.brandColor}
          kind="plugin"
        />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{name}</h3>
          <p className="mt-1 truncate text-sm text-muted-foreground">{pluginDescription(plugin)}</p>
        </div>
      </div>
      <button
        type="button"
        className={cn(
          "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
          installed ? "bg-transparent" : "bg-zinc-200/70 hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        )}
        aria-label={installed ? `${name} installed` : `Install ${name}`}
        onClick={(event) => event.stopPropagation()}
      >
        {installed ? <CheckIcon className="size-4" /> : <PlusIcon className="size-5" />}
      </button>
    </article>
  );
}

function SkillRow({ skill }: { skill: ProviderSkillDescriptor }) {
  const name = displaySkillName(skill);

  return (
    <article className="grid min-h-20 grid-cols-[1fr_auto] items-center gap-4 px-3 py-3">
      <div className="flex min-w-0 items-center gap-4">
        <CatalogIcon name={name} kind="skill" />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{name}</h3>
          <p className="mt-1 truncate text-sm text-muted-foreground">{skillDescription(skill)}</p>
        </div>
      </div>
      <button
        type="button"
        className={cn(
          "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
          skill.enabled
            ? "bg-transparent"
            : "bg-zinc-200/70 hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        )}
        aria-label={skill.enabled ? `${name} enabled` : `Enable ${name}`}
      >
        {skill.enabled ? <CheckIcon className="size-4" /> : <PlusIcon className="size-5" />}
      </button>
    </article>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-border/70 pb-3">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
    </div>
  );
}

function sectionGridClassName(itemCount: number) {
  return cn(
    "grid grid-cols-1 gap-x-12 gap-y-3",
    itemCount > 1 ? "md:grid-cols-2" : "md:grid-cols-1",
  );
}

function EmptyState({ mode }: { mode: CatalogMode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 px-6 py-16 text-center">
      <SparklesIcon className="mb-3 size-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">No {mode} found</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Try a different search term or switch the filter back to all.
      </p>
    </div>
  );
}

function PluginPreviewPanel({ detail }: { detail: ProviderPluginDetail }) {
  const plugin = detail.summary;
  const name = displayPluginName(plugin);
  const prompt = plugin.interface?.defaultPrompt?.[0] ?? pluginDescription(plugin);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/6 bg-[#142143] px-5 py-16 sm:px-8">
      <div className="absolute inset-0 bg-[linear-gradient(115deg,#14315f_0%,#1d2460_52%,#3d345f_100%)]" />
      <div className="absolute inset-0 opacity-35 [background:radial-gradient(circle_at_26%_12%,rgba(255,255,255,0.22),transparent_34%),radial-gradient(circle_at_72%_0%,rgba(255,255,255,0.14),transparent_28%)]" />
      <div className="relative flex justify-center">
        <div className="inline-flex max-w-full items-center gap-2 rounded-xl border border-white/12 bg-black/72 px-4 py-3 text-sm shadow-xl">
          <CatalogIcon
            name={name}
            logo={plugin.interface?.logo ?? plugin.interface?.composerIcon}
            brandColor={plugin.interface?.brandColor}
            kind="plugin"
          />
          <span className="min-w-0 truncate font-semibold text-blue-100">{name}</span>
          <span className="hidden min-w-0 truncate text-white sm:inline">{prompt}</span>
        </div>
      </div>
    </section>
  );
}

function IncludeRow({
  title,
  kind,
  description,
}: {
  title: string;
  kind: string;
  description?: string | undefined;
}) {
  return (
    <div className="flex gap-4 px-4 py-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
        <BoxIcon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
          <span className="text-sm text-muted-foreground">{kind}</span>
        </div>
        {description ? (
          <p className="mt-1 truncate text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  href,
}: {
  label: string;
  value?: string | undefined;
  href?: string | undefined;
}) {
  if (!value && !href) return null;
  return (
    <div className="grid grid-cols-[180px_1fr] gap-8 border-b border-border px-5 py-4 last:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-foreground">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-blue-400 hover:text-blue-300"
          >
            {value ?? href}
            <ExternalLinkIcon className="ml-2 size-4" />
          </a>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function PluginDetailView({
  pluginName,
  marketplacePath,
}: {
  pluginName: string;
  marketplacePath: string;
}) {
  const navigate = useNavigate();
  const detailQuery = useQuery(
    providerReadPluginQueryOptions({
      provider: PROVIDER,
      marketplacePath,
      pluginName,
      enabled: Boolean(marketplacePath && pluginName),
    }),
  );
  const detail = detailQuery.data?.plugin;
  const plugin = detail?.summary;
  const name = plugin ? displayPluginName(plugin) : pluginName;
  const description = plugin ? pluginDescription(plugin) : "";
  const installed = plugin?.installed || plugin?.installPolicy === "INSTALLED_BY_DEFAULT";
  const includes = [
    ...(detail?.apps.map((app) => ({
      id: `app:${app.id}`,
      title: app.name,
      kind: "App",
      description: app.description,
    })) ?? []),
    ...(detail?.skills.map((skill) => ({
      id: `skill:${skill.path}`,
      title: displaySkillName(skill),
      kind: "Skill",
      description: skillDescription(skill),
    })) ?? []),
  ];

  return (
    <AppPageShell className="h-dvh text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white text-foreground dark:bg-[#0f0f10]">
        <header className="flex h-[var(--app-desktop-content-header-height)] items-center gap-3 px-3 sm:px-5">
          <SidebarInsetTrigger className="shrink-0" />
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => void navigate({ to: "/plugins" })}
          >
            Plugins
          </button>
          <ChevronDownIcon className="size-4 -rotate-90 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
          <div className="flex-1" />
          {plugin?.interface?.websiteUrl ? (
            <a
              href={plugin.interface.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex size-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-zinc-200/70 hover:text-foreground dark:hover:bg-zinc-900"
              aria-label={`Open ${name} website`}
            >
              <ExternalLinkIcon className="size-4" />
            </a>
          ) : null}
          <Button size="sm" variant={installed ? "secondary" : "default"} className="h-9 rounded-xl px-3">
            {installed ? "Added to Codex" : "Add to Codex"}
          </Button>
        </header>

        <main className="flex-1 overflow-y-auto px-5 pb-16 pt-8 sm:px-8">
          <div className="mx-auto flex w-full max-w-[1006px] flex-col gap-10">
            {detailQuery.isLoading ? (
              <div className="rounded-2xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                Loading plugin...
              </div>
            ) : detailQuery.error || !detail || !plugin ? (
              <div className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                {detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "Unable to load plugin."}
              </div>
            ) : (
              <>
                <section className="space-y-6">
                  <CatalogIcon
                    name={name}
                    logo={plugin.interface?.logo ?? plugin.interface?.composerIcon}
                    brandColor={plugin.interface?.brandColor}
                    kind="plugin"
                  />
                  <div>
                    <h1 className="text-2xl font-semibold tracking-normal text-foreground">{name}</h1>
                    <p className="mt-2 max-w-3xl text-lg text-muted-foreground">{description}</p>
                  </div>
                </section>

                <PluginPreviewPanel detail={detail} />

                {detail.description ? (
                  <p className="max-w-[880px] px-1 text-base leading-7 text-foreground">
                    {detail.description}
                  </p>
                ) : null}

                {includes.length > 0 ? (
                  <section className="space-y-4">
                    <h2 className="text-base font-semibold text-foreground">Includes</h2>
                    <div className="rounded-xl border border-border bg-zinc-100/70 dark:bg-zinc-900/70">
                      {includes.map((item) => (
                        <IncludeRow
                          key={item.id}
                          title={item.title}
                          kind={item.kind}
                          description={item.description}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className="space-y-4">
                  <h2 className="text-base font-semibold text-foreground">Information</h2>
                  <div className="overflow-hidden rounded-xl border border-border bg-zinc-100/70 dark:bg-zinc-900/70">
                    <InfoRow
                      label="Category"
                      value={[
                        plugin.interface?.developerName ? `Built by ${plugin.interface.developerName}` : null,
                        plugin.interface?.category,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    />
                    <InfoRow label="Capabilities" value={plugin.interface?.capabilities?.join(", ")} />
                    <InfoRow label="Developer" value={plugin.interface?.developerName} />
                    <InfoRow label="Website" href={plugin.interface?.websiteUrl} />
                    <InfoRow label="Privacy Policy" href={plugin.interface?.privacyPolicyUrl} />
                    <InfoRow label="Terms of service" href={plugin.interface?.termsOfServiceUrl} />
                  </div>
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </AppPageShell>
  );
}

function buildPluginSections(entries: PluginEntry[], featuredIds: readonly string[]) {
  const featured = entries.filter((entry) => featuredIds.includes(entry.plugin.id));
  const fallbackFeatured = featured.length > 0 ? featured : entries.slice(0, 1);
  const featuredIdsInUse = new Set(fallbackFeatured.map((entry) => entry.plugin.id));
  const grouped = new Map<string, PluginEntry[]>();

  for (const entry of entries) {
    if (featuredIdsInUse.has(entry.plugin.id)) continue;
    const category = getPluginCategory(entry.plugin);
    const existing = grouped.get(category) ?? [];
    existing.push(entry);
    grouped.set(category, existing);
  }

  const sections: CatalogSection<PluginEntry>[] = [];
  if (fallbackFeatured.length > 0) {
    sections.push({ title: "Featured", items: fallbackFeatured });
  }
  for (const [title, items] of grouped) {
    sections.push({ title, items });
  }
  return sections;
}

function buildSkillSections(skills: ProviderSkillDescriptor[]) {
  const grouped = new Map<string, ProviderSkillDescriptor[]>();
  for (const skill of skills) {
    const category = getSkillCategory(skill);
    const existing = grouped.get(category) ?? [];
    existing.push(skill);
    grouped.set(category, existing);
  }

  return Array.from(grouped.entries()).map(([title, items]) => ({ title, items }));
}

export default function PluginCatalogRouteView({
  mode,
  pluginName,
  marketplacePath,
}: {
  mode: CatalogMode;
  pluginName?: string | undefined;
  marketplacePath?: string | undefined;
}) {
  if (mode === "plugins" && pluginName && marketplacePath) {
    return <PluginDetailView pluginName={pluginName} marketplacePath={marketplacePath} />;
  }

  const projects = useStore((store) => store.projects);
  const cwd = projects[0]?.cwd ?? null;
  const [query, setQuery] = useState("");
  const [builderFilter, setBuilderFilter] = useState("OpenAI");
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES_FILTER);
  const normalizedQuery = normalizeSearch(query);

  const pluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: PROVIDER,
      cwd,
      enabled: mode === "plugins",
    }),
  );
  const skillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: PROVIDER,
      cwd,
      query: "",
      enabled: mode === "skills",
    }),
  );

  const pluginEntries = useMemo(() => {
    const marketplaces = pluginsQuery.data?.marketplaces ?? [];
    return marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({ plugin, marketplace })),
    );
  }, [pluginsQuery.data?.marketplaces]);

  const builderOptions = useMemo(() => {
    const builders = new Set<string>();
    for (const entry of pluginEntries) {
      const builder = getPluginBuilder(entry);
      if (builder) builders.add(builder);
    }
    return [
      { label: "All builders", value: ALL_BUILDERS_FILTER },
      ...Array.from(builders)
        .toSorted((left, right) => left.localeCompare(right))
        .map((builder) => ({ label: `Built by ${builder}`, value: builder })),
    ];
  }, [pluginEntries]);

  const pluginCategoryOptions = useMemo(() => {
    const categories = new Set<string>();
    for (const entry of pluginEntries) {
      categories.add(getPluginCategory(entry.plugin));
    }
    return [
      { label: "All", value: ALL_CATEGORIES_FILTER },
      ...Array.from(categories)
        .toSorted((left, right) => left.localeCompare(right))
        .map((category) => ({ label: category, value: category })),
    ];
  }, [pluginEntries]);

  const filteredPluginEntries = useMemo(
    () =>
      pluginEntries.filter((entry) => {
        const builder = getPluginBuilder(entry);
        const category = getPluginCategory(entry.plugin);
        const matchesBuilder =
          builderFilter === ALL_BUILDERS_FILTER ||
          builder.toLowerCase() === builderFilter.toLowerCase();
        const matchesCategory =
          categoryFilter === ALL_CATEGORIES_FILTER || category === categoryFilter;
        return (
          matchesBuilder &&
          matchesCategory &&
          includesQuery(
            [
              displayPluginName(entry.plugin),
              pluginDescription(entry.plugin),
              builder,
              entry.plugin.interface?.category,
              entry.marketplace.interface?.displayName,
              entry.marketplace.name,
            ],
            normalizedQuery,
          )
        );
      }),
    [builderFilter, categoryFilter, normalizedQuery, pluginEntries],
  );

  const skills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data?.skills]);
  const skillCategoryOptions = useMemo(() => {
    const categories = new Set<string>();
    for (const skill of skills) {
      categories.add(getSkillCategory(skill));
    }
    return [
      { label: "All", value: ALL_CATEGORIES_FILTER },
      ...Array.from(categories)
        .toSorted((left, right) => left.localeCompare(right))
        .map((category) => ({ label: category, value: category })),
    ];
  }, [skills]);

  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) => {
        const category = getSkillCategory(skill);
        return (
          (categoryFilter === ALL_CATEGORIES_FILTER || category === categoryFilter) &&
          includesQuery(
            [displaySkillName(skill), skillDescription(skill), skill.scope, skill.path],
            normalizedQuery,
          )
        );
      }),
    [categoryFilter, normalizedQuery, skills],
  );

  const pluginSections = useMemo(
    () => buildPluginSections(filteredPluginEntries, pluginsQuery.data?.featuredPluginIds ?? []),
    [filteredPluginEntries, pluginsQuery.data?.featuredPluginIds],
  );
  const skillSections = useMemo(() => buildSkillSections(filteredSkills), [filteredSkills]);
  const isLoading = mode === "plugins" ? pluginsQuery.isLoading : skillsQuery.isLoading;
  const loadError =
    mode === "plugins"
      ? pluginsQuery.error
      : cwd
        ? skillsQuery.error
        : new Error("Add a project to discover skills.");
  const sections = mode === "plugins" ? pluginSections : skillSections;
  const categoryOptions = mode === "plugins" ? pluginCategoryOptions : skillCategoryOptions;
  const builderLabel =
    builderFilter === ALL_BUILDERS_FILTER ? "All builders" : `Built by ${builderFilter}`;
  const categoryLabel = categoryFilter === ALL_CATEGORIES_FILTER ? "All" : categoryFilter;

  return (
    <AppPageShell className="h-dvh text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white text-foreground dark:bg-[#0f0f10]">
        <header className="flex h-[var(--app-desktop-content-header-height)] items-center gap-3 px-3 sm:px-5">
          <SidebarInsetTrigger className="shrink-0" />
          <CatalogTabs mode={mode} />
          <div className="flex-1" />
        </header>

        <main className="flex-1 overflow-y-auto px-5 pb-16 pt-10 sm:px-8">
          <div className="mx-auto flex w-full max-w-[1006px] flex-col gap-10">
            <h1 className="text-center text-3xl font-medium tracking-normal text-foreground">
              Make Codex work your way
            </h1>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={mode === "plugins" ? "Search plugins" : "Search skills"}
                  className="h-10 rounded-xl bg-zinc-200/70 pl-10 text-base dark:bg-zinc-900 sm:text-sm"
                />
              </div>
              {mode === "plugins" ? (
                <FilterMenu
                  label={builderLabel}
                  value={builderFilter}
                  options={builderOptions}
                  onValueChange={setBuilderFilter}
                />
              ) : null}
              <FilterMenu
                label={categoryLabel}
                value={categoryFilter}
                options={categoryOptions}
                onValueChange={setCategoryFilter}
              />
            </div>

            {loadError ? (
              <div className="rounded-2xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                {loadError instanceof Error ? loadError.message : "Unable to load catalog."}
              </div>
            ) : null}

            {isLoading ? (
              <div className="rounded-2xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                Loading {mode}...
              </div>
            ) : sections.length === 0 ? (
              <EmptyState mode={mode} />
            ) : (
              <div className="flex flex-col gap-11">
                {mode === "plugins"
                  ? pluginSections.map((section) => (
                      <section key={section.title} className="space-y-4">
                        <SectionHeader title={section.title} />
                        <div className={sectionGridClassName(section.items.length)}>
                          {section.items.map((entry) => (
                            <PluginRow key={`${entry.marketplace.path}:${entry.plugin.id}`} entry={entry} />
                          ))}
                        </div>
                      </section>
                    ))
                  : skillSections.map((section) => (
                      <section key={section.title} className="space-y-4">
                        <SectionHeader title={section.title} />
                        <div className={sectionGridClassName(section.items.length)}>
                          {section.items.map((skill) => (
                            <SkillRow key={skill.path} skill={skill} />
                          ))}
                        </div>
                      </section>
                    ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </AppPageShell>
  );
}
