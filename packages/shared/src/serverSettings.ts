import {
  DEFAULT_COMPUTER_USE_APP_CATEGORIES,
  DEFAULT_SERVER_SETTINGS,
  type ComputerUseSettings,
  type OpenCodeSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { normalizeComputerUseCategoryList } from "./computerUsePermissions";

type PartialServerSettingsInput = Partial<Omit<ServerSettings, "computerUse" | "providers">> & {
  readonly computerUse?: Partial<ComputerUseSettings>;
  readonly providers?: Partial<Omit<ServerSettings["providers"], "opencode">> & {
    readonly opencode?: Partial<OpenCodeSettings>;
  };
};

function normalizeOpenCodeBinaryPath(binaryPath: string): string {
  return binaryPath.trim();
}

function normalizeRetentionDays(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SERVER_SETTINGS.computerUse.captureRetentionDays;
  }
  return Math.max(1, Math.min(90, Math.round(value)));
}

export function normalizeServerSettings(current: PartialServerSettingsInput): ServerSettings {
  const currentProviders = current.providers ?? {};
  const currentOpenCode = currentProviders.opencode ?? {};
  const nextOpenCode = {
    ...DEFAULT_SERVER_SETTINGS.providers.opencode,
    ...currentOpenCode,
    binaryPath: normalizeOpenCodeBinaryPath(
      currentOpenCode.binaryPath ?? DEFAULT_SERVER_SETTINGS.providers.opencode.binaryPath,
    ),
  } satisfies OpenCodeSettings;
  const currentComputerUse = current.computerUse ?? {};
  const mergedComputerUse = {
    ...DEFAULT_SERVER_SETTINGS.computerUse,
    ...currentComputerUse,
  };
  const nextComputerUse = {
    ...mergedComputerUse,
    enabledAppCategories: normalizeComputerUseCategoryList(
      mergedComputerUse.enabledAppCategories ?? DEFAULT_COMPUTER_USE_APP_CATEGORIES,
    ),
    allowedAppIds: Array.from(new Set(mergedComputerUse.allowedAppIds ?? [])),
    blockedAppIds: Array.from(new Set(mergedComputerUse.blockedAppIds ?? [])),
    captureRetentionDays: normalizeRetentionDays(mergedComputerUse.captureRetentionDays),
  } satisfies ComputerUseSettings;

  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...current,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...currentProviders,
      opencode: nextOpenCode,
    },
    computerUse: nextComputerUse,
  };
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const nextOpenCode = {
    enabled: patch.providers?.opencode?.enabled ?? current.providers.opencode.enabled,
    binaryPath: patch.providers?.opencode?.binaryPath ?? current.providers.opencode.binaryPath,
    serverUrl: patch.providers?.opencode?.serverUrl ?? current.providers.opencode.serverUrl,
    serverPassword:
      patch.providers?.opencode?.serverPassword ?? current.providers.opencode.serverPassword,
    customModels:
      patch.providers?.opencode?.customModels ?? current.providers.opencode.customModels,
  } satisfies OpenCodeSettings;
  const nextComputerUse = {
    enabled: patch.computerUse?.enabled ?? current.computerUse.enabled,
    approvalPolicy: patch.computerUse?.approvalPolicy ?? current.computerUse.approvalPolicy,
    enabledAppCategories:
      patch.computerUse?.enabledAppCategories ?? current.computerUse.enabledAppCategories,
    allowedAppIds: patch.computerUse?.allowedAppIds ?? current.computerUse.allowedAppIds,
    blockedAppIds: patch.computerUse?.blockedAppIds ?? current.computerUse.blockedAppIds,
    captureRetentionDays:
      patch.computerUse?.captureRetentionDays ?? current.computerUse.captureRetentionDays,
  } satisfies ComputerUseSettings;

  return normalizeServerSettings({
    ...DEFAULT_SERVER_SETTINGS,
    ...current,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...current.providers,
      opencode: nextOpenCode,
    },
    computerUse: nextComputerUse,
  });
}
