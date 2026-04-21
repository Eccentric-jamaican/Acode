import {
  DEFAULT_SERVER_SETTINGS,
  type OpenCodeSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

function normalizeOpenCodeBinaryPath(binaryPath: string): string {
  return binaryPath.trim();
}

export function normalizeServerSettings(current: ServerSettings): ServerSettings {
  const nextOpenCode = {
    ...DEFAULT_SERVER_SETTINGS.providers.opencode,
    ...current.providers.opencode,
    binaryPath: normalizeOpenCodeBinaryPath(current.providers.opencode.binaryPath),
  } satisfies OpenCodeSettings;

  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...current,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...current.providers,
      opencode: nextOpenCode,
    },
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

  return normalizeServerSettings({
    ...DEFAULT_SERVER_SETTINGS,
    ...current,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...current.providers,
      opencode: nextOpenCode,
    },
  });
}
