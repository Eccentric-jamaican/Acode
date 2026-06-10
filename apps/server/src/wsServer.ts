/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as OS from "node:os";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  PROVIDER_UPDATE_CONFIG,
  type ChatAttachment as PersistedChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationThread,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderKind,
  ProjectId,
  type ServerErrorInboxUpdatedPayload,
  ThreadId,
  TerminalEvent,
  type UploadChatAttachment,
  type ComputerUseSettingsPatch,
  type RemoteAccessClient,
  type RemoteAccessPairingLink,
  RemoteAccessPermission,
  type RemoteAccessPermission as RemoteAccessPermissionType,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type ServerProviderAccountSummary,
  type ServerProviderStatus,
  type ServerUpdateProviderInput,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { verifyDpopProof } from "@t3tools/shared/dpop";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  listWorkspaceDirectory,
  listWorkspaceTree,
  readWorkspaceFileMetadata,
  readWorkspaceFile,
  recordWorkspaceFileWrite,
  renameWorkspaceEntry,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderUpdate } from "./provider/Services/ProviderUpdate";
import { CodexAccountService } from "./provider/Services/CodexAccountService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function resolveUpdateAvailable(
  latestVersion: string | null | undefined,
  currentVersion: string | null | undefined,
  trusted: boolean,
): boolean {
  return trusted && latestVersion !== null && latestVersion !== undefined && currentVersion !== null && currentVersion !== undefined
    ? compareSemver(latestVersion, currentVersion) > 0
    : false;
}

function resolveProviderUpdateCommand(input: ServerUpdateProviderInput): string {
  const command = PROVIDER_UPDATE_CONFIG[input.provider].commands.find(
    (candidate) => candidate.id === input.commandId,
  );
  if (!command) {
    throw new RouteRequestError({
      message: `Unknown update command for provider ${input.provider}: ${input.commandId}`,
    });
  }
  return command.command;
}
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
import {
  COMPUTER_USE_APP_ICON_ROUTE_PATH,
  listComputerUseApps,
  resolveComputerUseAppIcon,
} from "./computerUseService";

const STANDARD_REMOTE_ACCESS_SCOPES: RemoteAccessPermission[] = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];

const ALL_REMOTE_ACCESS_SCOPES: RemoteAccessPermission[] = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
];

const TAILSCALE_COMMAND = process.platform === "win32" ? "tailscale.exe" : "tailscale";
const TAILSCALE_SERVE_PORT = 443;

function runTailscaleCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      TAILSCALE_COMMAND,
      [...args],
      { timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr.trim() ||
                (error instanceof Error ? error.message : `tailscale ${args.join(" ")} failed`),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function readTailscaleMagicDnsName(): Promise<string | null> {
  const stdout = await runTailscaleCommand(["status", "--json"]);
  const parsed = JSON.parse(stdout) as {
    Self?: {
      DNSName?: string;
    };
  };
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
  return dnsName && dnsName.length > 0 ? dnsName : null;
}

async function enableTailscaleServe(input: {
  localPort: number;
  localHost?: string;
  servePort?: number;
}): Promise<string | null> {
  const localHost = input.localHost ?? "127.0.0.1";
  const servePort = input.servePort ?? TAILSCALE_SERVE_PORT;
  await runTailscaleCommand([
    "serve",
    "--bg",
    `--https=${servePort}`,
    `http://${localHost}:${input.localPort}`,
  ]);
  const magicDnsName = await readTailscaleMagicDnsName();
  if (!magicDnsName) {
    return null;
  }
  return servePort === 443 ? `https://${magicDnsName}/` : `https://${magicDnsName}:${servePort}/`;
}

async function disableTailscaleServe(servePort = TAILSCALE_SERVE_PORT): Promise<void> {
  await runTailscaleCommand(["serve", `--https=${servePort}`, "off"]);
}

function buildPairingUrl(baseUrl: string, credential: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/pair";
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

function readJsonRequest(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.trim().length > 0 ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readRequestBodyText(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function readRequestBodyBytes(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    });
  });
}

function parseAuthorizationHeader(value: string | undefined): {
  method: "bearer-access-token" | "dpop-access-token";
  token: string;
} | null {
  if (!value) {
    return null;
  }
  const [scheme, ...rest] = value.trim().split(/\s+/);
  const token = rest.join(" ").trim();
  if (!scheme || token.length === 0) {
    return null;
  }
  const normalizedScheme = scheme.toLowerCase();
  if (normalizedScheme === "bearer") {
    return { method: "bearer-access-token", token };
  }
  if (normalizedScheme === "dpop") {
    return { method: "dpop-access-token", token };
  }
  return null;
}

function remoteAuthFailure(statusCode: 401 | 403, code: string, message: string) {
  return {
    ok: false,
    failure: {
      statusCode,
      code,
      message,
    },
  } as const;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === undefined ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1"
  );
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const host = value.split(":")[0]?.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(
  req: http.IncomingMessage,
  fallbackPort: number,
  options?: {
    readonly forceHttpsHosts?: ReadonlyArray<string>;
  },
): string {
  try {
    const absolute = new URL(req.url ?? "/");
    return absolute.href;
  } catch {
    const host = firstHeaderValue(req.headers.host) ?? `127.0.0.1:${fallbackPort}`;
    const normalizedHost = host.toLowerCase();
    const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
    const forceHttps =
      options?.forceHttpsHosts?.some(
        (candidate) => candidate.trim().toLowerCase() === normalizedHost,
      ) ?? false;
    const proto =
      forwardedProto === "https" || forwardedProto === "http"
        ? forwardedProto
        : forceHttps
          ? "https"
          : "http";
    return new URL(req.url ?? "/", `${proto}://${host}`).href;
  }
}

