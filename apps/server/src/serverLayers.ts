import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { TaskLifecycleReactorLive } from "./orchestration/Layers/TaskLifecycleReactor";
import { ErrorInboxRepositoryLive } from "./errorInbox/Layers/ErrorInboxRepository";
import { ErrorInboxServiceLive } from "./errorInbox/Layers/ErrorInbox";
import { ProviderUnsupportedError } from "./provider/Errors";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { makeOpencodeAdapterLive } from "./provider/Layers/OpencodeAdapter";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { ProviderDiscoveryServiceLive } from "./provider/Layers/ProviderDiscoveryService";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { CodexAdapter } from "./provider/Services/CodexAdapter";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderService } from "./provider/Services/ProviderService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration";
import { GitServiceLive } from "./git/Layers/GitService";
import { BunPtyAdapterLive } from "./terminal/Layers/BunPTY";
import { NodePtyAdapterLive } from "./terminal/Layers/NodePTY";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

export function makeServerProviderLayer(): Layer.Layer<
  ProviderService | ProviderDiscoveryService | CodexAdapter,
  ProviderUnsupportedError,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | AnalyticsService
> {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    const providerEventLogPath = path.join(providerLogsDir, "events.log");
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const opencodeAdapterLayer = makeOpencodeAdapterLive();
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(opencodeAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
    const providerDiscoveryLayer = ProviderDiscoveryServiceLive.pipe(
      Layer.provide(adapterRegistryLayer),
    );
    return Layer.mergeAll(providerServiceLayer, providerDiscoveryLayer, codexAdapterLayer);
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeCoreLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = CodexTextGenerationLive;
  const orchestrationCommandReceiptLayer = OrchestrationCommandReceiptRepositoryLive;

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(orchestrationCommandReceiptLayer),
  );

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );
  const errorInboxLayer = ErrorInboxServiceLive.pipe(
    Layer.provide(ErrorInboxRepositoryLive),
    Layer.provide(orchestrationLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    orchestrationCommandReceiptLayer,
    OrchestrationProjectionSnapshotQueryLive,
    CheckpointStoreLive,
    checkpointDiffQueryLayer,
    errorInboxLayer,
  );

  const terminalLayer = TerminalManagerLive.pipe(
    Layer.provide(
      typeof Bun !== "undefined" && process.platform !== "win32"
        ? BunPtyAdapterLive
        : NodePtyAdapterLive,
    ),
  );

  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provide(gitCoreLayer),
    Layer.provide(GitHubCliLive),
    Layer.provide(textGenerationLayer),
  );

  return Layer.mergeAll(
    runtimeServicesLayer,
    gitCoreLayer,
    textGenerationLayer,
    gitManagerLayer,
    terminalLayer,
    KeybindingsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

export function makeServerRuntimeServicesLayer(
  input?: { coreLayer?: ReturnType<typeof makeServerRuntimeCoreLayer> },
) {
  const coreLayer = input?.coreLayer ?? makeServerRuntimeCoreLayer();

  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provide(coreLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provide(coreLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provide(coreLayer),
  );
  const taskLifecycleReactorLayer = TaskLifecycleReactorLive.pipe(
    Layer.provide(coreLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provide(runtimeIngestionLayer),
    Layer.provide(providerCommandReactorLayer),
    Layer.provide(checkpointReactorLayer),
    Layer.provide(taskLifecycleReactorLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    coreLayer,
    orchestrationReactorLayer,
  );

  // ServerRuntimeStartup must be at the top to manage command queuing during startup
  return ServerRuntimeStartupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
}
