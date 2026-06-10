import type { ProviderKind, ServerProviderUpdateInfo } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderUpdateShape {
  readonly getUpdates: Effect.Effect<ReadonlyMap<ProviderKind, ServerProviderUpdateInfo>>;
  readonly refresh: (provider: ProviderKind) => Effect.Effect<ServerProviderUpdateInfo>;
}

export class ProviderUpdate extends ServiceMap.Service<ProviderUpdate, ProviderUpdateShape>()(
  "t3/provider/Services/ProviderUpdate",
) {}
