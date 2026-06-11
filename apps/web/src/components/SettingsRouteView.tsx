import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type BrowserClearBrowsingDataKind,
  type BrowserUsePermissionPolicy,
  type BrowserUseSettings,
  type BrowserUseSettingsPatch,
  DEFAULT_COMPUTER_USE_APP_CATEGORIES,
  type ComputerUseAppCategory,
  type ComputerUseAppSummary,
  type ComputerUseSettings,
  type ComputerUseSettingsPatch,
  type ProviderKind,
  type RemoteAccessPermission,
} from "@t3tools/contracts";
import { isComputerUseAppAllowed } from "@t3tools/shared/computerUsePermissions";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleEllipsisIcon,
  CircleXIcon,
  CopyIcon,
  MonitorIcon,
  PlusIcon,
  QrCodeIcon,
  ShieldIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  getSuggestionModelOptions,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import AppPageShell from "../components/AppPageShell";
import { ProviderLogo } from "../components/ProviderLogo";
import { ProviderUpdateButton } from "../components/ProviderUpdateButton";
import { isElectronRuntime } from "../env";
import { useTheme } from "../hooks/useTheme";
import { copyTextToClipboard } from "../lib/clipboard";
import { cn, newCommandId } from "../lib/utils";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import {
  normalizeSettingsSectionId,
  SETTINGS_SECTION_IDS,
  SETTINGS_SIDEBAR_SECTIONS,
  type SettingsSectionId,
} from "../settingsSections";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { QRCodeSvg } from "../components/ui/qr-code";
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

const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: true,
  approvalPolicy: "ask",
  enabledAppCategories: [...DEFAULT_COMPUTER_USE_APP_CATEGORIES],
  allowedAppIds: [],
  blockedAppIds: [],
  captureRetentionDays: 7,
};

const COMPUTER_USE_APP_PAGE_SIZE = 12;
const REMOTE_ACCESS_QUERY_KEY = ["remote-access", "snapshot"] as const;

const COMPUTER_USE_APP_CATEGORY_LABELS: Record<
  ComputerUseAppCategory,
  { label: string; description: string }
