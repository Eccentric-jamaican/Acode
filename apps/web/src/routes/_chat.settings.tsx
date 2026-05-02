import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type BrowserClearBrowsingDataKind,
  type BrowserUsePermissionPolicy,
  type BrowserUseSettings,
  type BrowserUseSettingsPatch,
  type ProviderKind,
} from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, PlusIcon, Trash2Icon, XIcon, ZapIcon } from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  getSuggestionModelOptions,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import AppPageShell from "../components/AppPageShell";
import { isElectronRuntime } from "../env";
import { useTheme } from "../hooks/useTheme";
import { cn, newCommandId } from "../lib/utils";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { SETTINGS_SECTION_IDS } from "../settingsSections";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInsetTrigger } from "~/components/ui/sidebar";
import { useStore } from "../store";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const DEFAULT_BROWSER_USE_SETTINGS: BrowserUseSettings = {
  approvalPolicy: "alwaysAsk",
  historyPolicy: "alwaysAsk",
  blockedDomains: [],
  allowedDomains: [],
};

const BROWSER_PERMISSION_OPTIONS: ReadonlyArray<{
  value: BrowserUsePermissionPolicy;
  label: string;
}> = [
  { value: "alwaysAsk", label: "Always ask" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
];

const BROWSING_DATA_OPTIONS: ReadonlyArray<{
  value: BrowserClearBrowsingDataKind;
  label: string;
}> = [
  { value: "all", label: "Clear all browsing data" },
  { value: "cookies", label: "Clear cookies" },
  { value: "cache", label: "Clear cache" },
  { value: "siteData", label: "Clear site data" },
];

function normalizeBrowserDomainInput(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.replace(/^\.+|\.+$/g, "");
  return normalized && normalized.includes(".") ? normalized : null;
}

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    description:
      "Save OpenCode model slugs in `<providerID>/<modelID>` format for the picker and `/model` command.",
    placeholder: "provider/model",
    example: "openai/gpt-4.1",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "claude-model-slug",
    example: "claude-sonnet-4-6-latest",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
      return settings.customCodexModels;
    case "opencode":
      return settings.customOpencodeModels;
    case "claudeAgent":
      return settings.customClaudeModels;
    default:
      return [];
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
      return defaults.customCodexModels;
    case "opencode":
      return defaults.customOpencodeModels;
    case "claudeAgent":
      return defaults.customClaudeModels;
    default:
      return [];
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
      return { customCodexModels: models };
    case "opencode":
      return { customOpencodeModels: models };
    case "claudeAgent":
      return { customClaudeModels: models };
    default:
      return {};
  }
}