function readDpopProof(req: http.IncomingMessage, fallbackPort: number): string | null {
  if (typeof req.headers.dpop === "string" && req.headers.dpop.trim().length > 0) {
    return req.headers.dpop.trim();
  }
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${fallbackPort}`);
    const proof = url.searchParams.get("dpop");
    return proof && proof.trim().length > 0 ? proof.trim() : null;
  } catch {
    return null;
  }
}

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
    | Scope.Scope
    | ServerRuntimeServices
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
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

function normalizedUploadAttachmentType(mimeType: string): "image" | "pdf" | null {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return "image";
  }
  if (normalizedMimeType === "application/pdf") {
    return "pdf";
  }
  return null;
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
  | ProviderUpdate
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

type ServerRuntimeContext =
  | Scope.Scope
  | ServerRuntimeServices
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | SqlClient.SqlClient;

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
  ServerRuntimeContext
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
  const homeDirectory = OS.homedir();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const providerUpdate = yield* ProviderUpdate;
  const providerService = yield* ProviderService;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerRegistry = Option.getOrUndefined(yield* Effect.serviceOption(ProviderRegistry)) ?? {
    getProviders: providerHealth.getStatuses,
    refresh: () => providerHealth.getStatuses,
    streamChanges: Stream.empty,
  };
  const codexAccountService = yield* CodexAccountService;
  const codexAdapter = yield* CodexAdapter;
  const serverSettings = Option.getOrUndefined(
    yield* Effect.serviceOption(ServerSettingsService),
  ) ?? {
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
    streamChanges: Stream.empty,
  };
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const chatWorkspaceRoot = path.join(homeDirectory, "Documents", "A Code", "Chats");

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
  let remoteNetworkAccessEnabled = Boolean(host && host !== "127.0.0.1" && host !== "localhost");
  let tailscaleHttpsEnabled = false;
  let tailscaleHttpsUrl: string | null = null;
  const remoteWebSocketTickets = new Map<string, RemoteWebSocketTicket>();
  const REMOTE_WEBSOCKET_TICKET_TTL_MS = 60_000;
  const REMOTE_WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

  type AuthPairingLinkRow = {
    readonly id: string;
    readonly credential: string;
    readonly scopes: string;
    readonly label: string | null;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
  type AuthSessionRow = {
    readonly sessionId: string;
    readonly scopes: string;
    readonly method: string;
    readonly proofKeyThumbprint: string | null;
    readonly clientLabel: string | null;
    readonly clientIpAddress: string | null;
    readonly clientDeviceType: string;
    readonly clientOs: string | null;
    readonly clientBrowser: string | null;
    readonly lastConnectedAt: string | null;
  };
  type AuthSessionTicketRow = {
    readonly sessionId: string;
    readonly scopes: string;
  };
  type RemoteAccessAuthContext =
    | { readonly kind: "local"; readonly scopes: ReadonlyArray<RemoteAccessPermissionType> }
    | {
        readonly kind: "remote";
        readonly sessionId: string;
        readonly scopes: ReadonlyArray<RemoteAccessPermissionType>;
      };
  type RemoteAccessAuthFailure = {
    readonly statusCode: 401 | 403;
    readonly code: string;
    readonly message: string;
  };
  type RemoteAccessAuthResult =
    | { readonly ok: true; readonly context: RemoteAccessAuthContext }
    | { readonly ok: false; readonly failure: RemoteAccessAuthFailure };
  type RemoteWebSocketTicket = {
    readonly sessionId: string;
    readonly expiresAtMs: number;
  };

  const parseRemoteAccessScopes = (raw: string): RemoteAccessPermissionType[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((value): value is RemoteAccessPermissionType =>
        Schema.is(RemoteAccessPermission)(value),
      );
    } catch {
      return [];
    }
  };

  const normalizeRemoteAccessScopes = (
    scopes: ReadonlyArray<RemoteAccessPermissionType>,
  ): RemoteAccessPermissionType[] => {
    const uniqueScopes = Array.from(
      new Set(scopes.filter((scope) => ALL_REMOTE_ACCESS_SCOPES.includes(scope))),
    );
    return uniqueScopes.length > 0 ? uniqueScopes : [...STANDARD_REMOTE_ACCESS_SCOPES];
  };

  const remoteSettingValue = Effect.fnUntraced(function* (key: string) {
    const rows = yield* sql<{ readonly value: string }>`
      SELECT value
      FROM remote_access_settings
      WHERE key = ${key}
      LIMIT 1
    `;
    return rows[0]?.value ?? null;
  });

  const writeRemoteSetting = Effect.fnUntraced(function* (key: string, value: string) {
    yield* sql`
      INSERT INTO remote_access_settings (key, value, updated_at)
      VALUES (${key}, ${value}, ${new Date().toISOString()})
      ON CONFLICT (key)
      DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `;
  });

  const loadRemoteAccessSettings = Effect.gen(function* () {
    const [networkAccess, tailscaleEnabled, tailscaleUrl] = yield* Effect.all([
      remoteSettingValue("networkAccessEnabled"),
      remoteSettingValue("tailscaleHttpsEnabled"),
      remoteSettingValue("tailscaleHttpsUrl"),
    ]);
    remoteNetworkAccessEnabled =
      networkAccess === null ? remoteNetworkAccessEnabled : networkAccess === "true";
    tailscaleHttpsEnabled = tailscaleEnabled === "true";
    tailscaleHttpsUrl = tailscaleUrl && tailscaleUrl.length > 0 ? tailscaleUrl : null;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to load remote access settings", {
        cause: String(cause),
      }),
    ),
  );

  yield* loadRemoteAccessSettings;

  const remoteBaseUrl = () => {
    const displayHost =
      host && host !== "0.0.0.0" && host !== "::" && host !== "[::]" ? host : "localhost";
    const formattedHost =
      displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
    return `http://${formattedHost}:${port}`;
  };

  const isRemoteRequest = (req: http.IncomingMessage) =>
    !isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host);

  const isTailscaleHostRequest = (req: http.IncomingMessage) => {
    if (!tailscaleHttpsEnabled || !tailscaleHttpsUrl) {
      return false;
    }
    const requestHost = firstHeaderValue(req.headers.host)?.toLowerCase();
    if (!requestHost) {
      return false;
    }
    try {
      return new URL(tailscaleHttpsUrl).host.toLowerCase() === requestHost;
    } catch {
      return false;
    }
  };

  const isRemoteAccessAllowedForRequest = (req: http.IncomingMessage) =>
    !isRemoteRequest(req) || remoteNetworkAccessEnabled || isTailscaleHostRequest(req);

  const remoteAccessSnapshot = () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const [pairingRows, sessionRows] = yield* Effect.all([
        sql<AuthPairingLinkRow>`
        SELECT
          id,
          credential,
          scopes,
          label,
          created_at AS "createdAt",
          expires_at AS "expiresAt"
        FROM auth_pairing_links
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
      `,
        sql<AuthSessionRow>`
        SELECT
          session_id AS "sessionId",
          scopes,
          method,
          proof_key_thumbprint AS "proofKeyThumbprint",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          last_connected_at AS "lastConnectedAt"
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND expires_at > ${now}
        ORDER BY issued_at DESC, session_id DESC
        `,
      ]);
      const baseUrl = tailscaleHttpsUrl ?? remoteBaseUrl();
      const connectedCutoff = Date.now() - 120_000;
      return {
        networkAccessEnabled: remoteNetworkAccessEnabled,
        tailscaleHttpsEnabled,
        tailscaleHttpsUrl,
        pairingLinks: pairingRows.map((row) => ({
          id: row.id,
          label: row.label,
          credential: row.credential,
          scopes: parseRemoteAccessScopes(row.scopes),
          url: buildPairingUrl(baseUrl, row.credential),
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        })),
        clients: sessionRows.map((row) => ({
          id: row.sessionId,
          label: row.clientLabel ?? "Paired client",
          deviceType: row.clientDeviceType,
          os: row.clientOs ?? "Unknown",
          client: row.clientBrowser ?? "Unknown",
          host: row.clientIpAddress ?? "remote",
          scopes: parseRemoteAccessScopes(row.scopes),
          isCurrent: false,
          connected: row.lastConnectedAt
            ? Date.parse(row.lastConnectedAt) >= connectedCutoff
            : false,
        })),
        remoteEnvironments: [],
      };
    });

  const createRemotePairingLink = Effect.fnUntraced(function* (input: {
    label?: string | undefined;
    scopes: ReadonlyArray<RemoteAccessPermissionType>;
    proofKeyThumbprint?: string | null | undefined;
  }) {
    const credential = randomUUID().replaceAll("-", "");
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const scopes = normalizeRemoteAccessScopes(input.scopes);
    const pairingLink: RemoteAccessPairingLink = {
      id: randomUUID(),
      label: input.label?.trim() || null,
      credential,
      scopes,
      url: buildPairingUrl(tailscaleHttpsUrl ?? remoteBaseUrl(), credential),
      createdAt,
      expiresAt,
    };
    yield* sql`
      INSERT INTO auth_pairing_links (
        id,
        credential,
        method,
        scopes,
        subject,
        label,
        proof_key_thumbprint,
        created_at,
        expires_at,
        consumed_at,
        revoked_at
      )
      VALUES (
        ${pairingLink.id},
        ${credential},
        ${"one-time-token"},
        ${JSON.stringify(scopes)},
        ${"remote-client"},
        ${pairingLink.label},
        ${input.proofKeyThumbprint ?? null},
        ${createdAt},
        ${expiresAt},
        NULL,
        NULL
      )
    `;
    return {
      pairingLink,
      snapshot: yield* remoteAccessSnapshot(),
    };
  });

  const exchangeRemotePairingCode = Effect.fnUntraced(function* (input: {
    credential: string;
    label?: string | undefined;
    deviceType?: string | undefined;
    os?: string | undefined;
    client?: string | undefined;
    host?: string | undefined;
    userAgent?: string | undefined;
    proofKeyThumbprint?: string | null | undefined;
  }) {
    const credential = input.credential.trim();
    const now = new Date();
    const consumedAt = now.toISOString();
    const pairingRows = yield* sql<
      AuthPairingLinkRow & { readonly proofKeyThumbprint: string | null }
    >`
      UPDATE auth_pairing_links
      SET consumed_at = ${consumedAt}
      WHERE credential = ${credential}
        AND revoked_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > ${consumedAt}
        AND (
          proof_key_thumbprint IS NULL
          OR proof_key_thumbprint = ${input.proofKeyThumbprint ?? null}
        )
      RETURNING
        id,
        credential,
        scopes,
        label,
        proof_key_thumbprint AS "proofKeyThumbprint",
        created_at AS "createdAt",
        expires_at AS "expiresAt"
    `;
    const pairingLink = pairingRows[0];
    if (!pairingLink) {
      return null;
    }
    const sessionToken = randomUUID().replaceAll("-", "");
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60_000).toISOString();
    const scopes = parseRemoteAccessScopes(pairingLink.scopes);
    const method = input.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token";
    yield* sql`
      INSERT INTO auth_sessions (
        session_id,
        subject,
        scopes,
        method,
        client_label,
        client_ip_address,
        client_user_agent,
        client_device_type,
        client_os,
        client_browser,
        proof_key_thumbprint,
        issued_at,
        expires_at,
        last_connected_at,
        revoked_at
      )
      VALUES (
        ${sessionToken},
        ${"remote-client"},
        ${JSON.stringify(scopes)},
        ${method},
        ${input.label?.trim() || pairingLink.label || "Paired client"},
        ${input.host?.trim() || "remote"},
        ${input.userAgent?.trim() || null},
        ${input.deviceType?.trim() || "unknown"},
        ${input.os?.trim() || null},
        ${input.client?.trim() || null},
        ${input.proofKeyThumbprint ?? null},
        ${consumedAt},
        ${expiresAt},
        ${consumedAt},
        NULL
      )
    `;
    const client: RemoteAccessClient = {
      id: sessionToken,
      sessionToken,
      label: input.label?.trim() || pairingLink.label || "Paired client",
      deviceType: input.deviceType?.trim() || "unknown",
      os: input.os?.trim() || "Unknown",
      client: input.client?.trim() || "Unknown",
      host: input.host?.trim() || "remote",
      scopes,
      isCurrent: false,
      connected: true,
    };
    return {
      sessionToken,
      client,
      snapshot: yield* remoteAccessSnapshot(),
    };
  });

  const pruneRemoteWebSocketTickets = (nowMs: number) => {
    for (const [ticket, issued] of remoteWebSocketTickets) {
      if (issued.expiresAtMs <= nowMs) {
        remoteWebSocketTickets.delete(ticket);
      }
    }
  };

  const issueRemoteWebSocketTicket = (authContext: RemoteAccessAuthContext) => {
    if (authContext.kind !== "remote") {
      return null;
    }
    const nowMs = Date.now();
    pruneRemoteWebSocketTickets(nowMs);
    const ticket = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const expiresAtMs = nowMs + REMOTE_WEBSOCKET_TICKET_TTL_MS;
    remoteWebSocketTickets.set(ticket, {
      sessionId: authContext.sessionId,
      expiresAtMs,
    });
    return {
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  };

  const consumeRemoteWebSocketTicket = Effect.fnUntraced(function* (ticket: string) {
    const nowMs = Date.now();
    pruneRemoteWebSocketTickets(nowMs);
    const issued = remoteWebSocketTickets.get(ticket);
    if (!issued) {
      return null;
    }
    remoteWebSocketTickets.delete(ticket);

    const now = new Date(nowMs).toISOString();
    const rows = yield* sql<AuthSessionTicketRow>`
      SELECT
        session_id AS "sessionId",
        scopes
      FROM auth_sessions
      WHERE session_id = ${issued.sessionId}
        AND revoked_at IS NULL
        AND expires_at > ${now}
      LIMIT 1
    `;
    const session = rows[0];
    if (!session) {
      return null;
    }
    yield* sql`
      UPDATE auth_sessions
      SET last_connected_at = ${now}
      WHERE session_id = ${session.sessionId}
        AND revoked_at IS NULL
    `;
    return {
      kind: "remote",
      sessionId: session.sessionId,
      scopes: parseRemoteAccessScopes(session.scopes),
    } satisfies RemoteAccessAuthContext;
  });

  const verifyRequestDpop = Effect.fnUntraced(function* (input: {
    req: http.IncomingMessage;
    accessToken?: string;
    expectedThumbprint?: string | null;
  }) {
    const proof = readDpopProof(input.req, port);
    if (!proof) {
      return yield* new RouteRequestError({
        message: "Missing DPoP proof.",
      });
    }
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const forceHttpsHosts =
      tailscaleHttpsUrl !== null
        ? (() => {
            try {
              return [new URL(tailscaleHttpsUrl).host];
            } catch {
              return [] as string[];
            }
          })()
        : [];
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyDpopProof({
          proof,
          method: input.req.method ?? "GET",
          url: requestAbsoluteUrl(input.req, port, { forceHttpsHosts }),
          nowEpochSeconds,
          ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
          ...(input.accessToken ? { expectedAccessToken: input.accessToken } : {}),
        }),
      catch: () => new RouteRequestError({ message: "Failed to verify DPoP proof." }),
    });
    if (!verification.ok) {
      return yield* new RouteRequestError({
        message: verification.reason,
      });
    }
    const replayKey = createHash("sha256")
      .update(`${verification.thumbprint}:${verification.jti}`)
      .digest("base64url");
    const expiresAt = new Date((verification.iat + 300) * 1000).toISOString();
    const consumedAt = new Date().toISOString();
    const inserted = yield* sql<{ readonly replayKey: string }>`
      INSERT INTO auth_dpop_proofs (
        replay_key,
        thumbprint,
        jti,
        consumed_at,
        expires_at
      )
      VALUES (
        ${replayKey},
        ${verification.thumbprint},
        ${verification.jti},
        ${consumedAt},
        ${expiresAt}
      )
      ON CONFLICT (replay_key) DO NOTHING
      RETURNING replay_key AS "replayKey"
    `;
    if (inserted.length === 0) {
      return yield* new RouteRequestError({
        message: "DPoP proof replayed.",
      });
    }
    return verification.thumbprint;
  });

  const dpopFailureMessage = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.squash(cause);
    return error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "Invalid DPoP proof.";
  };

  const resolveRemoteAccessAuth = (req: http.IncomingMessage) =>
    Effect.gen(function* () {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const requestIsLocal =
        isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(req.headers.host);
      if (!isRemoteAccessAllowedForRequest(req)) {
        return remoteAuthFailure(
          403,
          "remote_access_disabled",
          "Remote access is disabled for this backend.",
        );
      }
      const webSocketTicket = url.searchParams.get(REMOTE_WEBSOCKET_TICKET_QUERY_PARAM);
      if (webSocketTicket && webSocketTicket.trim().length > 0) {
        const context = yield* consumeRemoteWebSocketTicket(webSocketTicket.trim());
        return context
          ? ({ ok: true, context } satisfies RemoteAccessAuthResult)
          : remoteAuthFailure(
              401,
              "invalid_websocket_ticket",
              "The WebSocket ticket is invalid or expired.",
            );
      }
      const authorization = parseAuthorizationHeader(req.headers.authorization);
      const queryToken = url.searchParams.get("access_token");
      const token = authorization?.token ?? queryToken;
      if (!token) {
        return requestIsLocal
          ? ({
              ok: true,
              context: {
                kind: "local",
                scopes: ALL_REMOTE_ACCESS_SCOPES,
              },
            } satisfies RemoteAccessAuthResult)
          : remoteAuthFailure(
              401,
              "missing_credential",
              "Missing remote access credential.",
            );
      }
      const now = new Date().toISOString();
      const rows = yield* sql<AuthSessionRow>`
      SELECT
        session_id AS "sessionId",
        scopes,
        method,
        proof_key_thumbprint AS "proofKeyThumbprint",
        client_label AS "clientLabel",
        client_ip_address AS "clientIpAddress",
        client_device_type AS "clientDeviceType",
        client_os AS "clientOs",
        client_browser AS "clientBrowser",
        last_connected_at AS "lastConnectedAt"
      FROM auth_sessions
      WHERE session_id = ${token}
        AND revoked_at IS NULL
        AND expires_at > ${now}
      LIMIT 1
      `;
      const session = rows[0];
      if (!session) {
        return remoteAuthFailure(
          401,
          "invalid_credential",
          "The remote access token is unknown, revoked, or expired.",
        );
      }
      if (authorization && session.method !== authorization.method) {
        return remoteAuthFailure(
          401,
          "invalid_credential",
          `The token requires ${session.method} authentication.`,
        );
      }
      if (session.method === "dpop-access-token") {
        const hasQueryDpopProof = queryToken === token && readDpopProof(req, port) !== null;
        if (authorization?.method !== "dpop-access-token" && !hasQueryDpopProof) {
          return remoteAuthFailure(
            401,
            "invalid_dpop",
            "DPoP-bound access token requires DPoP authorization and proof.",
          );
        }
        if (!session.proofKeyThumbprint) {
          return remoteAuthFailure(
            401,
            "invalid_dpop",
            "DPoP-bound access token is missing a stored proof key.",
          );
        }
        const verification = yield* Effect.exit(verifyRequestDpop({
          req,
          accessToken: token,
          expectedThumbprint: session.proofKeyThumbprint,
        }));
        if (Exit.isFailure(verification)) {
          return remoteAuthFailure(401, "invalid_dpop", dpopFailureMessage(verification.cause));
        }
      }
      yield* sql`
      UPDATE auth_sessions
      SET last_connected_at = ${now}
      WHERE session_id = ${session.sessionId}
        AND revoked_at IS NULL
      `;
      return {
        ok: true,
        context: {
          kind: "remote",
          sessionId: session.sessionId,
          scopes: parseRemoteAccessScopes(session.scopes),
        },
      } satisfies RemoteAccessAuthResult;
    });

  const requiredRemoteAccessScope = (
    method: WebSocketRequest["body"]["_tag"],
  ): RemoteAccessPermissionType | null => {
    if (
      method === WS_METHODS.remoteAccessCreatePairingLink ||
      method === WS_METHODS.remoteAccessRevokePairingLink ||
      method === WS_METHODS.remoteAccessRevokeClient ||
      method === WS_METHODS.remoteAccessRevokeOtherClients ||
      method === WS_METHODS.remoteAccessSetNetworkAccess
    ) {
      return "access:write";
    }
    if (method === WS_METHODS.remoteAccessSetTailscaleHttps) {
      return "relay:write";
    }
    if (method === WS_METHODS.remoteAccessGetSnapshot) {
      return "access:read";
    }
    if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
      return "orchestration:operate";
    }
    if (
      method === WS_METHODS.terminalOpen ||
      method === WS_METHODS.terminalWrite ||
      method === WS_METHODS.terminalResize ||
      method === WS_METHODS.terminalClose
    ) {
      return "terminal:operate";
    }
    if (
      method === WS_METHODS.projectsWriteFile ||
      method === WS_METHODS.projectsCreateDirectory ||
      method === WS_METHODS.projectsDeleteEntry ||
      method === WS_METHODS.projectsRenameEntry
    ) {
      return "orchestration:operate";
    }
    return "orchestration:read";
  };

  const authorizeRemoteAccessRequest = (
    authContext: RemoteAccessAuthContext,
    method: WebSocketRequest["body"]["_tag"],
  ): Effect.Effect<void, RouteRequestError> => {
    if (authContext.kind === "local") {
      return Effect.void;
    }
    const requiredScope = requiredRemoteAccessScope(method);
    if (!requiredScope || authContext.scopes.includes(requiredScope)) {
      return Effect.void;
    }
    return Effect.fail(
      new RouteRequestError({
        message: `Remote client is missing required permission: ${requiredScope}`,
      }),
    );
  };

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
    const updateInfo = yield* providerUpdate.getUpdates;
    const withUpdates = providers.map((providerStatus) => {
      const info = updateInfo.get(providerStatus.provider);
      if (!info) {
        return providerStatus;
      }
      const currentVersion = providerStatus.version ?? info.currentVersion ?? null;
      const updateAvailable = resolveUpdateAvailable(
        info.latestVersion,
        currentVersion,
        info.verification.trusted,
      );
      const mergedInfo = currentVersion !== info.currentVersion
        || updateAvailable !== info.updateAvailable
        ? { ...info, currentVersion, updateAvailable }
        : info;
      return {
        ...providerStatus,
        updateInfo: mergedInfo,
      };
    });
    return {
      providers: withUpdates,
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
            const attachmentType = parsed ? normalizedUploadAttachmentType(parsed.mimeType) : null;
            if (!parsed || !attachmentType) {
              return yield* new RouteRequestError({
                message: `Invalid attachment payload for '${attachment.name}'.`,
              });
            }

            const bytes = Buffer.from(parsed.base64, "base64");
            if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
              return yield* new RouteRequestError({
                message: `Attachment '${attachment.name}' is empty or too large.`,
              });
            }

            const attachmentId = createAttachmentId(params.ownerId);
            if (!attachmentId) {
              return yield* new RouteRequestError({
                message: "Failed to create a safe attachment id.",
              });
            }

            const persistedAttachment: PersistedChatAttachment =
              attachmentType === "pdf"
                ? {
                    type: "pdf",
                    id: attachmentId,
                    name: attachment.name,
                    mimeType: "application/pdf",
                    sizeBytes: bytes.byteLength,
                  }
                : {
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
                ...(normalizedAttachments !== undefined
                  ? { attachments: normalizedAttachments }
                  : {}),
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
    const respondJson = (statusCode: number, body: unknown) => {
      respond(
        statusCode,
        {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        JSON.stringify(body),
      );
    };

    void runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname === "/api/auth/pairing-token/exchange") {
          if (!isRemoteAccessAllowedForRequest(req)) {
            respondJson(403, {
              error: "remote_access_disabled",
              message: "Remote access is disabled for this backend.",
            });
            return;
          }
          if (req.method !== "POST") {
            respondJson(405, { error: "method_not_allowed" });
            return;
          }
          const payload = (yield* Effect.tryPromise({
            try: () => readJsonRequest(req),
            catch: () => new RouteRequestError({ message: "Invalid JSON request body." }),
          })) as Partial<{
            credential: string;
            label: string;
            deviceType: string;
            os: string;
            client: string;
          }>;
          if (typeof payload.credential !== "string" || payload.credential.trim().length === 0) {
            respondJson(400, { error: "missing_credential" });
            return;
          }
          const proofKeyThumbprint = yield* verifyRequestDpop({ req }).pipe(
            Effect.catchTag("RouteRequestError", (error) => {
              respondJson(401, { error: "invalid_dpop", message: error.message });
              return Effect.fail(error);
            }),
          );
          const result = yield* exchangeRemotePairingCode({
            credential: payload.credential,
            ...(typeof payload.label === "string" ? { label: payload.label } : {}),
            ...(typeof payload.deviceType === "string" ? { deviceType: payload.deviceType } : {}),
            ...(typeof payload.os === "string" ? { os: payload.os } : {}),
            ...(typeof payload.client === "string" ? { client: payload.client } : {}),
            host: req.socket.remoteAddress ?? "remote",
            userAgent:
              typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
            proofKeyThumbprint,
          });
          if (!result) {
            respondJson(401, { error: "invalid_credential" });
            return;
          }
          respondJson(200, result);
          return;
        }

        if (url.pathname === "/api/auth/websocket-ticket") {
          if (!isRemoteAccessAllowedForRequest(req)) {
            respondJson(403, {
              error: "remote_access_disabled",
              message: "Remote access is disabled for this backend.",
            });
            return;
          }
          if (req.method !== "POST") {
            respondJson(405, { error: "method_not_allowed" });
            return;
          }
          const authResult = yield* resolveRemoteAccessAuth(req);
          if (!authResult.ok) {
            respondJson(authResult.failure.statusCode, {
              error: authResult.failure.code,
              message: authResult.failure.message,
            });
            return;
          }
          if (authResult.context.kind !== "remote") {
            respondJson(401, {
              error: "invalid_credential",
              message: "WebSocket tickets require a paired remote browser session.",
            });
            return;
          }
          const issued = issueRemoteWebSocketTicket(authResult.context);
          if (!issued) {
            respondJson(401, {
              error: "invalid_credential",
              message: "Could not authenticate this remote browser session.",
            });
            return;
          }
          respondJson(200, issued);
          return;
        }

        if (url.pathname === "/api/auth/token") {
          if (!isRemoteAccessAllowedForRequest(req)) {
            respondJson(403, {
              error: "remote_access_disabled",
              message: "Remote access is disabled for this backend.",
            });
            return;
          }
          if (req.method !== "POST") {
            respondJson(405, { error: "method_not_allowed" });
            return;
          }
          const rawBody = yield* Effect.tryPromise({
            try: () => readRequestBodyText(req),
            catch: () => new RouteRequestError({ message: "Invalid token exchange body." }),
          });
          const form = new URLSearchParams(rawBody);
          const grantType = form.get("grant_type");
          const subjectToken = form.get("subject_token");
          const subjectTokenType = form.get("subject_token_type");
          const requestedTokenType = form.get("requested_token_type");
          if (
            grantType !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
            subjectTokenType !== "urn:t3:params:oauth:token-type:environment-bootstrap" ||
            requestedTokenType !== "urn:ietf:params:oauth:token-type:access_token" ||
            !subjectToken
          ) {
            respondJson(400, { error: "invalid_request" });
            return;
          }
          const proofKeyThumbprint = yield* verifyRequestDpop({ req }).pipe(
            Effect.catchTag("RouteRequestError", (error) => {
              respondJson(401, { error: "invalid_dpop", message: error.message });
              return Effect.fail(error);
            }),
          );
          const result = yield* exchangeRemotePairingCode({
            credential: subjectToken,
            ...(form.get("client_label") ? { label: form.get("client_label") ?? undefined } : {}),
            ...(form.get("client_device_type")
              ? { deviceType: form.get("client_device_type") ?? undefined }
              : {}),
            ...(form.get("client_os") ? { os: form.get("client_os") ?? undefined } : {}),
            client: "Unknown",
            host: req.socket.remoteAddress ?? "remote",
            userAgent:
              typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
            proofKeyThumbprint,
          });
          if (!result) {
            respondJson(401, { error: "invalid_grant" });
            return;
          }
          respondJson(200, {
            access_token: result.sessionToken,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 365 * 24 * 60 * 60,
            scope: result.client.scopes.join(" "),
          });
          return;
        }

        if (url.pathname === COMPUTER_USE_APP_ICON_ROUTE_PATH) {
          const pidParam = url.searchParams.get("pid");
          const pid = pidParam ? Number(pidParam) : undefined;
          const iconBytes = yield* Effect.promise(() =>
            resolveComputerUseAppIcon({
              name: url.searchParams.get("name") ?? undefined,
              launchId: url.searchParams.get("launchId") ?? undefined,
              ...(pid !== undefined && Number.isFinite(pid) ? { pid } : {}),
            }).catch(() => null),
          );
          if (!iconBytes) {
            respond(
              404,
              {
                "Content-Type": "text/plain",
                "Cache-Control": "no-store",
              },
              "Not Found",
            );
            return;
          }
          respond(
            200,
            {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400",
            },
            iconBytes,
          );
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
          const proxiedUrl = new URL(url.pathname, devUrl);
          proxiedUrl.search = url.search;
          const proxiedResponse = yield* Effect.tryPromise({
            try: async () =>
              fetch(proxiedUrl, {
                method: req.method ?? "GET",
                headers: {
                  accept: req.headers.accept ?? "*/*",
                  "content-type":
                    typeof req.headers["content-type"] === "string"
                      ? req.headers["content-type"]
                      : "",
                },
                ...(req.method && req.method !== "GET" && req.method !== "HEAD"
                  ? { body: await readRequestBodyBytes(req) }
                  : {}),
              }),
            catch: () =>
              new RouteRequestError({
                message: `Failed to proxy development request to ${proxiedUrl.toString()}.`,
              }),
          });
          const headers: Record<string, string> = {};
          for (const [key, value] of proxiedResponse.headers.entries()) {
            if (
              key.toLowerCase() === "content-type" ||
              key.toLowerCase() === "cache-control" ||
              key.toLowerCase() === "etag" ||
              key.toLowerCase() === "last-modified"
            ) {
              headers[key] = value;
            }
          }
          if (req.method === "HEAD") {
            respond(proxiedResponse.status, headers);
            return;
          }
          const proxiedBody = yield* Effect.tryPromise({
            try: () => proxiedResponse.arrayBuffer(),
            catch: () =>
              new RouteRequestError({
                message: `Failed to read proxied development response from ${proxiedUrl.toString()}.`,
              }),
          });
          respond(proxiedResponse.status, headers, new Uint8Array(proxiedBody));
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
  const { launchCommand, openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  const broadcastProviderUpdateStatus = (
    provider: ProviderKind,
    status: "started" | "finished" | "failed",
    command: string,
    message?: string,
  ) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverProviderUpdateStatus,
      data: {
        provider,
        status,
        command,
        ...(message ? { message } : {}),
      },
    });

  const refreshProviderUpdateState = (provider: ProviderKind) =>
    Effect.all([
      providerUpdate.refresh(provider),
      providerRegistry.refresh(provider),
    ]);

  const cleanupThreadsAfterBulkAction = Effect.fnUntraced(function* (
    threads: ReadonlyArray<OrchestrationThread>,
  ) {
    const uniqueThreads = Array.from(
      new Map(threads.map((thread) => [thread.id, thread] as const)).values(),
    );
    yield* Effect.forEach(
      uniqueThreads,
      (thread) =>
        Effect.all([
          thread.session && thread.session.status !== "stopped"
            ? startup
                .enqueueCommand(
                  orchestrationEngine.dispatch({
                    type: "thread.session.stop",
                    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                    threadId: thread.id,
                    createdAt: new Date().toISOString(),
                  }),
                )
                .pipe(Effect.catch(() => Effect.void))
            : Effect.void,
          terminalManager
            .close({
              threadId: thread.id,
              deleteHistory: true,
            })
            .pipe(Effect.catch(() => Effect.void)),
        ]),
      { concurrency: 8 },
    );
  });

  const runThreadCleanupInBackground = (threads: ReadonlyArray<OrchestrationThread>) =>
    cleanupThreadsAfterBulkAction(threads).pipe(Effect.forkIn(subscriptionsScope));

  const collectThreadTree = (
    threads: ReadonlyArray<OrchestrationThread>,
    rootThreadId: ThreadId,
  ): OrchestrationThread[] => {
    const selected = new Map<ThreadId, OrchestrationThread>();
    const queue: ThreadId[] = [rootThreadId];
    while (queue.length > 0) {
      const threadId = queue.shift();
      if (!threadId || selected.has(threadId)) {
        continue;
      }
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) {
        continue;
      }
      selected.set(thread.id, thread);
      for (const child of threads) {
        if (child.parentThreadId === thread.id && child.deletedAt === null) {
          queue.push(child.id);
        }
      }
    }
    return Array.from(selected.values());
  };

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
      const snapshot = yield* projectionReadModelQuery.getSnapshot({ mode: "bootstrap" });
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

  const runPromise = yield* Effect.map(
    Effect.services<ServerRuntimeContext>(),
    Effect.runPromiseWith,
  );

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void runPromise(onTerminalEvent(event)),
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

  const routeRequest = Effect.fnUntraced(function* (
    request: WebSocketRequest,
    authContext: RemoteAccessAuthContext,
  ) {
    yield* authorizeRemoteAccessRequest(authContext, request.body._tag);

    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot(stripRequestTag(request.body));

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        if (
          normalizedCommand.type === "thread.archive" ||
          normalizedCommand.type === "thread.delete" ||
          normalizedCommand.type === "project.archive" ||
          (normalizedCommand.type === "project.delete" && normalizedCommand.deleteThreads === true)
        ) {
          const snapshot = yield* projectionReadModelQuery.getSnapshot({ mode: "bootstrap" });
          const affectedThreads =
            normalizedCommand.type === "project.archive"
              ? snapshot.threads.filter(
                  (thread) =>
                    thread.projectId === normalizedCommand.projectId &&
                    thread.deletedAt === null &&
                    thread.archivedAt === null,
                )
              : normalizedCommand.type === "project.delete"
                ? snapshot.threads.filter(
                    (thread) =>
                      thread.projectId === normalizedCommand.projectId && thread.deletedAt === null,
                  )
                : normalizedCommand.includeChildren === true
                  ? collectThreadTree(snapshot.threads, normalizedCommand.threadId)
                  : snapshot.threads.filter(
                      (thread) =>
                        thread.id === normalizedCommand.threadId && thread.deletedAt === null,
                    );
          const result = yield* startup.enqueueCommand(
            orchestrationEngine.dispatch(normalizedCommand),
          );

          if (affectedThreads.length > 0) {
            yield* runThreadCleanupInBackground(affectedThreads);
          }

          return result;
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

      case WS_METHODS.projectsListTree: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceTree(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace tree: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsFileMetadata: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => readWorkspaceFileMetadata(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to inspect workspace file: ${String(cause)}`,
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
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
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
        recordWorkspaceFileWrite(body.cwd, target.relativePath);
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.projectsCreateDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => createWorkspaceDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to create workspace directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsRenameEntry: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => renameWorkspaceEntry(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to rename workspace entry: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsDeleteEntry: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => deleteWorkspaceEntry(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to delete workspace entry: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.serverUpdateProvider: {
        const body = stripRequestTag(request.body);
        const command = resolveProviderUpdateCommand(body);
        yield* broadcastProviderUpdateStatus(body.provider, "started", command);
        yield* Effect.gen(function* () {
          const exit = yield* launchCommand(command).pipe(Effect.exit);
          yield* refreshProviderUpdateState(body.provider);
          if (Exit.isSuccess(exit)) {
            yield* broadcastProviderUpdateStatus(body.provider, "finished", command);
            return;
          }
          yield* broadcastProviderUpdateStatus(
            body.provider,
            "failed",
            command,
            Cause.pretty(exit.cause),
          );
        }).pipe(Effect.forkIn(subscriptionsScope));
        return { command };
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitDiff: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.diff(body);
      }

      case WS_METHODS.gitFilePreview: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.filePreview(body);
      }

      case WS_METHODS.gitReviewAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.reviewAction(body);
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
        yield* fileSystem.makeDirectory(chatWorkspaceRoot, { recursive: true }).pipe(Effect.ignore);
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providerState = yield* getProviderStateSnapshot();
        const settings = yield* serverSettings.getSettings;
        return {
          cwd,
          homeDirectory,
          chatWorkspaceRoot,
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

      case WS_METHODS.computerUseListApps: {
        const settings = yield* serverSettings.getSettings;
        if (!settings.computerUse.enabled) {
          return {
            apps: [],
            status: {
              available: false,
              reason: "disabled",
              detail: "T3 Computer Use is disabled in settings.",
            },
          };
        }
        return yield* Effect.tryPromise({
          try: () => listComputerUseApps({ iconBaseUrl: `http://localhost:${port}` }),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list desktop apps for T3 Computer Use: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.computerUseGetSettings: {
        const settings = yield* serverSettings.getSettings;
        return settings.computerUse;
      }

      case WS_METHODS.computerUseUpdateSettings: {
        const body = stripRequestTag(request.body) as ComputerUseSettingsPatch;
        const settings = yield* serverSettings.updateSettings({ computerUse: body });
        return settings.computerUse;
      }

      case WS_METHODS.remoteAccessGetSnapshot:
        return yield* remoteAccessSnapshot();

      case WS_METHODS.remoteAccessCreatePairingLink: {
        const body = stripRequestTag(request.body);
        return yield* createRemotePairingLink(body);
      }

      case WS_METHODS.remoteAccessRevokePairingLink: {
        const body = stripRequestTag(request.body);
        yield* sql`
          UPDATE auth_pairing_links
          SET revoked_at = ${new Date().toISOString()}
          WHERE id = ${body.id}
            AND revoked_at IS NULL
            AND consumed_at IS NULL
        `;
        return yield* remoteAccessSnapshot();
      }

      case WS_METHODS.remoteAccessRevokeClient: {
        const body = stripRequestTag(request.body);
        yield* sql`
          UPDATE auth_sessions
          SET revoked_at = ${new Date().toISOString()}
          WHERE session_id = ${body.id}
            AND revoked_at IS NULL
        `;
        return yield* remoteAccessSnapshot();
      }

      case WS_METHODS.remoteAccessRevokeOtherClients: {
        const sessionIdToKeep = authContext.kind === "remote" ? authContext.sessionId : null;
        if (sessionIdToKeep) {
          yield* sql`
            UPDATE auth_sessions
            SET revoked_at = ${new Date().toISOString()}
            WHERE revoked_at IS NULL
              AND session_id <> ${sessionIdToKeep}
          `;
        } else {
          yield* sql`
            UPDATE auth_sessions
            SET revoked_at = ${new Date().toISOString()}
            WHERE revoked_at IS NULL
          `;
        }
        return yield* remoteAccessSnapshot();
      }

      case WS_METHODS.remoteAccessSetNetworkAccess: {
        const body = stripRequestTag(request.body);
        remoteNetworkAccessEnabled = body.enabled;
        yield* writeRemoteSetting("networkAccessEnabled", body.enabled ? "true" : "false");
        return yield* remoteAccessSnapshot();
      }

      case WS_METHODS.remoteAccessSetTailscaleHttps: {
        const body = stripRequestTag(request.body);
        if (body.enabled) {
          tailscaleHttpsUrl = yield* Effect.tryPromise({
            try: () => enableTailscaleServe({ localPort: port }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to enable Tailscale HTTPS: ${String(cause)}`,
              }),
          });
          tailscaleHttpsEnabled = true;
        } else {
          yield* Effect.tryPromise({
            try: () => disableTailscaleServe(),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to disable Tailscale HTTPS: ${String(cause)}`,
              }),
          });
          tailscaleHttpsEnabled = false;
          tailscaleHttpsUrl = null;
        }
        yield* Effect.all([
          writeRemoteSetting("tailscaleHttpsEnabled", tailscaleHttpsEnabled ? "true" : "false"),
          writeRemoteSetting("tailscaleHttpsUrl", tailscaleHttpsUrl ?? ""),
        ]);
        return yield* remoteAccessSnapshot();
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

      case WS_METHODS.providerPrewarmSession: {
        const body = stripRequestTag(request.body);
        return yield* providerService.prewarmSession(body);
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (
    ws: WebSocket,
    raw: unknown,
    authContext: RemoteAccessAuthContext,
  ) {
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

    const result = yield* Effect.exit(routeRequest(request.value, authContext));
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
      let hasRemoteWebSocketTicket = false;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
        hasRemoteWebSocketTicket =
          (url.searchParams.get(REMOTE_WEBSOCKET_TICKET_QUERY_PARAM)?.trim().length ?? 0) > 0;
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== null && providedToken === authToken) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
        return;
      }

      if (providedToken !== null && providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }

      if (!hasRemoteWebSocketTicket) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    void runPromise(
      Effect.gen(function* () {
        const authResult = yield* resolveRemoteAccessAuth(request);
        if (!authResult.ok) {
          ws.close(1008, authResult.failure.message);
          return;
        }
        const authContext = authResult.context;

        yield* Ref.update(clients, (connectedClients) => connectedClients.add(ws));

        const segments = cwd.split(/[/\\]/).filter(Boolean);
        const projectName = segments[segments.length - 1] ?? "project";

        const welcome: WsPush = {
          type: "push",
          channel: WS_CHANNELS.serverWelcome,
          data: {
            cwd,
            homeDirectory,
            projectName,
            ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
            ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
          },
        };
        logOutgoingPush(welcome, 1);
        ws.send(JSON.stringify(welcome));

        ws.on("message", (raw) => {
          void runPromise(
            handleMessage(ws, raw, authContext).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* errorInbox
                    .capture({
                      source: "server-internal",
                      category: "websocket",
                      severity: "error",
                      summary: "WebSocket message handler failed",
                      detail: error instanceof Error ? error.message : String(error),
                      context: {
                        error,
                      },
                    })
                    .pipe(Effect.catch(() => Effect.void));
                  yield* Effect.logError("Error handling message", error);
                }),
              ),
            ),
          );
        });

        ws.on("close", () => {
          void runPromise(
            Ref.update(clients, (connectedClients) => {
              connectedClients.delete(ws);
              return connectedClients;
            }),
          );
        });

        ws.on("error", () => {
          void runPromise(
            Ref.update(clients, (connectedClients) => {
              connectedClients.delete(ws);
              return connectedClients;
            }),
          );
        });
      }),
    );
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