> = {
  desktop: {
    label: "Desktop apps",
    description: "Installed apps and tools that are usually safe to target intentionally.",
  },
  agent: {
    label: "Agent apps",
    description: "A Code, T3 Code, Codex, and related agent clients.",
  },
  system: {
    label: "System apps",
    description: "Windows and Microsoft system utilities such as Settings or Calculator.",
  },
  background: {
    label: "Background apps",
    description: "Running processes without a clear installed app entry or visible window.",
  },
  other: {
    label: "Other apps",
    description: "Apps that do not cleanly fit another group.",
  },
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

const SETTINGS_SECTION_DESCRIPTIONS: Record<SettingsSectionId, string> = {
  [SETTINGS_SECTION_IDS.appearance]: "Match your workspace to the environment you are in.",
  [SETTINGS_SECTION_IDS.models]: "Tune the model picker and suggestion behavior for new work.",
  [SETTINGS_SECTION_IDS.remoteAccess]: "Pair trusted clients and control how this backend is reached.",
  [SETTINGS_SECTION_IDS.responses]: "Control how assistant output appears while work is running.",
  [SETTINGS_SECTION_IDS.browserUse]: "Set how the browser stores state and asks for approval.",
  [SETTINGS_SECTION_IDS.computerUse]: "Control desktop automation access and app permissions.",
  [SETTINGS_SECTION_IDS.keybindings]: "Open and manage the keyboard shortcuts file.",
  [SETTINGS_SECTION_IDS.safety]: "Choose when destructive thread actions ask for confirmation.",
  [SETTINGS_SECTION_IDS.providers]: "Manage agent runtimes, accounts, and local binaries.",
  [SETTINGS_SECTION_IDS.archived]: "Restore archived threads or remove them permanently.",
};

const SETTINGS_SECTION_CLASS = "space-y-4";
const SETTINGS_GROUP_CLASS = "rounded-xl bg-card/45 p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)]";
const SETTINGS_SUBGROUP_CLASS = "rounded-xl bg-background/35 p-4";
const SETTINGS_ROW_CLASS =
  "flex items-center justify-between gap-4 rounded-lg bg-background/35 px-3 py-3";
const SETTINGS_EMPTY_STATE_CLASS =
  "rounded-lg bg-background/35 px-4 py-4 text-sm text-muted-foreground";
const EMPTY_COMPUTER_USE_APPS: ComputerUseAppSummary[] = [];
const COMPUTER_USE_PERMISSION_SWITCH_CLASS =
  "justify-self-end [&_[data-slot=switch-thumb]]:transition-none [&_[data-slot=switch-thumb]]:will-change-auto";

const PAIRING_PERMISSION_OPTIONS = [
  {
    id: "viewEnvironment",
    scope: "orchestration:read",
    label: "View environment",
    description: "Read threads, status, diffs, and configuration.",
  },
  {
    id: "operateTasks",
    scope: "orchestration:operate",
    label: "Operate tasks",
    description: "Start tasks and perform changes in the environment.",
  },
  {
    id: "useTerminals",
    scope: "terminal:operate",
    label: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    id: "writeReviews",
    scope: "review:write",
    label: "Write reviews",
    description: "Create comments while reviewing changes.",
  },
  {
    id: "viewAccess",
    scope: "access:read",
    label: "View access",
    description: "Inspect pairing links and authorized clients.",
  },
  {
    id: "manageAccess",
    scope: "access:write",
    label: "Manage access",
    description: "Issue and revoke credentials for other clients.",
  },
  {
    id: "viewRelay",
    scope: "relay:read",
    label: "View relay",
    description: "Inspect managed relay connectivity.",
  },
  {
    id: "manageRelay",
    scope: "relay:write",
    label: "Manage relay",
    description: "Change managed tunnel connectivity.",
  },
] as const;

type PairingPermissionId = (typeof PAIRING_PERMISSION_OPTIONS)[number]["id"];

const PAIRING_PERMISSION_PRESETS: Record<"readOnly" | "standard", ReadonlySet<PairingPermissionId>> = {
  readOnly: new Set(["viewEnvironment", "viewAccess", "viewRelay"]),
  standard: new Set([
    "viewEnvironment",
    "operateTasks",
    "useTerminals",
    "writeReviews",
    "viewRelay",
  ]),
};

function arePairingPermissionSetsEqual(
  left: ReadonlySet<PairingPermissionId>,
  right: ReadonlySet<PairingPermissionId>,
) {
  return left.size === right.size && [...left].every((permissionId) => right.has(permissionId));
}

function pairingPermissionIdsToScopes(
  permissionIds: ReadonlySet<PairingPermissionId>,
): RemoteAccessPermission[] {
  return PAIRING_PERMISSION_OPTIONS.filter((permission) => permissionIds.has(permission.id)).map(
    (permission) => permission.scope,
  );
}

function resolvePairingUrl(baseUrl: string, credential: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/pair";
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

function formatPairingLinkExpiresIn(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return "Expired";
  }
  const remainingMinutes = Math.floor(remainingMs / 60_000);
  const remainingSeconds = Math.floor((remainingMs % 60_000) / 1_000);
  if (remainingMinutes >= 1) {
    return `${remainingMinutes}m ${remainingSeconds}s left`;
  }
  return `${remainingSeconds}s left`;
}

function isPairingLinkStillActive(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) {
    return true;
  }
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

async function copyRemoteAccessValue(value: string, title: string) {
  const copied = await copyTextToClipboard(value);
  toastManager.add({
    type: copied ? "success" : "error",
    title: copied ? title : "Clipboard unavailable",
  });
}

function BlurredEmail({ value }: { value: string }) {
  return (
    <span className="rounded-sm blur-xs select-none" title={value} aria-label={value}>
      {value}
    </span>
  );
}

function BlurredSecret({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={cn("rounded-sm blur-xs select-none", className)}
      title={value}
      aria-label={value}
    >
      {value}
    </span>
  );
}

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

function groupComputerUseApps(
  apps: readonly ComputerUseAppSummary[],
): Record<ComputerUseAppCategory, ComputerUseAppSummary[]> {
  const groups: Record<ComputerUseAppCategory, ComputerUseAppSummary[]> = {
    desktop: [],
    agent: [],
    system: [],
    background: [],
    other: [],
  };
  for (const app of apps) {
    const category = app.category === "agent" ? "desktop" : (app.category ?? "other");
    groups[category].push(app);
  }
  for (const category of DEFAULT_COMPUTER_USE_APP_CATEGORIES) {
    groups[category] = groups[category].toSorted((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }
  return groups;
}

function computerUseAppDescription(app: ComputerUseAppSummary): string {
  const windowTitle = app.windows.find((window) => window.isFocused || window.isMain)?.title;
  if (windowTitle) return windowTitle;
  if (app.isRunning) {
    return `${app.windows.length} window${app.windows.length === 1 ? "" : "s"} open`;
  }
  return app.launchId ? "Installed app" : "Discovered app";
}

function computerUseAppPermissionCategory(app: ComputerUseAppSummary): ComputerUseAppCategory {
  return app.category === "agent" ? "desktop" : app.category;
}

function ComputerUseAppIcon(props: { app: ComputerUseAppSummary }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = props.app.iconUrl ?? null;
  const failed = iconUrl !== null && failedIconUrl === iconUrl;

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-hidden="true"
        className="size-4 shrink-0 rounded-sm object-contain"
        loading="lazy"
        draggable={false}
        onError={() => setFailedIconUrl(iconUrl)}
      />
    );
  }

  return <MonitorIcon className="size-4 shrink-0 text-muted-foreground/70" />;
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
    example: "claude-mythos-5",
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
  const activeSection = useRouterState({
    select: (state) => normalizeSettingsSectionId(state.location.search.section),
  });
  const activeSectionLabel =
    SETTINGS_SIDEBAR_SECTIONS.find((section) => section.id === activeSection)?.label ?? "Settings";
  const activeSectionDescription = SETTINGS_SECTION_DESCRIPTIONS[activeSection];
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
  const computerUseSettingsQuery = useQuery({
    queryKey: ["computer-use", "settings"],
    queryFn: () => ensureNativeApi().computerUse.getSettings(),
  });
  const computerUseAppsQuery = useQuery({
    queryKey: ["computer-use", "apps"],
    queryFn: () => ensureNativeApi().computerUse.listApps(),
    retry: false,
    staleTime: 5_000,
  });
  const remoteAccessQuery = useQuery({
    queryKey: REMOTE_ACCESS_QUERY_KEY,
    queryFn: () => ensureNativeApi().remoteAccess.getSnapshot(),
    staleTime: 5_000,
  });
  const applyRemoteAccessSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<ReturnType<typeof ensureNativeApi>["remoteAccess"]["getSnapshot"]>>) => {
      queryClient.setQueryData(REMOTE_ACCESS_QUERY_KEY, snapshot);
    },
    [queryClient],
  );
  const createPairingLinkMutation = useMutation({
    mutationFn: (input: {
      label: string;
      scopes: RemoteAccessPermission[];
    }) => ensureNativeApi().remoteAccess.createPairingLink(input),
    onSuccess: (result) => {
      applyRemoteAccessSnapshot(result.snapshot);
      setPairingClientName("");
      setPairingPermissionIds(new Set(PAIRING_PERMISSION_PRESETS.standard));
      setPairingLinkDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Pairing link created",
        description: "Copy the pairing URL or code from the client list.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not create pairing link",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const setNetworkAccessMutation = useMutation({
    mutationFn: (enabled: boolean) => ensureNativeApi().remoteAccess.setNetworkAccess({ enabled }),
    onSuccess: applyRemoteAccessSnapshot,
  });
  const setTailscaleHttpsMutation = useMutation({
    mutationFn: (enabled: boolean) => ensureNativeApi().remoteAccess.setTailscaleHttps({ enabled }),
    onSuccess: applyRemoteAccessSnapshot,
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not update Tailscale HTTPS",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const revokePairingLinkMutation = useMutation({
    mutationFn: (id: string) => ensureNativeApi().remoteAccess.revokePairingLink({ id }),
    onSuccess: (snapshot) => {
      applyRemoteAccessSnapshot(snapshot);
      toastManager.add({ type: "success", title: "Pairing link revoked" });
    },
  });
  const revokeClientMutation = useMutation({
    mutationFn: (id: string) => ensureNativeApi().remoteAccess.revokeClient({ id }),
    onSuccess: (snapshot) => {
      applyRemoteAccessSnapshot(snapshot);
      toastManager.add({ type: "success", title: "Client revoked" });
    },
  });
  const revokeOtherClientsMutation = useMutation({
    mutationFn: () => ensureNativeApi().remoteAccess.revokeOtherClients(),
    onSuccess: (snapshot) => {
      applyRemoteAccessSnapshot(snapshot);
      toastManager.add({ type: "success", title: "Other clients revoked" });
    },
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
  const [expandedComputerUseAppGroups, setExpandedComputerUseAppGroups] = useState<
    Record<ComputerUseAppCategory, boolean>
  >({
    desktop: true,
    agent: true,
    system: false,
    background: false,
    other: false,
  });
  const [computerUseAppVisibleCounts, setComputerUseAppVisibleCounts] = useState<
    Record<ComputerUseAppCategory, number>
  >({
    desktop: COMPUTER_USE_APP_PAGE_SIZE,
    agent: COMPUTER_USE_APP_PAGE_SIZE,
    system: COMPUTER_USE_APP_PAGE_SIZE,
    background: COMPUTER_USE_APP_PAGE_SIZE,
    other: COMPUTER_USE_APP_PAGE_SIZE,
  });

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
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<ProviderKind>>(
    () => new Set<ProviderKind>(["codex", "opencode", "claudeAgent"]),
  );
  const [pairingLinkDialogOpen, setPairingLinkDialogOpen] = useState(false);
  const [pairingClientName, setPairingClientName] = useState("");
  const [pairingPermissionIds, setPairingPermissionIds] = useState<ReadonlySet<PairingPermissionId>>(
    () => new Set(PAIRING_PERMISSION_PRESETS.standard),
  );
  const [pairingNowMs, setPairingNowMs] = useState(() => Date.now());
  const toggleProviderExpanded = useCallback((provider: ProviderKind) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);
  const applyPairingPermissionPreset = useCallback(
    (preset: keyof typeof PAIRING_PERMISSION_PRESETS) => {
      setPairingPermissionIds(new Set(PAIRING_PERMISSION_PRESETS[preset]));
    },
    [],
  );
  const togglePairingPermission = useCallback((permissionId: PairingPermissionId) => {
    setPairingPermissionIds((prev) => {
      const next = new Set(prev);
      if (next.has(permissionId)) {
        next.delete(permissionId);
      } else {
        next.add(permissionId);
      }
      return next;
    });
  }, []);
  const handlePairingDialogOpenChange = useCallback((open: boolean) => {
    setPairingLinkDialogOpen(open);
  }, []);
  const handleCreatePairingLink = useCallback(() => {
    createPairingLinkMutation.mutate({
      label: pairingClientName,
      scopes: pairingPermissionIdsToScopes(pairingPermissionIds),
    });
  }, [createPairingLinkMutation, pairingClientName, pairingPermissionIds]);
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const suggestionModelOptions = getSuggestionModelOptions({
    customCodexModels: settings.customCodexModels,
    customOpencodeModels: opencodeServerSettings?.customModels ?? [],
    customClaudeModels: settings.customClaudeModels,
    selectedModel: settings.newThreadSuggestionModel,
  });
  const browserUseSettings = browserSettingsQuery.data ?? DEFAULT_BROWSER_USE_SETTINGS;
  const computerUseSettings =
    computerUseSettingsQuery.data ??
    serverConfigQuery.data?.settings?.computerUse ??
    DEFAULT_COMPUTER_USE_SETTINGS;
  const computerUseAvailability = computerUseAppsQuery.data?.status;
  const computerUseUnavailable = computerUseAvailability?.available === false;
  const computerUseApps = computerUseAppsQuery.data?.apps ?? EMPTY_COMPUTER_USE_APPS;
  const computerUseAppsByCategory = useMemo(
    () => groupComputerUseApps(computerUseApps),
    [computerUseApps],
  );

  const providers = serverConfigQuery.data?.providers;
  const codexStatus = providers?.find((p) => p.provider === "codex");
  const opencodeStatus = providers?.find((p) => p.provider === "opencode");
  const claudeStatus = providers?.find((p) => p.provider === "claudeAgent");

  const providerAccounts = serverConfigQuery.data?.providerAccounts;
  const codexAccount = providerAccounts?.find((a) => a.provider === "codex");
  const claudeAccount = providerAccounts?.find((a) => a.provider === "claudeAgent");
  const claudeAuthenticationLabel =
    claudeAccount?.state === "authenticated"
      ? claudeAccount.account && "email" in claudeAccount.account
        ? <BlurredEmail value={claudeAccount.account.email} />
        : "Signed in"
      : claudeAccount?.state === "error"
        ? claudeAccount.message ?? "Error"
        : claudeAccount?.state === "loading"
          ? "Checking..."
          : claudeStatus?.authStatus === "authenticated"
            ? "Signed in"
            : claudeStatus?.authStatus === "unknown"
              ? "Authentication status unavailable"
              : "Not signed in";
  const claudeCollapsedAuthenticationLabel =
    claudeAccount?.state === "authenticated"
      ? claudeAccount.account && "email" in claudeAccount.account
        ? (
          <>
            Signed in as <BlurredEmail value={claudeAccount.account.email} />
          </>
        )
        : claudeAccount.authMode === "apikey"
          ? "Signed in (API key)"
          : "Signed in"
      : claudeStatus?.authStatus === "authenticated"
        ? "Signed in"
        : claudeStatus?.authStatus === "unknown"
          ? "Authentication status unavailable"
          : "Not signed in";
  const claudeAuthenticationModeLabel =
    claudeAccount?.authMode === "apikey"
      ? "API key"
      : claudeAccount?.authMode
        ? claudeAccount.authMode
        : claudeStatus?.authStatus === "authenticated"
          ? "Claude CLI"
          : "";

  const startLoginMutation = useMutation({
    mutationFn: async () => {
      const result = await ensureNativeApi().server.startProviderLogin({
        provider: "codex",
        type: "chatgpt",
      });
      return result;
    },
    onSuccess: (result) => {
      void ensureNativeApi().shell.openExternal(result.authUrl);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
  });

  const isLoggingIn = startLoginMutation.isPending;
  const loginId = startLoginMutation.data?.loginId ?? null;

  const cancelLoginMutation = useMutation({
    mutationFn: async (id: string) => {
      return ensureNativeApi().server.cancelProviderLogin({
        provider: "codex",
        loginId: id,
      });
    },
  });

  const isCancelingLogin = cancelLoginMutation.isPending;

  const logoutMutation = useMutation({
    mutationFn: async () => {
      return ensureNativeApi().server.logoutProvider({ provider: "codex" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
  });

  const isLoggingOut = logoutMutation.isPending;

  const handleCodexAuthAction = useCallback(() => {
    if (codexAccount?.state === "authenticated") {
      logoutMutation.mutate();
      return;
    }
    if (isLoggingIn && loginId) {
      cancelLoginMutation.mutate(loginId);
      return;
    }
    startLoginMutation.mutate();
  }, [
    codexAccount?.state,
    isLoggingIn,
    loginId,
    cancelLoginMutation,
    logoutMutation,
    startLoginMutation,
  ]);

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

  const updateComputerUseSettings = useCallback(
    async (patch: ComputerUseSettingsPatch) => {
      await ensureNativeApi().computerUse.updateSettings(patch);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["computer-use", "settings"] }),
        queryClient.invalidateQueries({ queryKey: ["server", "config"] }),
      ]);
    },
    [queryClient],
  );

  const toggleComputerUseAppCategory = useCallback(
    (category: ComputerUseAppCategory, enabled: boolean) => {
      const categories = new Set(computerUseSettings.enabledAppCategories);
      if (enabled) {
        categories.add(category);
      } else {
        categories.delete(category);
      }
      void updateComputerUseSettings({ enabledAppCategories: [...categories] });
    },
    [computerUseSettings.enabledAppCategories, updateComputerUseSettings],
  );

  const toggleComputerUseAppPermission = useCallback(
    (app: ComputerUseAppSummary, enabled: boolean) => {
      const allowed = new Set(computerUseSettings.allowedAppIds);
      const blocked = new Set(computerUseSettings.blockedAppIds);
      const categoryEnabled = computerUseSettings.enabledAppCategories.includes(
        computerUseAppPermissionCategory(app),
      );
      if (enabled) {
        blocked.delete(app.appId);
        if (!categoryEnabled) {
          allowed.add(app.appId);
        } else {
          allowed.delete(app.appId);
        }
      } else {
        allowed.delete(app.appId);
        if (categoryEnabled) {
          blocked.add(app.appId);
        } else {
          blocked.delete(app.appId);
        }
      }
      void updateComputerUseSettings({
        allowedAppIds: [...allowed],
        blockedAppIds: [...blocked],
      });
    },
    [
      computerUseSettings.allowedAppIds,
      computerUseSettings.blockedAppIds,
      computerUseSettings.enabledAppCategories,
      updateComputerUseSettings,
    ],
  );

  const clearBrowsingData = useCallback(async (kind: BrowserClearBrowsingDataKind) => {
    setBrowsingDataStatus(null);
    setClearingBrowsingData(kind);
    try {
      await ensureNativeApi().browser.clearBrowsingData({ kind });
      setBrowsingDataStatus(
        kind === "all"
          ? "Browsing data cleared."
          : `${kind === "siteData" ? "Site data" : kind} cleared.`,
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

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
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
    },
    [
      customModelInputByProvider,
      opencodeServerSettings?.customModels,
      settings,
      updateOpenCodeServerSettings,
      updateSettings,
    ],
  );

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
        updateSettings(
          patchCustomModels(
            provider,
            customModels.filter((model) => model !== slug),
          ),
        );
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
              (right.archivedAt ?? right.updatedAt).localeCompare(
                left.archivedAt ?? left.updatedAt,
              ),
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
            [`Delete archived thread "${threadTitle}"?`, "This action cannot be undone."].join(
              "\n",
            ),
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

  const serverHost = serverConfigQuery.data?.serverHost;
  const serverPort = serverConfigQuery.data?.serverPort;
  const remoteProtocol =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http";
  const remoteDisplayHost =
    serverHost && serverHost !== "0.0.0.0"
      ? serverHost
      : typeof window !== "undefined"
        ? window.location.hostname
        : "127.0.0.1";
  const remoteConnectionUrl = `${remoteProtocol}://${remoteDisplayHost}${
    serverPort ? `:${serverPort}` : ""
  }/`;
  const tailscaleHttpsUrl =
    remoteDisplayHost.endsWith(".ts.net") || remoteDisplayHost.includes("tail")
      ? `https://${remoteDisplayHost}${serverPort ? `:${serverPort}` : ""}/`
      : remoteConnectionUrl;
  const remoteAccessSnapshot = remoteAccessQuery.data;
  const remoteNetworkEnabled =
    remoteAccessSnapshot?.networkAccessEnabled ?? Boolean(serverHost && serverHost !== "127.0.0.1");
  const tailscaleHttpsEnabled = remoteAccessSnapshot?.tailscaleHttpsEnabled ?? false;
  const resolvedTailscaleHttpsUrl = remoteAccessSnapshot?.tailscaleHttpsUrl ?? tailscaleHttpsUrl;
  const remotePairingLinks = (remoteAccessSnapshot?.pairingLinks ?? []).filter((pairingLink) =>
    isPairingLinkStillActive(pairingLink.expiresAt, pairingNowMs),
  );
  const remoteClients = remoteAccessSnapshot?.clients ?? [];
  const remoteEnvironments = remoteAccessSnapshot?.remoteEnvironments ?? [];
  const readOnlyPairingPresetSelected = arePairingPermissionSetsEqual(
    pairingPermissionIds,
    PAIRING_PERMISSION_PRESETS.readOnly,
  );
  const standardPairingPresetSelected = arePairingPermissionSetsEqual(
    pairingPermissionIds,
    PAIRING_PERMISSION_PRESETS.standard,
  );

  useEffect(() => {
    if (remotePairingLinks.length === 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setPairingNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [remotePairingLinks.length]);

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
              aria-hidden="true"
              className="block h-4 w-px opacity-0"
              data-testid="settings-header-label"
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-7">
            <header className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-normal text-foreground">
                {activeSectionLabel}
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {activeSectionDescription}
              </p>
            </header>

            {activeSection === SETTINGS_SECTION_IDS.appearance ? (
              <section id={SETTINGS_SECTION_IDS.appearance} className={SETTINGS_SECTION_CLASS}>
                <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                  {THEME_OPTIONS.map((option) => {
                    const selected = theme === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`flex w-full items-start justify-between rounded-lg px-3 py-3 text-left transition-colors ${
                          selected
                            ? "bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.38)]"
                            : "bg-background/35 text-muted-foreground hover:bg-accent/45"
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

                <p className="text-xs text-muted-foreground">
                  Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
                </p>
              </section>
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.models ? (
              <section id={SETTINGS_SECTION_IDS.models} className={SETTINGS_SECTION_CLASS}>
                <div className="space-y-5">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">
                      Default service tier
                    </span>
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
                        className={SETTINGS_SUBGROUP_CLASS}
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
                                      patchCustomModels(provider, [
                                        ...getDefaultCustomModelsForProvider(defaults, provider),
                                      ]),
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
                                    className="flex items-center justify-between gap-3 rounded-lg bg-background/45 px-3 py-2"
                                  >
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                      {provider === "codex" &&
                                      shouldShowFastTierIcon(slug, codexServiceTier) ? (
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
                              <div className="rounded-lg bg-background/35 px-3 py-4 text-xs text-muted-foreground">
                                No custom models saved yet.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                    );
                  })}

                  <div className={SETTINGS_SUBGROUP_CLASS}>
                    <div className="mb-4">
                      <h3 className="text-sm font-medium text-foreground">
                        New-thread suggestions
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Show subtle task suggestions on the new-thread landing. When you choose an
                        optional model here, we use it only to lightly rewrite or rank the
                        heuristically derived suggestions.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <div className={SETTINGS_ROW_CLASS}>
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
                                newThreadSuggestionsEnabled: defaults.newThreadSuggestionsEnabled,
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
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.remoteAccess ? (
              <section
                id={SETTINGS_SECTION_IDS.remoteAccess}
                className="mx-auto w-full max-w-3xl space-y-9 px-0 py-2"
              >
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="h-px w-3 bg-border" />
                    <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                      Manage local backend
                    </h2>
                  </div>

                  <div className={cn(SETTINGS_GROUP_CLASS, "overflow-hidden p-0")}>
                    <div className="flex min-h-17 items-center justify-between gap-4 px-5 py-4">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">Network access</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {remoteNetworkEnabled
                            ? `Available from ${remoteDisplayHost}.`
                            : "Limited to this machine."}
                        </p>
                      </div>
                      <Switch
                        checked={remoteNetworkEnabled}
                        aria-label="Network access"
                        className="data-unchecked:bg-muted"
                        disabled={setNetworkAccessMutation.isPending}
                        onCheckedChange={(checked) => setNetworkAccessMutation.mutate(checked)}
                      />
                    </div>

                    <div className="border-t border-border" />

                    <div className="flex min-h-17 items-center justify-between gap-4 px-5 py-4">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">Tailscale HTTPS</h3>
                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                          {resolvedTailscaleHttpsUrl}
                        </p>
                      </div>
                      <Switch
                        checked={tailscaleHttpsEnabled}
                        aria-label="Tailscale HTTPS"
                        className="data-checked:bg-blue-600"
                        disabled={setTailscaleHttpsMutation.isPending}
                        onCheckedChange={(checked) => setTailscaleHttpsMutation.mutate(checked)}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-px w-3 bg-border" />
                      <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                        Authorized clients
                      </h2>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={revokeOtherClientsMutation.isPending}
                        onClick={() => revokeOtherClientsMutation.mutate()}
                      >
                        Revoke others
                      </Button>
                      <Button size="xs" onClick={() => setPairingLinkDialogOpen(true)}>
                        <PlusIcon className="size-3.5" />
                        Create link
                      </Button>
                    </div>
                  </div>

                  <div className={cn(SETTINGS_GROUP_CLASS, "overflow-hidden p-0")}>
                    {remoteAccessQuery.isLoading ? (
                      <div className="px-5 py-4">
                        <p className="text-xs text-muted-foreground">Loading clients...</p>
                      </div>
                    ) : remotePairingLinks.length === 0 && remoteClients.length === 0 ? (
                      <div className="px-5 py-4">
                        <p className="text-xs text-muted-foreground">
                          No authorized clients or pending pairing links yet.
                        </p>
                      </div>
                    ) : (
                      <>
                        {remotePairingLinks.map((pairingLink, index) => {
                          const pairingUrl = resolvePairingUrl(
                            resolvedTailscaleHttpsUrl,
                            pairingLink.credential,
                          );
                          const expiresInLabel = formatPairingLinkExpiresIn(
                            pairingLink.expiresAt,
                            pairingNowMs,
                          );
                          return (
                            <div
                              key={pairingLink.id}
                              className={cn(
                                "px-5 py-4",
                                index > 0 && "border-t border-border",
                              )}
                            >
                              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="size-2 rounded-full bg-blue-500" />
                                    <h3 className="truncate text-sm font-semibold text-foreground">
                                      {pairingLink.label || "Pairing link"}
                                    </h3>
                                    <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                      Pending
                                    </span>
                                    {expiresInLabel ? (
                                      <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        {expiresInLabel}
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Scan the QR code or enter the pairing URL/code on another
                                    client.
                                  </p>

                                  <div className="mt-3 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
                                    <div className="flex size-34 items-center justify-center rounded-lg border border-border bg-white p-2">
                                      <QRCodeSvg
                                        value={pairingUrl}
                                        size={112}
                                        level="M"
                                        marginSize={2}
                                        title="Pairing link QR code"
                                      />
                                    </div>
                                    <div className="min-w-0 space-y-3">
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-[11px] font-medium text-muted-foreground uppercase">
                                            Pairing URL
                                          </span>
                                          <Button
                                            size="xs"
                                            variant="outline"
                                            onClick={() =>
                                              void copyRemoteAccessValue(
                                                pairingUrl,
                                                "Pairing URL copied",
                                              )
                                            }
                                          >
                                            <CopyIcon className="size-3" />
                                            Copy
                                          </Button>
                                        </div>
                                        <p className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs break-all text-foreground">
                                          <BlurredSecret value={pairingUrl} />
                                        </p>
                                      </div>
                                      <div className="space-y-1">
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="text-[11px] font-medium text-muted-foreground uppercase">
                                            Pairing code
                                          </span>
                                          <Button
                                            size="xs"
                                            variant="outline"
                                            onClick={() =>
                                              void copyRemoteAccessValue(
                                                pairingLink.credential,
                                                "Pairing code copied",
                                              )
                                            }
                                          >
                                            <QrCodeIcon className="size-3" />
                                            Copy
                                          </Button>
                                        </div>
                                        <p className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs tracking-wide text-foreground">
                                          <BlurredSecret value={pairingLink.credential} />
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <Button
                                  size="xs"
                                  variant="destructive-outline"
                                  disabled={revokePairingLinkMutation.isPending}
                                  onClick={() => revokePairingLinkMutation.mutate(pairingLink.id)}
                                >
                                  Revoke
                                </Button>
                              </div>
                            </div>
                          );
                        })}

                        {remoteClients.map((client, index) => (
                          <div
                            key={client.id}
                            className={cn(
                              "flex items-center justify-between gap-4 px-5 py-4",
                              (remotePairingLinks.length > 0 || index > 0) &&
                                "border-t border-border",
                            )}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "rounded-full",
                                    client.connected
                                      ? "size-3 bg-emerald-500 p-1"
                                      : "size-2 bg-muted-foreground/40",
                                  )}
                                >
                                  {client.connected ? (
                                    <span className="block size-1 rounded-full bg-background" />
                                  ) : null}
                                </span>
                                <h3 className="truncate text-sm font-semibold text-foreground">
                                  {client.label}
                                </h3>
                                {client.isCurrent ? (
                                  <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    This device
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {client.deviceType} - {client.os} - {client.client} - {client.host} -{" "}
                                {client.scopes.length} scopes
                              </p>
                            </div>
                            {!client.isCurrent ? (
                              <Button
                                size="xs"
                                variant="destructive-outline"
                                disabled={revokeClientMutation.isPending}
                                onClick={() => revokeClientMutation.mutate(client.id)}
                              >
                                Revoke
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-px w-3 bg-border" />
                      <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                        Remote environments
                      </h2>
                    </div>

                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled
                    >
                      <PlusIcon className="size-3.5" />
                      Add environment
                    </Button>
                  </div>

                  <div className={SETTINGS_GROUP_CLASS}>
                    <p className="text-xs text-muted-foreground">
                      {remoteEnvironments.length === 0
                        ? 'No remote environments yet. Click "Add environment" to pair another environment.'
                        : `${remoteEnvironments.length} remote environments connected.`}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.responses ? (
              <section id={SETTINGS_SECTION_IDS.responses} className={SETTINGS_SECTION_CLASS}>
                <div className={SETTINGS_ROW_CLASS}>
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

                <div className={SETTINGS_ROW_CLASS}>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Keep inspect mode after capture
                    </p>
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

                <div className={SETTINGS_ROW_CLASS}>
                  <div>
                    <p className="text-sm font-medium text-foreground">Wrap lines in turn diffs</p>
                    <p className="text-xs text-muted-foreground">
                      Wrap long lines in the turn diff panel instead of requiring horizontal
                      scrolling.
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
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.browserUse ? (
              <section id={SETTINGS_SECTION_IDS.browserUse} className={SETTINGS_SECTION_CLASS}>
                {usesDesktopAppChrome ? (
                  <div className="space-y-5">
                    <div className={SETTINGS_SUBGROUP_CLASS}>
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
                                {clearingBrowsingData === option.value
                                  ? "Clearing..."
                                  : option.label}
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
                        <div className="px-4 pb-3 text-xs text-muted-foreground">
                          {browsingDataStatus}
                        </div>
                      ) : null}
                    </div>

                    <div className={SETTINGS_SUBGROUP_CLASS}>
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
                      <div className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_220px] sm:items-center">
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

                        <div className={SETTINGS_SUBGROUP_CLASS}>
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
                  <div className={SETTINGS_EMPTY_STATE_CLASS}>
                    Browser use settings are available in the desktop app.
                  </div>
                )}
              </section>
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.computerUse ? (
              <section id={SETTINGS_SECTION_IDS.computerUse} className={SETTINGS_SECTION_CLASS}>
                <div className="space-y-3">
                  <div className={SETTINGS_ROW_CLASS}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">Enable T3 Computer Use</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Allows provider sessions to use T3-owned desktop automation tools when
                        explicitly selected through @app mentions or tool prompts.
                      </p>
                    </div>
                    <div className="flex w-12 shrink-0 justify-end">
                      <Switch
                        className={COMPUTER_USE_PERMISSION_SWITCH_CLASS}
                        checked={computerUseSettings.enabled}
                        onCheckedChange={(checked) =>
                          void updateComputerUseSettings({ enabled: checked })
                        }
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-background/35 px-3 py-3">
                      <p className="text-xs font-medium text-foreground">Approval behavior</p>
                      <Select
                        value={computerUseSettings.approvalPolicy}
                        onValueChange={(value) =>
                          void updateComputerUseSettings({
                            approvalPolicy: value === "allow" ? "allow" : "ask",
                          })
                        }
                      >
                        <SelectTrigger className="mt-2 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="ask">Ask before app automation</SelectItem>
                          <SelectItem value="allow">Allow approved apps</SelectItem>
                        </SelectPopup>
                      </Select>
                      <p className="mt-2 text-xs text-muted-foreground">
                        The first implementation uses Windows UI Automation and stores captures in
                        the T3 state directory.
                      </p>
                    </div>

                    <div className="rounded-lg bg-background/35 px-3 py-3">
                      <p className="text-xs font-medium text-foreground">Capture retention</p>
                      <Input
                        className="mt-2 h-8 text-xs"
                        type="number"
                        min={1}
                        max={90}
                        value={computerUseSettings.captureRetentionDays}
                        onChange={(event) =>
                          void updateComputerUseSettings({
                            captureRetentionDays: Number(event.currentTarget.value),
                          })
                        }
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Screenshots are saved under T3 state attachments per thread, not in source
                        repos.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-background/35 px-3 py-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">Windows status</p>
                    <p className="mt-1">
                      On Windows, the bundled helper uses UI Automation and does not require macOS
                      Screen Recording or Accessibility permissions. macOS support can use the same
                      provider-neutral contracts later.
                    </p>
                    {computerUseAppsQuery.isLoading ? (
                      <p className="mt-2">Checking helper availability...</p>
                    ) : computerUseUnavailable ? (
                      <p className="mt-2 text-warning">
                        Helper unavailable: {computerUseAvailability.detail}
                      </p>
                    ) : (
                      <p className="mt-2">
                        Helper available. Found {computerUseAppsQuery.data?.apps.length ?? 0} apps.
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg bg-background/35 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium text-foreground">App permissions</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Control which discovered apps can appear in @app mentions and be targeted
                          by T3 Computer Use.
                        </p>
                      </div>
                      <ShieldIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                    </div>

                    <div className="mt-3 space-y-2">
                      {DEFAULT_COMPUTER_USE_APP_CATEGORIES.map((category) => {
                        const categoryApps = computerUseAppsByCategory[category];
                        const categoryInfo = COMPUTER_USE_APP_CATEGORY_LABELS[category];
                        const expanded = expandedComputerUseAppGroups[category];
                        const visibleCount = computerUseAppVisibleCounts[category];
                        const visibleApps = categoryApps.slice(0, visibleCount);
                        const categoryEnabled =
                          computerUseSettings.enabledAppCategories.includes(category);
                        const enabledCount = categoryApps.filter((app) =>
                          isComputerUseAppAllowed(app, computerUseSettings),
                        ).length;
                        return (
                          <div
                            key={category}
                            className="overflow-hidden rounded-lg bg-card/45"
                          >
                            <div className="flex items-center gap-2 px-2.5 py-2">
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                onClick={() =>
                                  setExpandedComputerUseAppGroups((current) => ({
                                    ...current,
                                    [category]: !current[category],
                                  }))
                                }
                              >
                                {expanded ? (
                                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <span className="min-w-0">
                                  <span className="block text-xs font-medium text-foreground">
                                    {categoryInfo.label}
                                  </span>
                                  <span className="block truncate text-[11px] text-muted-foreground">
                                    {categoryApps.length} discovered, {enabledCount} enabled
                                  </span>
                                </span>
                              </button>
                              <div className="flex w-12 shrink-0 justify-end">
                                <Switch
                                  className={COMPUTER_USE_PERMISSION_SWITCH_CLASS}
                                  checked={categoryEnabled}
                                  onCheckedChange={(checked) =>
                                    toggleComputerUseAppCategory(category, checked)
                                  }
                                />
                              </div>
                            </div>

                            {expanded ? (
                              <div className="px-2.5 pb-2">
                                <p className="mb-2 text-[11px] text-muted-foreground">
                                  {categoryInfo.description}
                                </p>
                                {categoryApps.length === 0 ? (
                                  <p className="rounded-md bg-background/35 px-2 py-2 text-xs text-muted-foreground">
                                    No apps in this group.
                                  </p>
                                ) : (
                                  <div className="space-y-1">
                                    {visibleApps.map((app) => {
                                      const appAllowed = isComputerUseAppAllowed(
                                        app,
                                        computerUseSettings,
                                      );
                                      return (
                                        <div
                                          key={app.appId}
                                          className="grid min-h-10 grid-cols-[1rem_minmax(0,1fr)_3rem] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/35"
                                        >
                                          <ComputerUseAppIcon app={app} />
                                          <div className="min-w-0 flex-1">
                                            <p className="truncate text-xs font-medium text-foreground">
                                              {app.name}
                                            </p>
                                            <p className="truncate text-[11px] text-muted-foreground">
                                              {computerUseAppDescription(app)}
                                            </p>
                                          </div>
                                          <div className="flex w-12 justify-end">
                                            <Switch
                                              className={COMPUTER_USE_PERMISSION_SWITCH_CLASS}
                                              checked={appAllowed}
                                              onCheckedChange={(checked) =>
                                                toggleComputerUseAppPermission(app, checked)
                                              }
                                            />
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {visibleCount < categoryApps.length ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        className="mt-1 h-7 text-xs"
                                        onClick={() =>
                                          setComputerUseAppVisibleCounts((current) => ({
                                            ...current,
                                            [category]:
                                              current[category] + COMPUTER_USE_APP_PAGE_SIZE,
                                          }))
                                        }
                                      >
                                        Show {Math.min(
                                          COMPUTER_USE_APP_PAGE_SIZE,
                                          categoryApps.length - visibleCount,
                                        )} more
                                      </Button>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.keybindings ? (
              <section id={SETTINGS_SECTION_IDS.keybindings} className={SETTINGS_SECTION_CLASS}>
                <div className="space-y-3">
                  <div className={SETTINGS_ROW_CLASS}>
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
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.safety ? (
              <section id={SETTINGS_SECTION_IDS.safety} className={SETTINGS_SECTION_CLASS}>
                <div className={SETTINGS_ROW_CLASS}>
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

                <div className={SETTINGS_ROW_CLASS}>
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
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.providers ? (
              <section id={SETTINGS_SECTION_IDS.providers} className={SETTINGS_SECTION_CLASS}>
                <div className="space-y-4">
                  {/* ── Codex ── */}
                  <div className={SETTINGS_SUBGROUP_CLASS}>
                    <button
                      type="button"
                      onClick={() => toggleProviderExpanded("codex")}
                      className="flex w-full items-center justify-between text-left"
                      aria-expanded={expandedProviders.has("codex")}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderLogo provider="codex" className="text-muted-foreground" />
                        <h3 className="text-sm font-medium text-foreground">
                          {PROVIDER_DISPLAY_NAMES.codex}
                        </h3>
                        {codexStatus?.status === "ready" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] text-green-600">
                            <CircleCheckIcon className="size-2.5" />
                            Ready
                          </span>
                        ) : codexStatus?.status === "warning" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600">
                            <CircleAlertIcon className="size-2.5" />
                            Warning
                          </span>
                        ) : codexStatus?.status === "error" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
                            <CircleXIcon className="size-2.5" />
                            Error
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            <CircleEllipsisIcon className="size-2.5" />
                            Checking...
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {codexStatus?.version ? (
                          <span className="text-[11px] text-muted-foreground">
                            v{codexStatus.version}
                          </span>
                        ) : null}
                        <ProviderUpdateButton
                          provider="codex"
                          currentVersion={codexStatus?.version ?? null}
                          updateInfo={codexStatus?.updateInfo}
                        />
                        <ChevronDownIcon
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            !expandedProviders.has("codex") && "-rotate-90",
                          )}
                          aria-hidden
                        />
                      </div>
                    </button>

                    {expandedProviders.has("codex") ? (
                      <>
                        {codexStatus?.message ? (
                          <p className="mb-3 text-xs text-muted-foreground">
                            {codexStatus.message}
                          </p>
                        ) : null}
                        <div className="space-y-3 pt-3">
                          <div className={SETTINGS_ROW_CLASS}>
                            <div>
                              <span className="text-xs font-medium text-foreground">
                                Account
                              </span>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {codexAccount?.state === "authenticated"
                                  ? codexAccount.account && "email" in codexAccount.account
                                    ? <BlurredEmail value={codexAccount.account.email} />
                                    : "Signed in"
                                  : "Not signed in"}
                              </p>
                            </div>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={isLoggingOut || isCancelingLogin}
                              onClick={handleCodexAuthAction}
                            >
                              {codexAccount?.state === "authenticated"
                                ? isLoggingOut
                                  ? "Signing out..."
                                  : "Sign out"
                                : isLoggingIn
                                  ? loginId
                                    ? "Cancel sign in"
                                    : "Signing in..."
                                  : "Sign in"}
                            </Button>
                          </div>

                          <label
                            htmlFor="connections-codex-binary-path"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Binary path
                            </span>
                            <Input
                              id="connections-codex-binary-path"
                              value={codexBinaryPath}
                              onChange={(event) =>
                                updateSettings({ codexBinaryPath: event.target.value })
                              }
                              placeholder="codex"
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Leave blank to use <code>codex</code> from your PATH.
                            </span>
                          </label>

                          <label
                            htmlFor="connections-codex-home-path"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Home path
                            </span>
                            <Input
                              id="connections-codex-home-path"
                              value={codexHomePath}
                              onChange={(event) =>
                                updateSettings({ codexHomePath: event.target.value })
                              }
                              placeholder="/Users/you/.codex"
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Optional custom Codex home/config directory.
                            </span>
                          </label>

                          <label
                            htmlFor="connections-codex-service-tier"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Service tier
                            </span>
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
                                        <span
                                          className="size-3.5 shrink-0"
                                          aria-hidden="true"
                                        />
                                      )}
                                      <span className="truncate">{option.label}</span>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                            <span className="text-xs text-muted-foreground">
                              {APP_SERVICE_TIER_OPTIONS.find(
                                (option) => option.value === codexServiceTier,
                              )?.description ??
                                "Use Codex defaults without forcing a service tier."}
                            </span>
                          </label>

                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>
                              Binary source:{" "}
                              <span className="font-medium text-foreground">
                                {codexBinaryPath || "PATH"}
                              </span>
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
                      </>
                    ) : (
                      <p className="pt-3 text-xs text-muted-foreground">
                        {codexAccount?.state === "authenticated"
                          ? codexAccount.account && "email" in codexAccount.account
                            ? <>
                                Signed in as{" "}
                                <BlurredEmail value={codexAccount.account.email} />
                              </>
                            : "Signed in"
                          : "Not signed in"}
                      </p>
                    )}
                  </div>

                  {/* ── OpenCode ── */}
                  <div className={SETTINGS_SUBGROUP_CLASS}>
                    <button
                      type="button"
                      onClick={() => toggleProviderExpanded("opencode")}
                      className="flex w-full items-center justify-between text-left"
                      aria-expanded={expandedProviders.has("opencode")}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderLogo provider="opencode" className="text-muted-foreground" />
                        <h3 className="text-sm font-medium text-foreground">
                          {PROVIDER_DISPLAY_NAMES.opencode}
                        </h3>
                        {opencodeStatus?.status === "ready" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] text-green-600">
                            <CircleCheckIcon className="size-2.5" />
                            Ready
                          </span>
                        ) : opencodeStatus?.status === "warning" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600">
                            <CircleAlertIcon className="size-2.5" />
                            Warning
                          </span>
                        ) : opencodeStatus?.status === "error" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
                            <CircleXIcon className="size-2.5" />
                            Error
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            <CircleEllipsisIcon className="size-2.5" />
                            Checking...
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {opencodeStatus?.version ? (
                          <span className="text-[11px] text-muted-foreground">
                            v{opencodeStatus.version}
                          </span>
                        ) : null}
                        <ProviderUpdateButton
                          provider="opencode"
                          currentVersion={opencodeStatus?.version ?? null}
                          updateInfo={opencodeStatus?.updateInfo}
                        />
                        <ChevronDownIcon
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            !expandedProviders.has("opencode") && "-rotate-90",
                          )}
                          aria-hidden
                        />
                      </div>
                    </button>

                    {expandedProviders.has("opencode") ? (
                      <>
                        {opencodeStatus?.message ? (
                          <p className="mb-3 text-xs text-muted-foreground">
                            {opencodeStatus.message}
                          </p>
                        ) : null}
                        <div className="space-y-3 pt-3">
                          <div className={SETTINGS_ROW_CLASS}>
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                Enable OpenCode
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Show OpenCode as a provider option in new sessions.
                              </p>
                            </div>
                            <Switch
                              checked={opencodeServerSettings?.enabled ?? true}
                              onCheckedChange={(checked) =>
                                void updateOpenCodeServerSettings({
                                  enabled: Boolean(checked),
                                })
                              }
                              aria-label="Enable OpenCode"
                            />
                          </div>

                          <label
                            htmlFor="connections-opencode-binary-path"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Binary path
                            </span>
                            <Input
                              id="connections-opencode-binary-path"
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

                          <label
                            htmlFor="connections-opencode-server-url"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Server URL
                            </span>
                            <Input
                              id="connections-opencode-server-url"
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
                              Leave blank to spawn the OpenCode server locally.
                            </span>
                          </label>

                          <label
                            htmlFor="connections-opencode-server-password"
                            className="block space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Server password
                            </span>
                            <Input
                              id="connections-opencode-server-password"
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
                              Used when the configured OpenCode server requires
                              authentication.
                            </span>
                          </label>
                        </div>
                      </>
                    ) : (
                      <p className="pt-3 text-xs text-muted-foreground">
                        {(opencodeServerSettings?.enabled ?? true) ? "Enabled" : "Disabled"}
                      </p>
                    )}
                  </div>

                  {/* ── Claude ── */}
                  <div className={SETTINGS_SUBGROUP_CLASS}>
                    <button
                      type="button"
                      onClick={() => toggleProviderExpanded("claudeAgent")}
                      className="flex w-full items-center justify-between text-left"
                      aria-expanded={expandedProviders.has("claudeAgent")}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderLogo provider="claudeAgent" className="text-muted-foreground" />
                        <h3 className="text-sm font-medium text-foreground">
                          {PROVIDER_DISPLAY_NAMES.claudeAgent}
                        </h3>
                        {claudeStatus?.status === "ready" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] text-green-600">
                            <CircleCheckIcon className="size-2.5" />
                            Ready
                          </span>
                        ) : claudeStatus?.status === "warning" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600">
                            <CircleAlertIcon className="size-2.5" />
                            Warning
                          </span>
                        ) : claudeStatus?.status === "error" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
                            <CircleXIcon className="size-2.5" />
                            Error
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            <CircleEllipsisIcon className="size-2.5" />
                            Checking...
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {claudeStatus?.version ? (
                          <span className="text-[11px] text-muted-foreground">
                            v{claudeStatus.version}
                          </span>
                        ) : null}
                        <ProviderUpdateButton
                          provider="claudeAgent"
                          currentVersion={claudeStatus?.version ?? null}
                          updateInfo={claudeStatus?.updateInfo}
                        />
                        <ChevronDownIcon
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            !expandedProviders.has("claudeAgent") && "-rotate-90",
                          )}
                          aria-hidden
                        />
                      </div>
                    </button>

                    {expandedProviders.has("claudeAgent") ? (
                      <>
                        {claudeStatus?.message ? (
                          <p className="mb-3 text-xs text-muted-foreground">
                            {claudeStatus.message}
                          </p>
                        ) : null}
                        <div className="space-y-3 pt-3">
                          <div className={SETTINGS_ROW_CLASS}>
                            <div>
                              <span className="text-xs font-medium text-foreground">
                                Authentication
                              </span>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {claudeAuthenticationLabel}
                              </p>
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                              {claudeAuthenticationModeLabel}
                            </span>
                          </div>

                          {claudeAccount?.rateLimits &&
                          claudeAccount.rateLimits.length > 0 ? (
                            <div className="rounded-lg bg-background/35 px-3 py-2">
                              <span className="text-xs font-medium text-foreground">
                                Rate limits
                              </span>
                              <div className="mt-2 space-y-2">
                                {claudeAccount.rateLimits.map((bucket, index) => (
                                  <div
                                    key={bucket.limitId ?? index}
                                    className="space-y-1 text-[11px]"
                                  >
                                    {bucket.limitName ? (
                                      <span className="font-medium text-foreground">
                                        {bucket.limitName}
                                      </span>
                                    ) : null}
                                    {bucket.primary ? (
                                      <div className="flex items-center justify-between text-muted-foreground">
                                        <span>Used</span>
                                        <span>
                                          {bucket.primary.usedPercent}%
                                        </span>
                                      </div>
                                    ) : null}
                                    {bucket.credits?.balance ? (
                                      <div className="flex items-center justify-between text-muted-foreground">
                                        <span>Credits</span>
                                        <span>{bucket.credits.balance}</span>
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <p className="pt-3 text-xs text-muted-foreground">
                        {claudeCollapsedAuthenticationLabel}
                      </p>
                    )}
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === SETTINGS_SECTION_IDS.archived ? (
              <section id={SETTINGS_SECTION_IDS.archived} className={SETTINGS_SECTION_CLASS}>
                {archivedGroups.length === 0 ? (
                  <div className={cn(SETTINGS_EMPTY_STATE_CLASS, "flex items-center gap-3")}>
                    <ArchiveIcon className="size-5" />
                    <span>No archived threads yet.</span>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {archivedGroups.map(({ project, threads: projectThreads }) => (
                      <div
                        key={project.id}
                        className="overflow-hidden rounded-xl bg-background/35"
                      >
                        <div className="px-4 py-3 text-sm font-medium text-foreground">
                          {project.name}
                        </div>
                        <div className="divide-y divide-border/55">
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
                                <div className="truncate text-sm text-foreground">
                                  {thread.title}
                                </div>
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
            ) : null}
          </div>
        </div>
      </div>
      <Dialog open={pairingLinkDialogOpen} onOpenChange={handlePairingDialogOpenChange}>
        <DialogPopup className="max-w-md">
          <DialogHeader className="pb-3">
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link that another device can use to pair with this backend as an
              authorized client.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-4 px-6 pb-1 pt-0">
            <Input
              value={pairingClientName}
              onChange={(event) => setPairingClientName(event.target.value)}
              placeholder="e.g. Living room iPad"
              aria-label="Client name"
              autoFocus
            />

            <div className="space-y-2">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-foreground">Permissions</h3>
                  <p className="text-xs text-muted-foreground">
                    Limit what the paired client can do.
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant={readOnlyPairingPresetSelected ? "default" : "outline"}
                    onClick={() => applyPairingPermissionPreset("readOnly")}
                  >
                    Read only
                  </Button>
                  <Button
                    size="xs"
                    variant={standardPairingPresetSelected ? "default" : "outline"}
                    onClick={() => applyPairingPermissionPreset("standard")}
                  >
                    Standard
                  </Button>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-border">
                {PAIRING_PERMISSION_OPTIONS.map((permission, index) => {
                  const checked = pairingPermissionIds.has(permission.id);
                  return (
                    <label
                      key={permission.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-3 py-3",
                        index > 0 && "border-t border-border",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => togglePairingPermission(permission.id)}
                        aria-label={permission.label}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-foreground">
                          {permission.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {permission.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </DialogPanel>

          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setPairingLinkDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createPairingLinkMutation.isPending || pairingPermissionIds.size === 0}
              onClick={handleCreatePairingLink}
            >
              Create link
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </AppPageShell>
  );
}

export default SettingsRouteView;
