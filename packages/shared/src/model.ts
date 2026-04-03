import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  OPENCODE_DEFAULT_MODEL_SLUG,
  type CodexReasoningEffort,
  type ModelSlug,
  type ProviderKind,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  opencode: new Set(MODEL_OPTIONS_BY_PROVIDER.opencode.map((option) => option.slug)),
};

const OPENCODE_MODEL_SLUG_REGEX = /^[^/\s]+\/[^/\s]+$/;

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[trimmed];
  const candidate = typeof aliased === "string" ? aliased : trimmed;
  if (provider === "opencode" && !isValidOpencodeModelSlug(candidate)) {
    return null;
  }
  return candidate as ModelSlug;
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  if (provider === "opencode") {
    return normalized;
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return provider === "codex" ? CODEX_REASONING_EFFORT_OPTIONS : [];
}

export function isValidOpencodeModelSlug(model: string | null | undefined): model is ModelSlug {
  if (typeof model !== "string") {
    return false;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === OPENCODE_DEFAULT_MODEL_SLUG) {
    return true;
  }
  return OPENCODE_MODEL_SLUG_REGEX.test(trimmed);
}

export function parseOpencodeModelSlug(
  model: string | null | undefined,
): { providerID: string; modelID: string } | null {
  if (typeof model !== "string") {
    return null;
  }
  const trimmed = model.trim();
  if (!isValidOpencodeModelSlug(trimmed) || trimmed === OPENCODE_DEFAULT_MODEL_SLUG) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 1 || slashIndex === trimmed.length - 1) {
    return null;
  }
  return {
    providerID: trimmed.slice(0, slashIndex),
    modelID: trimmed.slice(slashIndex + 1),
  };
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return provider === "codex" ? "high" : null;
}

export { CODEX_REASONING_EFFORT_OPTIONS };
