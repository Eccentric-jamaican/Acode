import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  OPENCODE_DEFAULT_MODEL_SLUG,
} from "@t3tools/contracts";

import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  isValidOpencodeModelSlug,
  normalizeModelSlug,
  parseOpencodeModelSlug,
  resolveModelSlug,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.5")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.4-mini")).toBe("gpt-5.4-mini");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });

  it("normalizes opencode default alias", () => {
    expect(normalizeModelSlug("default", "opencode")).toBe(OPENCODE_DEFAULT_MODEL_SLUG);
  });

  it("accepts provider/model OpenCode slugs", () => {
    expect(normalizeModelSlug("openai/gpt-4.1", "opencode")).toBe("openai/gpt-4.1");
  });

  it("rejects malformed OpenCode slugs", () => {
    expect(normalizeModelSlug("gpt-4.1", "opencode")).toBeNull();
    expect(normalizeModelSlug("openai/", "opencode")).toBeNull();
    expect(normalizeModelSlug("/gpt-4.1", "opencode")).toBeNull();
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("accepts custom OpenCode provider/model slugs", () => {
    expect(resolveModelSlug("openai/gpt-4.1", "opencode")).toBe("openai/gpt-4.1");
  });

  it("accepts built-in OpenCode Go model slugs", () => {
    expect(resolveModelSlug("opencode-go/glm-5", "opencode")).toBe("opencode-go/glm-5");
    expect(resolveModelSlug("opencode-go/glm-5.1", "opencode")).toBe("opencode-go/glm-5.1");
    expect(resolveModelSlug("opencode-go/kimi-k2.5", "opencode")).toBe("opencode-go/kimi-k2.5");
  });

  it("falls back to OpenCode default for malformed OpenCode slugs", () => {
    expect(resolveModelSlug("gpt-4.1", "opencode")).toBe(DEFAULT_MODEL_BY_PROVIDER.opencode);
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("medium");
    expect(getDefaultReasoningEffort("opencode")).toBeNull();
  });
});

describe("parseOpencodeModelSlug", () => {
  it("parses provider/model for OpenCode custom models", () => {
    expect(parseOpencodeModelSlug("openai/gpt-4.1")).toEqual({
      providerID: "openai",
      modelID: "gpt-4.1",
    });
  });

  it("returns null for default or malformed values", () => {
    expect(parseOpencodeModelSlug(OPENCODE_DEFAULT_MODEL_SLUG)).toBeNull();
    expect(parseOpencodeModelSlug("gpt-4.1")).toBeNull();
  });
});

describe("isValidOpencodeModelSlug", () => {
  it("validates default and provider/model formats", () => {
    expect(isValidOpencodeModelSlug(OPENCODE_DEFAULT_MODEL_SLUG)).toBe(true);
    expect(isValidOpencodeModelSlug("openai/gpt-4.1")).toBe(true);
    expect(isValidOpencodeModelSlug("gpt-4.1")).toBe(false);
  });
});