function SettingsRouteView() {
  const usesDesktopAppChrome = isElectronRuntime();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const browserSettingsQuery = useQuery({
    queryKey: ["desktop-browser", "settings"],
    queryFn: () => ensureNativeApi().browser.getSettings(),
    enabled: usesDesktopAppChrome,
  });
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    opencode: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [blockedDomainInput, setBlockedDomainInput] = useState("");
  const [allowedDomainInput, setAllowedDomainInput] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [selectedBrowsingDataKind, setSelectedBrowsingDataKind] =
    useState<BrowserClearBrowsingDataKind>("all");
  const [clearingBrowsingData, setClearingBrowsingData] =
    useState<BrowserClearBrowsingDataKind | null>(null);
  const [browsingDataStatus, setBrowsingDataStatus] = useState<string | null>(null);

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const newThreadSuggestionsEnabled = settings.newThreadSuggestionsEnabled;
  const newThreadSuggestionModel = settings.newThreadSuggestionModel;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const opencodeServerSettings = serverConfigQuery.data?.settings?.providers.opencode ?? null;
  const [opencodeBinaryPathDraft, setOpencodeBinaryPathDraft] = useState(
    opencodeServerSettings?.binaryPath ?? "",
  );
  const [opencodeServerUrlDraft, setOpencodeServerUrlDraft] = useState(
    opencodeServerSettings?.serverUrl ?? "",
  );
  const [opencodeServerPasswordDraft, setOpencodeServerPasswordDraft] = useState(
    opencodeServerSettings?.serverPassword ?? "",
  );
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const suggestionModelOptions = getSuggestionModelOptions({
    customCodexModels: settings.customCodexModels,
    customOpencodeModels: opencodeServerSettings?.customModels ?? [],
    customClaudeModels: settings.customClaudeModels,
    selectedModel: settings.newThreadSuggestionModel,
  });
  const browserUseSettings = browserSettingsQuery.data ?? DEFAULT_BROWSER_USE_SETTINGS;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const updateBrowserUseSettings = useCallback(
    async (patch: BrowserUseSettingsPatch) => {
      const api = ensureNativeApi();
      await api.browser.updateSettings(patch);
      await queryClient.invalidateQueries({ queryKey: ["desktop-browser", "settings"] });
    },
    [queryClient],
  );

  const clearBrowsingData = useCallback(async (kind: BrowserClearBrowsingDataKind) => {
    setBrowsingDataStatus(null);
    setClearingBrowsingData(kind);
    try {
      await ensureNativeApi().browser.clearBrowsingData({ kind });
      setBrowsingDataStatus(
        kind === "all" ? "Browsing data cleared." : `${kind === "siteData" ? "Site data" : kind} cleared.`,
      );
    } catch (error) {
      setBrowsingDataStatus(
        error instanceof Error ? error.message : "Unable to clear browsing data.",
      );
    } finally {
      setClearingBrowsingData(null);
    }
  }, []);

  const addBrowserDomain = useCallback(
    (list: "blockedDomains" | "allowedDomains", value: string) => {
      const normalized = normalizeBrowserDomainInput(value);
      if (!normalized) {
        setDomainError("Enter a valid domain, like example.com.");
        return;
      }
      const current = browserUseSettings[list];
      if (current.includes(normalized)) {
        setDomainError("That domain is already saved.");
        return;
      }
      setDomainError(null);
      void updateBrowserUseSettings({ [list]: [...current, normalized] });
      if (list === "blockedDomains") {
        setBlockedDomainInput("");
      } else {
        setAllowedDomainInput("");
      }
    },
    [browserUseSettings, updateBrowserUseSettings],
  );

  const removeBrowserDomain = useCallback(
    (list: "blockedDomains" | "allowedDomains", domain: string) => {
      void updateBrowserUseSettings({
        [list]: browserUseSettings[list].filter((entry) => entry !== domain),
      });
    },
    [browserUseSettings, updateBrowserUseSettings],
  );

  useEffect(() => {
    setOpencodeBinaryPathDraft(opencodeServerSettings?.binaryPath ?? "");
    setOpencodeServerUrlDraft(opencodeServerSettings?.serverUrl ?? "");
    setOpencodeServerPasswordDraft(opencodeServerSettings?.serverPassword ?? "");
  }, [
    opencodeServerSettings?.binaryPath,
    opencodeServerSettings?.serverPassword,
    opencodeServerSettings?.serverUrl,
  ]);

  const updateOpenCodeServerSettings = useCallback(
    async (
      patch: Partial<{
        enabled: boolean;
        binaryPath: string;
        serverUrl: string;
        serverPassword: string;
        customModels: string[];
      }>,
    ) => {
      const api = ensureNativeApi();
      await api.server.updateSettings({
        providers: {
          opencode: patch,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["server", "config"] });
    },
    [queryClient],
  );

  const commitOpenCodeBinaryPath = useCallback(() => {
    if ((opencodeServerSettings?.binaryPath ?? "") === opencodeBinaryPathDraft) {
      return;
    }
    void updateOpenCodeServerSettings({ binaryPath: opencodeBinaryPathDraft });
  }, [opencodeBinaryPathDraft, opencodeServerSettings?.binaryPath, updateOpenCodeServerSettings]);

  const commitOpenCodeServerUrl = useCallback(() => {
    if ((opencodeServerSettings?.serverUrl ?? "") === opencodeServerUrlDraft) {
      return;
    }
    void updateOpenCodeServerSettings({ serverUrl: opencodeServerUrlDraft });
  }, [opencodeServerSettings?.serverUrl, opencodeServerUrlDraft, updateOpenCodeServerSettings]);

  const commitOpenCodeServerPassword = useCallback(() => {
    if ((opencodeServerSettings?.serverPassword ?? "") === opencodeServerPasswordDraft) {
      return;
    }
    void updateOpenCodeServerSettings({ serverPassword: opencodeServerPasswordDraft });
  }, [
    opencodeServerPasswordDraft,
    opencodeServerSettings?.serverPassword,
    updateOpenCodeServerSettings,
  ]);

  const addCustomModel = useCallback((provider: ProviderKind) => {
    const customModelInput = customModelInputByProvider[provider];
    const customModels =
      provider === "opencode"
        ? (opencodeServerSettings?.customModels ?? [])
        : getCustomModelsForProvider(settings, provider);
    const normalized = normalizeModelSlug(customModelInput, provider);
    if (!normalized) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "Enter a model slug.",
      }));
      return;
    }
    if (getModelOptions(provider).some((option) => option.slug === normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That model is already built in.",
      }));
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
      }));
      return;
    }
    if (customModels.includes(normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That custom model is already saved.",
      }));
      return;
    }

    const write =
      provider === "opencode"
        ? updateOpenCodeServerSettings({ customModels: [...customModels, normalized] })
        : Promise.resolve(
            updateSettings(patchCustomModels(provider, [...customModels, normalized])),
          );
    void write.then(() => {
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    });
  }, [customModelInputByProvider, opencodeServerSettings?.customModels, settings, updateOpenCodeServerSettings, updateSettings]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels =
        provider === "opencode"
          ? (opencodeServerSettings?.customModels ?? [])
          : getCustomModelsForProvider(settings, provider);
      if (provider === "opencode") {
        void updateOpenCodeServerSettings({
          customModels: customModels.filter((model) => model !== slug),
        });
      } else {
        updateSettings(patchCustomModels(provider, customModels.filter((model) => model !== slug)));
      }
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [opencodeServerSettings?.customModels, settings, updateOpenCodeServerSettings, updateSettings],
  );

  const archivedGroups = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          threads: threads
            .filter((thread) => thread.projectId === project.id && thread.archivedAt != null)
            .toSorted((left, right) =>
              (right.archivedAt ?? right.updatedAt).localeCompare(left.archivedAt ?? left.updatedAt),
            ),
        }))
        .filter((group) => group.threads.length > 0),
    [projects, threads],
  );

  const unarchiveThread = useCallback(async (threadId: string) => {
    const api = ensureNativeApi();
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: threadId as never,
    });
  }, []);

  const deleteArchivedThread = useCallback(
    async (threadId: string, threadTitle: string) => {
      const api = ensureNativeApi();
      const confirmed = settings.confirmThreadDelete
        ? await api.dialogs.confirm(
            [`Delete archived thread "${threadTitle}"?`, "This action cannot be undone."].join("\n"),
          )
        : true;
      if (!confirmed) {
        return;
      }

      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadId as never,
      });
    },
    [settings.confirmThreadDelete],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: string, threadTitle: string, position: { x: number; y: number }) => {
      const api = ensureNativeApi();
      const clicked = await api.contextMenu.show(
        [
          { id: "restore", label: "Restore" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );
      if (clicked === "restore") {
        await unarchiveThread(threadId);
        return;
      }
      if (clicked === "delete") {
        await deleteArchivedThread(threadId, threadTitle);
      }
    },
    [deleteArchivedThread, unarchiveThread],
  );

  return (
    <AppPageShell className="h-dvh text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-page-shell-surface)] text-foreground">
        <header
          className={cn(
            "flex items-center px-3 sm:px-5",
            usesDesktopAppChrome ? "h-[var(--app-desktop-content-header-height)]" : "py-2 sm:py-3",
          )}
          data-testid="settings-top-header"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <SidebarInsetTrigger className="shrink-0 md:hidden" />
            <span
              className="min-w-0 truncate text-sm font-medium text-foreground"
              data-testid="settings-header-label"
            >
              Settings
            </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-3">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section
              id={SETTINGS_SECTION_IDS.appearance}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
            </section>

            <section
              id={SETTINGS_SECTION_IDS.codexAppServer}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">OpenCode Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure how T3 Code connects to OpenCode for provider sessions and model
                  discovery.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Enable OpenCode</p>
                    <p className="text-xs text-muted-foreground">
                      Disable this to hide OpenCode from new provider sessions.
                    </p>
                  </div>
                  <Switch
                    checked={opencodeServerSettings?.enabled ?? true}
                    onCheckedChange={(checked) => {
                      void updateOpenCodeServerSettings({ enabled: Boolean(checked) });
                    }}
                    aria-label="Enable OpenCode"
                  />
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Binary path</span>
                  <Input
                    value={opencodeBinaryPathDraft}
                    onChange={(event) => {
                      setOpencodeBinaryPathDraft(event.target.value);
                    }}
                    onBlur={commitOpenCodeBinaryPath}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="opencode"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>opencode</code> from your PATH.
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Server URL</span>
                  <Input
                    value={opencodeServerUrlDraft}
                    onChange={(event) => {
                      setOpencodeServerUrlDraft(event.target.value);
                    }}
                    onBlur={commitOpenCodeServerUrl}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="http://127.0.0.1:4096"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to let T3 Code spawn the OpenCode server locally when needed.
                  </span>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Server password</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={opencodeServerPasswordDraft}
                    onChange={(event) => {
                      setOpencodeServerPasswordDraft(event.target.value);
                    }}
                    onBlur={commitOpenCodeServerPassword}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="Optional password"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Used only when the configured OpenCode server requires authentication.
                  </span>
                </label>
              </div>
            </section>

            <section
              id={SETTINGS_SECTION_IDS.models}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels =
                    provider === "opencode"
                      ? (opencodeServerSettings?.customModels ?? [])
                      : getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => {
                                  if (provider === "opencode") {
                                    void updateOpenCodeServerSettings({ customModels: [] });
                                    return;
                                  }
                                  updateSettings(
                                    patchCustomModels(
                                      provider,
                                      [...getDefaultCustomModelsForProvider(defaults, provider)],
                                    ),
                                  );
                                }}
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" && shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="mb-4">
                    <h3 className="text-sm font-medium text-foreground">New-thread suggestions</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Show subtle task suggestions on the new-thread landing. When you choose an
                      optional model here, we use it only to lightly rewrite or rank the
                      heuristically derived suggestions.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Enable suggested tasks
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Suggestions appear only on an empty new-thread landing and disappear as
                          soon as you start typing.
                        </p>
                      </div>
                      <Switch
                        checked={newThreadSuggestionsEnabled}
                        onCheckedChange={(checked) =>
                          updateSettings({
                            newThreadSuggestionsEnabled: Boolean(checked),
                          })
                        }
                        aria-label="Enable new-thread suggested tasks"
                      />
                    </div>

                    <label className="block space-y-1">
                      <span className="text-xs font-medium text-foreground">
                        Suggestion model
                      </span>
                      <Select
                        items={[
                          { label: "Heuristics only", value: "__none__" },
                          ...suggestionModelOptions.map((option) => ({
                            label: `${PROVIDER_DISPLAY_NAMES[option.provider]} - ${option.name}`,
                            value: option.slug,
                          })),
                        ]}
                        value={newThreadSuggestionModel ?? "__none__"}
                        onValueChange={(value) => {
                          updateSettings({
                            newThreadSuggestionModel:
                              !value || value === "__none__" ? null : value,
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          <SelectItem value="__none__">Heuristics only</SelectItem>
                          {suggestionModelOptions.map((option) => (
                          <SelectItem key={option.slug} value={option.slug}>
                            {PROVIDER_DISPLAY_NAMES[option.provider]} - {option.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                      </Select>
                      <span className="text-xs text-muted-foreground">
                        Optional. If unset, the landing uses deterministic project signals only.
                      </span>
                    </label>

                    {(newThreadSuggestionsEnabled !== defaults.newThreadSuggestionsEnabled ||
                      newThreadSuggestionModel !== defaults.newThreadSuggestionModel) && (
                      <div className="flex justify-end">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateSettings({
                              newThreadSuggestionsEnabled:
                                defaults.newThreadSuggestionsEnabled,
                              newThreadSuggestionModel: defaults.newThreadSuggestionModel,
                            })
                          }
                        >
                          Restore suggestion defaults
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section
              id={SETTINGS_SECTION_IDS.responses}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Keep inspect mode after capture</p>
                  <p className="text-xs text-muted-foreground">
                    Keep inspect mode enabled so you can capture multiple elements in one prompt.
                  </p>
                </div>
                <Switch
                  checked={settings.keepInspectModeAfterCapture}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      keepInspectModeAfterCapture: Boolean(checked),
                    })
                  }
                  aria-label="Keep inspect mode after capture"
                />
              </div>

              {settings.keepInspectModeAfterCapture !== defaults.keepInspectModeAfterCapture ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        keepInspectModeAfterCapture: defaults.keepInspectModeAfterCapture,
                      })
                    }
                  >
                    Restore inspect default
                  </Button>
                </div>
              ) : null}

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Wrap lines in turn diffs</p>
                  <p className="text-xs text-muted-foreground">
                    Wrap long lines in the turn diff panel instead of requiring horizontal scrolling.
                  </p>
                </div>
                <Switch
                  checked={settings.wrapTurnDiffLines}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      wrapTurnDiffLines: Boolean(checked),
                    })
                  }
                  aria-label="Wrap lines in turn diffs"
                />
              </div>

              {settings.wrapTurnDiffLines !== defaults.wrapTurnDiffLines ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        wrapTurnDiffLines: defaults.wrapTurnDiffLines,
                      })
                    }
                  >
                    Restore diff wrapping default
                  </Button>
                </div>
              ) : null}
            </section>

            <section
              id={SETTINGS_SECTION_IDS.browserUse}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Browser use</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control in-app browser storage, approvals, and domain rules used by Codex.
                </p>
              </div>

              {usesDesktopAppChrome ? (
                <div className="space-y-5">
                  <div className="rounded-xl border border-border bg-background">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">Browsing data</p>
                        <p className="text-xs text-muted-foreground">
                          Clear cookies, cache, and site storage from the shared in-app browser.
                        </p>
                      </div>
                      <Select
                        items={BROWSING_DATA_OPTIONS.map((option) => ({
                          label: option.label,
                          value: option.value,
                        }))}
                        value={selectedBrowsingDataKind}
                        onValueChange={(value) =>
                          setSelectedBrowsingDataKind(value as BrowserClearBrowsingDataKind)
                        }
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue placeholder="Clear browsing data" />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {BROWSING_DATA_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {clearingBrowsingData === option.value ? "Clearing..." : option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={clearingBrowsingData !== null}
                        onClick={() => void clearBrowsingData(selectedBrowsingDataKind)}
                      >
                        Clear
                      </Button>
                    </div>
                    {browsingDataStatus ? (
                      <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                        {browsingDataStatus}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-xl border border-border bg-background">
                    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_220px] sm:items-center">
                      <div>
                        <p className="text-sm font-medium text-foreground">Approval</p>
                        <p className="text-xs text-muted-foreground">
                          Choose if Codex asks before opening websites.
                        </p>
                      </div>
                      <Select
                        items={BROWSER_PERMISSION_OPTIONS.map((option) => ({
                          label: option.label,
                          value: option.value,
                        }))}
                        value={browserUseSettings.approvalPolicy}
                        onValueChange={(value) =>
                          void updateBrowserUseSettings({
                            approvalPolicy: value as BrowserUsePermissionPolicy,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {BROWSER_PERMISSION_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                    <div className="grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-[1fr_220px] sm:items-center">
                      <div>
                        <p className="text-sm font-medium text-foreground">History</p>
                        <p className="text-xs text-muted-foreground">
                          Choose if Codex asks before accessing browser history.
                        </p>
                      </div>
                      <Select
                        items={BROWSER_PERMISSION_OPTIONS.map((option) => ({
                          label: option.label,
                          value: option.value,
                        }))}
                        value={browserUseSettings.historyPolicy}
                        onValueChange={(value) =>
                          void updateBrowserUseSettings({
                            historyPolicy: value as BrowserUsePermissionPolicy,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {BROWSER_PERMISSION_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  </div>

                  {(
                    [
                      {
                        key: "blockedDomains",
                        title: "Blocked domains",
                        description: "Codex will never open these sites.",
                        input: blockedDomainInput,
                        setInput: setBlockedDomainInput,
                      },
                      {
                        key: "allowedDomains",
                        title: "Allowed domains",
                        description: "Domains that open without asking.",
                        input: allowedDomainInput,
                        setInput: setAllowedDomainInput,
                      },
                    ] as const
                  ).map((list) => (
                    <div key={list.key} className="space-y-2">
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">{list.title}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">{list.description}</p>
                        </div>
                        <form
                          className="flex min-w-0 items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            addBrowserDomain(list.key, list.input);
                          }}
                        >
                          <Input
                            className="h-8 w-44"
                            value={list.input}
                            onChange={(event) => list.setInput(event.target.value)}
                            placeholder="example.com"
                            spellCheck={false}
                          />
                          <Button size="xs" type="submit">
                            <PlusIcon className="mr-1 size-3.5" />
                            Add
                          </Button>
                        </form>
                      </div>

                      <div className="rounded-xl border border-border bg-background">
                        {browserUseSettings[list.key].length > 0 ? (
                          <div className="divide-y divide-border">
                            {browserUseSettings[list.key].map((domain) => (
                              <div
                                key={`${list.key}:${domain}`}
                                className="flex items-center justify-between gap-3 px-4 py-2"
                              >
                                <span className="min-w-0 truncate text-sm text-foreground">
                                  {domain}
                                </span>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Remove ${domain}`}
                                  onClick={() => removeBrowserDomain(list.key, domain)}
                                >
                                  <XIcon className="size-4" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-muted-foreground">
                            <CheckIcon className="size-4" />
                            No {list.key === "blockedDomains" ? "blocked" : "allowed"} domains
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {domainError ? <p className="text-xs text-destructive">{domainError}</p> : null}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-background px-4 py-4 text-sm text-muted-foreground">
                  Browser use settings are available in the desktop app.
                </div>
              )}
            </section>

            <section
              id={SETTINGS_SECTION_IDS.keybindings}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section
              id={SETTINGS_SECTION_IDS.safety}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread archive</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before archiving a thread.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadArchive}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadArchive: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread archive"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ||
              settings.confirmThreadArchive !== defaults.confirmThreadArchive ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                        confirmThreadArchive: defaults.confirmThreadArchive,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section
              id={SETTINGS_SECTION_IDS.archived}
              className="scroll-mt-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Archived threads</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Restore archived threads to the sidebar or delete them permanently.
                </p>
              </div>

              {archivedGroups.length === 0 ? (
                <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4 text-sm text-muted-foreground">
                  <ArchiveIcon className="size-5" />
                  <span>No archived threads yet.</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {archivedGroups.map(({ project, threads: projectThreads }) => (
                    <div key={project.id} className="rounded-xl border border-border bg-background">
                      <div className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">
                        {project.name}
                      </div>
                      <div className="divide-y divide-border">
                        {projectThreads.map((thread) => (
                          <div
                            key={thread.id}
                            className="flex items-center justify-between gap-4 px-4 py-3"
                            onContextMenu={(event) => {
                              event.preventDefault();
                              void handleArchivedThreadContextMenu(thread.id, thread.title, {
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm text-foreground">{thread.title}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                Archived{" "}
                                {thread.archivedAt
                                  ? new Date(thread.archivedAt).toLocaleString()
                                  : "recently"}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => void unarchiveThread(thread.id)}
                              >
                                <ArchiveRestoreIcon className="mr-1 size-3.5" />
                                Restore
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => void deleteArchivedThread(thread.id, thread.title)}
                              >
                                <Trash2Icon className="mr-1 size-3.5" />
                                Delete
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </AppPageShell>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
