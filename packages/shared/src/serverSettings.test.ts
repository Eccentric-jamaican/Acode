import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { applyServerSettingsPatch, normalizeServerSettings } from "./serverSettings";

describe("normalizeServerSettings", () => {
  it("preserves a blank OpenCode binary path when persisted settings are blank", () => {
    const normalized = normalizeServerSettings({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "   ",
        },
      },
    });

    expect(normalized.providers.opencode.binaryPath).toBe("");
  });

  it("fills default T3 Computer Use settings", () => {
    const normalized = normalizeServerSettings({
      ...DEFAULT_SERVER_SETTINGS,
      computerUse: {
        ...DEFAULT_SERVER_SETTINGS.computerUse,
        captureRetentionDays: 999,
      },
    });

    expect(normalized.computerUse.enabled).toBe(true);
    expect(normalized.computerUse.approvalPolicy).toBe("ask");
    expect(normalized.computerUse.enabledAppCategories).toEqual(
      DEFAULT_SERVER_SETTINGS.computerUse.enabledAppCategories,
    );
    expect(normalized.computerUse.captureRetentionDays).toBe(90);
  });

  it("upgrades legacy settings without T3 Computer Use settings", () => {
    const normalized = normalizeServerSettings({
      providers: {
        opencode: {
          binaryPath: "opencode",
        },
      },
    });

    expect(normalized.computerUse).toEqual(DEFAULT_SERVER_SETTINGS.computerUse);
    expect(normalized.providers.opencode.binaryPath).toBe("opencode");
  });
});

describe("applyServerSettingsPatch", () => {
  it("preserves a blank OpenCode binary path when the patch sets it blank", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        opencode: {
          binaryPath: "",
        },
      },
    });

    expect(next.providers.opencode.binaryPath).toBe("");
  });

  it("updates T3 Computer Use settings without touching providers", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      computerUse: {
        enabled: false,
        approvalPolicy: "allow",
        enabledAppCategories: ["desktop", "agent"],
        allowedAppIds: ["win32:code:123"],
        blockedAppIds: ["win32:settings:456"],
        captureRetentionDays: 14,
      },
    });

    expect(next.computerUse).toEqual({
      enabled: false,
      approvalPolicy: "allow",
      enabledAppCategories: ["desktop"],
      allowedAppIds: ["win32:code:123"],
      blockedAppIds: ["win32:settings:456"],
      captureRetentionDays: 14,
    });
    expect(next.providers.opencode.binaryPath).toBe(
      DEFAULT_SERVER_SETTINGS.providers.opencode.binaryPath,
    );
  });
});
