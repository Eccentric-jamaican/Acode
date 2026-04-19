import type { ProviderKind, ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderRegistryShape {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
  readonly refresh: (
    provider?: ProviderKind,
  ) => Effect.Effect<ReadonlyArray<ServerProviderStatus>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderRegistry extends ServiceMap.Service<
  ProviderRegistry,
  ProviderRegistryShape
>()("t3/provider/Services/ProviderRegistry") {}
