import type { ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProviderStatus>;
  readonly refresh: Effect.Effect<ServerProviderStatus>;
  readonly streamChanges: Stream.Stream<ServerProviderStatus>;
}

export class ServerProvider extends ServiceMap.Service<
  ServerProvider,
  ServerProviderShape
>()("t3/provider/Services/ServerProvider") {}
