import assert from "node:assert/strict";

import type { ServerProviderStatus } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref, Stream } from "effect";

import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import { ProviderHealth } from "../Services/ProviderHealth";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { ProviderRegistryLive } from "./ProviderRegistry";

const checkedAt = "2026-01-01T00:00:00.000Z";

function providerStatus(
  input: Pick<ServerProviderStatus, "provider" | "status" | "available" | "authStatus"> &
    Partial<ServerProviderStatus>,
): ServerProviderStatus {
  return {
    checkedAt,
    ...input,
  };
}

it.effect("refreshes the OpenCode provider snapshot after registry startup", () =>
  Effect.gen(function* () {
    const refreshCount = yield* Ref.make(0);
    const refreshReturned = yield* Deferred.make<void>();
    const pendingOpenCode = providerStatus({
      provider: "opencode",
      status: "warning",
      enabled: true,
      installed: false,
      available: false,
      authStatus: "unknown",
      message: "OpenCode provider status has not been checked in this session yet.",
      models: [],
    });
    const readyOpenCode = providerStatus({
      provider: "opencode",
      status: "ready",
      enabled: true,
      installed: true,
      available: true,
      authStatus: "authenticated",
      message: "OpenCode is ready.",
      models: [],
    });

    const layer = ProviderRegistryLive.pipe(
      Layer.provide(
        Layer.succeed(ProviderHealth, {
          getStatuses: Effect.succeed([
            providerStatus({
              provider: "codex",
              status: "ready",
              available: true,
              authStatus: "authenticated",
            }),
          ]),
        }),
      ),
      Layer.provide(
        Layer.succeed(OpenCodeProvider, {
          getSnapshot: Effect.succeed(pendingOpenCode),
          refresh: Ref.update(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap(() => Deferred.succeed(refreshReturned, undefined)),
            Effect.as(readyOpenCode),
          ),
          streamChanges: Stream.empty,
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      yield* Deferred.await(refreshReturned);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

      const providers = yield* registry.getProviders;
      assert.equal(yield* Ref.get(refreshCount), 1);
      const openCode = providers.find((provider) => provider.provider === "opencode");
      assert.equal(openCode?.status, "ready");
      assert.equal(openCode?.message, "OpenCode is ready.");
    }).pipe(Effect.provide(layer));
  }),
);
