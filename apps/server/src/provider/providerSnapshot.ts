import type {
  ModelCapabilities,
  ProviderKind,
  ServerProviderStatus,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

export function providerModelsFromSettings(input: {
  readonly builtInModels: ReadonlyArray<NonNullable<ServerProviderStatus["models"]>[number]>;
  readonly provider: ProviderKind;
  readonly customModels: ReadonlyArray<string>;
  readonly customModelCapabilities: ModelCapabilities;
}): ReadonlyArray<NonNullable<ServerProviderStatus["models"]>[number]> {
  const seen = new Set(input.builtInModels.map((model) => model.slug));
  const customModels: Array<NonNullable<ServerProviderStatus["models"]>[number]> = [];
  for (const candidate of input.customModels) {
    const normalized = normalizeModelSlug(candidate, input.provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customModels.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: input.customModelCapabilities,
    });
  }
  return [...input.builtInModels, ...customModels];
}
