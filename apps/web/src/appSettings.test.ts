import { describe, expect, it } from "vitest";

import {
  getAppModelOptions,
  getSuggestionModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  normalizeSuggestionModelSlug,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
  resolveAppModelSelection,
} from "./appSettings";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });

  it("keeps valid opencode provider/model custom slugs", () => {
    expect(normalizeCustomModelSlugs(["openai/gpt-4.1", "default"], "opencode")).toEqual([
      "openai/gpt-4.1",
    ]);
  });

  it("drops malformed opencode model strings", () => {
    expect(normalizeCustomModelSlugs(["gpt-4.1", "openai/"], "opencode")).toEqual([]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });
});

describe("normalizeSuggestionModelSlug", () => {
  it("preserves claude selections", () => {
    expect(normalizeSuggestionModelSlug("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("preserves codex and gpt selections", () => {
    expect(normalizeSuggestionModelSlug("gpt-5.4")).toBe("gpt-5.4");
  });

  it("preserves opencode provider/model selections", () => {
    expect(normalizeSuggestionModelSlug("openai/gpt-4.1")).toBe("openai/gpt-4.1");
  });
});

describe("getSuggestionModelOptions", () => {
  it("includes built-in models from codex, claude, and opencode", () => {
    const options = getSuggestionModelOptions({
      customCodexModels: [],
      customOpencodeModels: [],
      customClaudeModels: [],
      selectedModel: null,
    });

    expect(options.some((option) => option.provider === "codex" && option.slug === "gpt-5.4")).toBe(
      true,
    );
    expect(
      options.some(
        (option) => option.provider === "claudeAgent" && option.slug === "claude-sonnet-4-6",
      ),
    ).toBe(true);
    expect(
      options.some(
        (option) => option.provider === "opencode" && option.slug === "opencode/default",
      ),
    ).toBe(true);
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.5");
  });

  it("preserves valid opencode provider/model selections", () => {
    expect(resolveAppModelSelection("opencode", [], "openai/gpt-4.1")).toBe("openai/gpt-4.1");
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions(
      "codex",
      ["custom/internal-model"],
      "",
      "gpt-5.3-codex",
    );

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions(
      "codex",
      ["openai/gpt-oss-120b"],
      "oss",
      "gpt-5.3-codex",
    );

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("resolveAppServiceTier", () => {
  it("maps automatic to no override", () => {
    expect(resolveAppServiceTier("auto")).toBeNull();
  });

  it("preserves explicit service tier overrides", () => {
    expect(resolveAppServiceTier("fast")).toBe("fast");
    expect(resolveAppServiceTier("flex")).toBe("flex");
  });
});

describe("shouldShowFastTierIcon", () => {
  it("shows the fast-tier icon only for supported fast-tier models on fast tier", () => {
    expect(shouldShowFastTierIcon("gpt-5.4", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.5", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.4-mini", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.4", "auto")).toBe(false);
    expect(shouldShowFastTierIcon("gpt-5.3-codex", "fast")).toBe(false);
  });
});
