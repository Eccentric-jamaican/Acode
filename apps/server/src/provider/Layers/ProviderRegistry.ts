import { MODEL_OPTIONS_BY_PROVIDER, type ServerProviderStatus } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { ProviderHealth } from "../Services/ProviderHealth";

function staticProviderModels(
  provider: "codex" | "claudeAgent",
): NonNullable<ServerProviderStatus["models"]> {
  return MODEL_OPTIONS_BY_PROVIDER[provider].map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: model.capabilities,
  }));
}

function mergeProviderList(
  existing: ReadonlyArray<ServerProviderStatus>,
  incoming: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> {
  const map = new Map(existing.map((provider) => [provider.provider, provider] as const));
  for (const provider of incoming) {
    map.set(provider.provider, provider);
  }
  return (["codex", "opencode", "claudeAgent"] as const)
    .map((provider) => map.get(provider))
    .filter((provider): provider is ServerProviderStatus => provider !== undefined);
}

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const providerHealth = yield* ProviderHealth;
    const openCodeProvider = yield* OpenCodeProvider;
    const healthStatuses = yield* providerHealth.getStatuses;
    const changes = yield* PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>();
    const initialOpenCodeProvider = yield* openCodeProvider.getSnapshot;
    const initialProviders = mergeProviderList([], [
      ...healthStatuses.map((status) => ({
        ...status,
        enabled: true,
        installed: status.available,
        version: null,
        models:
          status.provider === "codex"
            ? staticProviderModels("codex")
            : status.provider === "claudeAgent"
              ? staticProviderModels("claudeAgent")
              : [],
      })),
      initialOpenCodeProvider,
    ]);
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProviderStatus>>(initialProviders);

    const upsertProviders = (nextProviders: ReadonlyArray<ServerProviderStatus>) =>
      Ref.updateAndGet(providersRef, (current) => mergeProviderList(current, nextProviders)).pipe(
        Effect.tap((providers) => PubSub.publish(changes, providers).pipe(Effect.asVoid)),
      );

    yield* Effect.forkScoped(
      Stream.runForEach(openCodeProvider.streamChanges, (provider) => upsertProviders([provider]).pipe(Effect.asVoid)),
    );

    const refresh = (provider?: "codex" | "opencode" | "claudeAgent") =>
      Effect.gen(function* () {
        if (provider === "opencode") {
          const next = yield* openCodeProvider.refresh;
          return yield* upsertProviders([next]);
        }
        if (provider === "codex" || provider === "claudeAgent") {
          const current = yield* providerHealth.getStatuses;
          const target = current.find((entry) => entry.provider === provider);
          if (!target) {
            return yield* Ref.get(providersRef);
          }
          return yield* upsertProviders([
            {
              ...target,
              enabled: true,
              installed: target.available,
              version: null,
              models: staticProviderModels(provider),
            },
          ]);
        }
        const refreshedHealth = yield* providerHealth.getStatuses;
        const refreshedOpenCode = yield* openCodeProvider.refresh;
        return yield* upsertProviders([
          ...refreshedHealth.map((status) => ({
            ...status,
            enabled: true,
            installed: status.available,
            version: null,
            models:
              status.provider === "codex"
                ? staticProviderModels("codex")
                : status.provider === "claudeAgent"
                  ? staticProviderModels("claudeAgent")
                  : [],
          })),
          refreshedOpenCode,
        ]);
      });

    return {
      getProviders: Ref.get(providersRef),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    };
  }),
);
