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
});
