/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  type ChatAttachment as PersistedChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  type ServerErrorInboxUpdatedPayload,
  ThreadId,
  TerminalEvent,
  type UploadChatAttachment,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type ServerProviderAccountSummary,
  type ServerProviderStatus,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CodexAccountService } from "./provider/Services/CodexAccountService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { ErrorInboxService } from "./errorInbox/Services/ErrorInbox.ts";
import { OrchestrationCommandReceiptRepository } from "./persistence/Services/OrchestrationCommandReceipts.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { suggestNewThreadTasks } from "./newThreadSuggestions";
import { CodexAdapter } from "./provider/Services/CodexAdapter.ts";
import { ServerSettingsService } from "./serverSettings";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function toOptionalProviderMessage(message: string | null): string | undefined {
  if (!message) {
    return undefined;
  }
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isUploadChatAttachment(
  attachment: PersistedChatAttachment | UploadChatAttachment,
): attachment is UploadChatAttachment {
  return "dataUrl" in attachment;
}

function overlayProviderStatuses(params: {
  readonly providerStatuses: ReadonlyArray<ServerProviderStatus>;
  readonly providerAccounts: ReadonlyArray<ServerProviderAccountSummary>;
}): ReadonlyArray<ServerProviderStatus> {
  return params.providerStatuses.map((providerStatus) => {
    const accountSummary = params.providerAccounts.find(
      (providerAccount) => providerAccount.provider === providerStatus.provider,
    );
    if (!accountSummary) {
      return providerStatus;
    }

    let authStatus = providerStatus.authStatus;
    if (accountSummary.state === "authenticated") {
      authStatus = "authenticated";
    } else if (accountSummary.state === "unauthenticated") {
      authStatus = "unauthenticated";
    }

    if (accountSummary.state !== "error") {
      return {
        ...providerStatus,
        authStatus,
      };
    }

    const message = toOptionalProviderMessage(accountSummary.message);
    return {
      ...providerStatus,
      status: providerStatus.available ? "warning" : providerStatus.status,
      authStatus,
      ...(message ? { message } : {}),
    };
  });
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | OrchestrationCommandReceiptRepository
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | ProviderService
  | ProviderDiscoveryService
  | ProviderHealth
  | ErrorInboxService
  | ServerRuntimeStartup;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | CodexAdapter
  | CodexAccountService
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerRegistry =
    Option.getOrUndefined(yield* Effect.serviceOption(ProviderRegistry)) ?? {
      getProviders: providerHealth.getStatuses,
      refresh: () => providerHealth.getStatuses,
      streamChanges: Stream.empty,
    };
  const codexAccountService = yield* CodexAccountService;
  const codexAdapter = yield* CodexAdapter;
  const serverSettings =
    Option.getOrUndefined(yield* Effect.serviceOption(ServerSettingsService)) ?? {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
      streamChanges: Stream.empty,
    };
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const broadcastPush = Effect.fnUntraced(function* (push: WsPush) {
    const message = yield* encodePush(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const getProviderStateSnapshot = Effect.fnUntraced(function* () {
    const providerAccounts = [yield* codexAccountService.getSnapshot()];
    const providerStatuses = yield* providerRegistry.getProviders;
    const providers = overlayProviderStatuses({
      providerStatuses,
      providerAccounts,
    });
    return {
      providers,
      providerAccounts,
    };
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    });
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const persistClientAttachments = Effect.fnUntraced(function* (params: {
      readonly ownerId: string;
      readonly attachments:
        | ReadonlyArray<PersistedChatAttachment | UploadChatAttachment>
        | undefined;
    }) {
      if (!params.attachments) {
        return undefined;
      }

      return yield* Effect.forEach(
        params.attachments,
        (attachment) =>
          Effect.gen(function* () {
            if (!isUploadChatAttachment(attachment)) {
              return attachment;
            }

            const parsed = parseBase64DataUrl(attachment.dataUrl);
            if (!parsed || !parsed.mimeType.startsWith("image/")) {
              return yield* new RouteRequestError({
                message: `Invalid image attachment payload for '${attachment.name}'.`,
              });
            }

            const bytes = Buffer.from(parsed.base64, "base64");
            if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
              return yield* new RouteRequestError({
                message: `Image attachment '${attachment.name}' is empty or too large.`,
              });
            }

            const attachmentId = createAttachmentId(params.ownerId);
            if (!attachmentId) {
              return yield* new RouteRequestError({
                message: "Failed to create a safe attachment id.",
              });
            }

            const persistedAttachment: PersistedChatAttachment = {
              type: "image",
              id: attachmentId,
              name: attachment.name,
              mimeType: parsed.mimeType.toLowerCase(),
              sizeBytes: bytes.byteLength,
            };

            const attachmentPath = resolveAttachmentPath({
              stateDir: serverConfig.stateDir,
              attachment: persistedAttachment,
            });
            if (!attachmentPath) {
              return yield* new RouteRequestError({
                message: `Failed to resolve persisted path for '${attachment.name}'.`,
              });
            }

            yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new RouteRequestError({
                    message: `Failed to create attachment directory for '${attachment.name}'.`,
                  }),
              ),
            );
            yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
              Effect.mapError(
                () =>
                  new RouteRequestError({
                    message: `Failed to persist attachment '${attachment.name}'.`,
                  }),
              ),
            );

            return persistedAttachment;
          }),
        { concurrency: 1 },
      );
    });

    switch (input.command.type) {
      case "thread.turn.start": {
        const normalizedAttachments = (yield* persistClientAttachments({
          ownerId: input.command.threadId,
          attachments: input.command.message.attachments,
        })) as ReadonlyArray<PersistedChatAttachment> | undefined;
        return {
          ...input.command,
          message: {
            ...input.command.message,
            attachments: normalizedAttachments ?? [],
          },
        } as OrchestrationCommand;
      }

      case "task.create": {
        const normalizedAttachments = (yield* persistClientAttachments({
          ownerId: input.command.taskId,
          attachments: input.command.attachments,
        })) as ReadonlyArray<PersistedChatAttachment> | undefined;
        return {
          ...input.command,
          ...(normalizedAttachments !== undefined ? { attachments: normalizedAttachments } : {}),
        } as OrchestrationCommand;
      }

      case "task.meta.update": {
        const normalizedAttachments = (yield* persistClientAttachments({
          ownerId: input.command.taskId,
          attachments: input.command.attachments,
        })) as ReadonlyArray<PersistedChatAttachment> | undefined;
        return {
          ...input.command,
          ...(normalizedAttachments !== undefined ? { attachments: normalizedAttachments } : {}),
        } as OrchestrationCommand;
      }

      case "thread.handoff.create": {
        const handoffCommand = input.command;
        const normalizedImportedMessages = yield* Effect.forEach(
          handoffCommand.importedMessages,
          (message) =>
            Effect.gen(function* () {
              const normalizedAttachments = (yield* persistClientAttachments({
                ownerId: handoffCommand.threadId,
                attachments: message.attachments,
              })) as ReadonlyArray<PersistedChatAttachment> | undefined;
              return {
                ...message,
                ...(normalizedAttachments !== undefined ? { attachments: normalizedAttachments } : {}),
              };
            }),
          { concurrency: 1 },
        );
        return {
          ...handoffCommand,
          importedMessages: normalizedImportedMessages,
        } as OrchestrationCommand;
      }

      default:
        return input.command as OrchestrationCommand;
    }
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const errorInbox = yield* ErrorInboxService;
  const startup = yield* ServerRuntimeStartup;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    broadcastPush({
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.changes, (event) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      yield* broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: event.issues,
          providers,
        },
      });
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(providerRegistry.streamChanges, (providers) =>
    Effect.gen(function* () {
      const providerAccounts = [yield* codexAccountService.getSnapshot()];
      const mergedProviders = overlayProviderStatuses({
        providerStatuses: providers,
        providerAccounts,
      });
      yield* broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: [],
          providers: mergedProviders,
        },
      });
      yield* broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverProviderStateUpdated,
        data: {
          providers: mergedProviders,
          providerAccounts,
        },
      });
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      yield* broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: [],
          providers,
          settings,
        },
      });
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(codexAccountService.updates, (providerAccount) =>
    Effect.gen(function* () {
      const providerAccounts = [providerAccount];
      const providerStatuses = yield* providerRegistry.getProviders;
      const providers = overlayProviderStatuses({
        providerStatuses,
        providerAccounts,
      });
      yield* broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverProviderStateUpdated,
        data: {
          providers,
          providerAccounts,
        },
      });
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(errorInbox.updates, (payload) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverErrorInboxUpdated,
      data: payload satisfies ServerErrorInboxUpdatedPayload,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runPromise = yield* Effect.map(Effect.services<never>(), Effect.runPromiseWith);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close web socket server", { cause: error }),
        ),
      ),
    ]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        if (normalizedCommand.type === "thread.archive") {
          const snapshot = yield* projectionReadModelQuery.getSnapshot();
          const thread = snapshot.threads.find(
            (entry) => entry.id === normalizedCommand.threadId && entry.deletedAt === null,
          );
          const archiveResult = yield* startup.enqueueCommand(
            orchestrationEngine.dispatch(normalizedCommand),
          );

          if (
            thread?.session &&
            thread.session.status !== "stopped"
          ) {
            yield* startup
              .enqueueCommand(
                orchestrationEngine.dispatch({
                  type: "thread.session.stop",
                  commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                  threadId: normalizedCommand.threadId,
                  createdAt: new Date().toISOString(),
                }),
              )
              .pipe(Effect.catch(() => Effect.void));
          }

          yield* terminalManager
            .close({
              threadId: normalizedCommand.threadId,
              deleteHistory: true,
            })
            .pipe(Effect.catch(() => Effect.void));

          return archiveResult;
        }
        return yield* startup.enqueueCommand(orchestrationEngine.dispatch(normalizedCommand));
      }

      case ORCHESTRATION_WS_METHODS.getCommandReceipt: {
        const receipt = yield* commandReceiptRepository.getByCommandId({
          commandId: request.body.commandId,
        });
        if (Option.isNone(receipt)) {
          return null;
        }
        return {
          status: receipt.value.status,
          resultSequence: receipt.value.resultSequence,
          error: receipt.value.error,
        };
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsListDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsReadFile: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => readWorkspaceFile(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to read workspace file: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to prepare workspace path: ${String(cause)}`,
              }),
          ),
        );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitClone: {
        const body = stripRequestTag(request.body);
        return yield* git.cloneRepo(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providerState = yield* getProviderStateSnapshot();
        const settings = yield* serverSettings.getSettings;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerState.providers,
          providerAccounts: providerState.providerAccounts,
          availableEditors,
          settings,
        };

      case WS_METHODS.serverGetSettings:
        return yield* serverSettings.getSettings;

      case WS_METHODS.serverGetErrorInbox:
        return yield* errorInbox.listEntries();

      case WS_METHODS.serverReportClientDiagnostic: {
        const body = stripRequestTag(request.body);
        const entry = yield* errorInbox.capture({
          source: body.source,
          category: body.category,
          severity: body.severity,
          summary: body.summary,
          detail: body.detail ?? null,
          projectId: body.projectId ?? null,
          threadId: body.threadId ?? null,
          turnId: body.turnId ?? null,
          provider: body.provider ?? null,
          context: body.context ?? {},
          ...(body.occurredAt !== undefined ? { occurredAt: body.occurredAt } : {}),
        });
        return { entry };
      }

      case WS_METHODS.serverSetErrorInboxEntryResolution: {
        const body = stripRequestTag(request.body);
        const entry = yield* errorInbox.setResolution(body.entryId, body.resolution);
        return { entry };
      }

      case WS_METHODS.serverPromoteErrorInboxEntryToTask: {
        const body = stripRequestTag(request.body);
        return yield* errorInbox.promoteToTask({
          entryId: body.entryId,
          projectId: body.projectId ?? null,
        });
      }

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.serverStartProviderLogin: {
        const body = stripRequestTag(request.body);
        if (body.provider !== "codex" || body.type !== "chatgpt") {
          return yield* new RouteRequestError({
            message: "Unsupported provider login request.",
          });
        }
        return yield* codexAccountService.startChatGptLogin();
      }

      case WS_METHODS.serverCancelProviderLogin: {
        const body = stripRequestTag(request.body);
        if (body.provider !== "codex") {
          return yield* new RouteRequestError({
            message: "Unsupported provider login cancel request.",
          });
        }
        return yield* codexAccountService.cancelLogin(body.loginId);
      }

      case WS_METHODS.serverLogoutProvider: {
        const body = stripRequestTag(request.body);
        if (body.provider !== "codex") {
          return yield* new RouteRequestError({
            message: "Unsupported provider logout request.",
          });
        }
        yield* codexAccountService.logout();
        return {};
      }

      case WS_METHODS.serverSuggestNewThreadTasks: {
        const body = stripRequestTag(request.body);
        const [snapshot, errorInboxEntries, gitStatus] = yield* Effect.all([
          projectionReadModelQuery.getSnapshot(),
          errorInbox.listEntries(),
          gitManager.status({ cwd: body.cwd }),
        ]);
        return yield* Effect.tryPromise({
          try: () =>
            suggestNewThreadTasks({
              request: body,
              snapshot,
              errorInboxEntries,
              gitStatus,
              codexAdapter: {
                listSessions: async () =>
                  (await Effect.runPromise(codexAdapter.listSessions())).map((session) => {
                    const result: { cwd?: string; resumeCursor?: unknown } = {};
                    if (session.cwd) {
                      result.cwd = session.cwd;
                    }
                    if (session.resumeCursor !== undefined) {
                      result.resumeCursor = session.resumeCursor;
                    }
                    return result;
                  }),
                listStoredThreads: (input) =>
                  Effect.runPromise(codexAdapter.listStoredThreads(input)),
                listStoredSkills: (input) =>
                  Effect.runPromise(codexAdapter.listStoredSkills(input)),
                readStoredThread: (input) =>
                  Effect.runPromise(codexAdapter.readStoredThread(input)),
                archiveStoredThread: (input) =>
                  Effect.runPromise(codexAdapter.archiveStoredThread(input)),
                startReview: (input) => Effect.runPromise(codexAdapter.startReview(input)),
                startSession: (input) => Effect.runPromise(codexAdapter.startSession(input)),
                stopSession: (threadId) => Effect.runPromise(codexAdapter.stopSession(threadId)),
              },
            }),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to suggest new thread tasks: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.serverUpdateSettings: {
        const body = stripRequestTag(request.body);
        const settings = yield* serverSettings.updateSettings(body);
        yield* providerRegistry.refresh("opencode").pipe(Effect.ignore);
        return settings;
      }

      case WS_METHODS.providerGetComposerCapabilities: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.getComposerCapabilities(body);
      }

      case WS_METHODS.providerListCommands: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.listCommands(body);
      }

      case WS_METHODS.providerListSkills: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.listSkills(body);
      }

      case WS_METHODS.providerListPlugins: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.listPlugins(body);
      }

      case WS_METHODS.providerReadPlugin: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.readPlugin(body);
      }

      case WS_METHODS.providerListModels: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscovery.listModels(body);
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${Cause.pretty(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: Cause.pretty(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });

    ws.send(response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd,
        projectName,
        ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
        ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
      },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* errorInbox.capture({
                source: "server-internal",
                category: "websocket",
                severity: "error",
                summary: "WebSocket message handler failed",
                detail: error instanceof Error ? error.message : String(error),
                context: {
                  error,
                },
              }).pipe(Effect.catch(() => Effect.void));
              yield* Effect.logError("Error handling message", error);
            }),
          ),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
