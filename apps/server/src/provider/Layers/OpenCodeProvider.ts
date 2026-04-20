import { Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { DEFAULT_SERVER_SETTINGS, type ServerProviderStatus } from "@t3tools/contracts";

import { ServerConfig } from "../../config";
import { createLogger } from "../../logger";
import { ServerSettingsService } from "../../serverSettings";
import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import {
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  flattenOpenCodeModels,
  getOpenCodeStartupMetadata,
  loadOpenCodeInventory,
  resolveOpenCodeBinaryPath,
  runOpenCodeCommand,
} from "../opencodeRuntime";
import { providerModelsFromSettings } from "../providerSnapshot";

const PROVIDER = "opencode" as const;
const logger = createLogger("opencode");

const DEFAULT_OPENCODE_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  variantOptions: [],
  agentOptions: [],
} as const;

function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

function isCommandMissingError(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }
  const lower = cause.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

function pendingSnapshot(
  settings: { enabled: boolean; customModels: readonly string[] },
): ServerProviderStatus {
  return {
    provider: PROVIDER,
    status: settings.enabled ? ("warning" as const) : ("error" as const),
    enabled: settings.enabled,
    installed: false,
    available: false,
    authStatus: "unknown" as const,
    checkedAt: new Date().toISOString(),
    message: settings.enabled
      ? "OpenCode provider status has not been checked in this session yet."
      : "OpenCode is disabled in settings.",
    models: providerModelsFromSettings({
      builtInModels: [],
      provider: PROVIDER,
      customModels: settings.customModels,
      customModelCapabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    }),
  };
}

async function checkOpenCodeProviderStatus(input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly enabled: boolean;
  readonly cwd: string;
  readonly customModels: readonly string[];
}): Promise<ServerProviderStatus> {
  const checkedAt = new Date().toISOString();
  if (!input.enabled) {
    return {
      provider: PROVIDER,
      status: "error" as const,
      enabled: false,
      installed: false,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "OpenCode is disabled in settings.",
      models: providerModelsFromSettings({
        builtInModels: [],
        provider: PROVIDER,
        customModels: input.customModels,
        customModelCapabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      }),
    };
  }

  const isExternalServer = input.serverUrl.trim().length > 0;
  const startupStartedAt = Date.now();
  try {
    let version: string | null = null;
    const resolvedBinaryPath = resolveOpenCodeBinaryPath(input.binaryPath);
    if (!isExternalServer) {
      const versionResult = await runOpenCodeCommand({
        binaryPath: resolvedBinaryPath,
        args: ["--version"],
      });
      version = parseGenericCliVersion(versionResult.stdout) ?? null;
    }

    const server = await connectToOpenCodeServer({
      binaryPath: resolvedBinaryPath,
      serverUrl: input.serverUrl,
    });
    try {
      const client = createOpenCodeSdkClient({
        baseUrl: server.url,
        directory: input.cwd,
        ...(server.external && input.serverPassword.trim().length > 0
          ? { serverPassword: input.serverPassword.trim() }
          : {}),
      });
      const inventory = await loadOpenCodeInventory(client);
      const builtInModels = flattenOpenCodeModels(inventory);
      const connectedCount = inventory.providerList.connected.length;
      logger.info("OpenCode provider status check succeeded", {
        externalServer: server.external,
        binaryPath: resolvedBinaryPath,
        serverUrl: server.url,
        startupDurationMs: Date.now() - startupStartedAt,
        connectedProviders: connectedCount,
      });
      return {
        provider: PROVIDER,
        status: connectedCount > 0 ? ("ready" as const) : ("warning" as const),
        enabled: true,
        installed: true,
        available: true,
        authStatus: connectedCount > 0 ? ("authenticated" as const) : ("unknown" as const),
        checkedAt,
        ...(version ? { version } : {}),
        message:
          connectedCount > 0
            ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${server.external ? "the configured OpenCode server" : "OpenCode"}.`
            : server.external
              ? "Connected to the configured OpenCode server, but no upstream providers were reported."
              : "OpenCode is available, but no upstream providers were reported.",
        models: providerModelsFromSettings({
          builtInModels,
          provider: PROVIDER,
          customModels: input.customModels,
          customModelCapabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
        }),
      };
    } finally {
      server.close();
    }
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Failed to check OpenCode provider status.";
    const startupMetadata = getOpenCodeStartupMetadata(cause);
    logger.warn("OpenCode provider status check failed", {
      binaryPath: input.binaryPath,
      configuredServerUrl: input.serverUrl,
      startupDurationMs: startupMetadata?.startupDurationMs ?? Date.now() - startupStartedAt,
      reason: message,
      ...(startupMetadata?.hostname ? { hostname: startupMetadata.hostname } : {}),
      ...(startupMetadata?.port ? { port: startupMetadata.port } : {}),
      ...(startupMetadata?.stdout ? { stdout: startupMetadata.stdout } : {}),
      ...(startupMetadata?.stderr ? { stderr: startupMetadata.stderr } : {}),
    });
    return {
      provider: PROVIDER,
      status: "error" as const,
      enabled: true,
      installed: !isCommandMissingError(cause),
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingError(cause)
        ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
        : message,
      models: providerModelsFromSettings({
        builtInModels: [],
        provider: PROVIDER,
        customModels: input.customModels,
        customModelCapabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      }),
    };
  }
}

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const serverSettings =
      Option.getOrUndefined(yield* Effect.serviceOption(ServerSettingsService)) ?? {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
      };
    const serverConfig = yield* ServerConfig;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.map((value) => value.providers.opencode),
    );
    const changes = yield* PubSub.unbounded<ServerProviderStatus>();
    const snapshotRef = yield* Ref.make(
      pendingSnapshot({
        enabled: settings.enabled,
        customModels: settings.customModels,
      }),
    );

    const refresh: Effect.Effect<ServerProviderStatus, never, never> = Effect.gen(function* () {
      const current = yield* serverSettings.getSettings.pipe(
        Effect.map((value) => value.providers.opencode),
        Effect.catch(() =>
          Effect.succeed({
            enabled: true,
            binaryPath: "opencode",
            serverUrl: "",
            serverPassword: "",
            customModels: [] as const,
          }),
        ),
      );
      const snapshot = yield* Effect.promise(() =>
        checkOpenCodeProviderStatus({
          ...current,
          cwd: serverConfig.cwd,
        }),
      );
      yield* Ref.set(snapshotRef, snapshot);
      yield* PubSub.publish(changes, snapshot).pipe(Effect.asVoid);
      return snapshot;
    });

    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, () => refresh.pipe(Effect.ignore)),
    );

    return {
      getSnapshot: Ref.get(snapshotRef),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    };
  }),
);
