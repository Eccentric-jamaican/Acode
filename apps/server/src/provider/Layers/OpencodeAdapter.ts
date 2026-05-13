import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EventId,
  DEFAULT_SERVER_SETTINGS,
  OPENCODE_DEFAULT_MODEL_SLUG,
  type OpenCodeModelOptions,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderNativeCommandDescriptor,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CanonicalRequestType,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  normalizeModelSlug,
  normalizeOpenCodeModelOptions,
  parseOpencodeModelSlug,
} from "@t3tools/shared/model";
import { Data, Effect, FileSystem, Layer, Option, Queue, Ref, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { createLogger } from "../../logger.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildOpenCodeBasicAuthorizationHeader,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  getOpenCodeStartupMetadata,
} from "../opencodeRuntime.ts";
import { OpencodeMessageRoleGate } from "./OpencodeMessageRoleGate.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import {
  buildOpencodePromptAsyncBody,
  opencodeAgentForInteractionMode,
} from "./OpencodeTurnMapping.ts";
import { normalizeInvocationDiffFiles } from "./InvocationDiffNormalization.ts";
import { discoverSkillsForCwd } from "./SkillDiscovery.ts";
import { materializeSkillMentionsForProvider } from "./SkillPromptMaterialization.ts";

const PROVIDER = "opencode" as const;
// Match the slower end of observed OpenCode cold-start behavior on Windows so
// session startup does not race the server bootstrap.
const STARTUP_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 700;
const logger = createLogger("opencode");

export interface OpencodeAdapterLiveOptions {
  readonly host?: string;
  readonly port?: number;
  readonly createRuntime?: unknown;
}

type RuntimeFactoryResult = {
  readonly server: {
    readonly url: string;
    readonly close: () => void;
  };
  readonly client?: unknown;
};

type RuntimeFactory = (input: {
  readonly binaryPath: string;
  readonly serverUrl?: string | null;
  readonly hostname?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly workspaceCwd?: string;
  readonly stateDir?: string;
}) => Promise<RuntimeFactoryResult>;

type EventSubscriptionResult = {
  readonly stream: AsyncIterable<unknown>;
};

interface RuntimeHandle {
  readonly baseUrl: string;
  readonly serverPassword?: string;
  readonly client?: Record<string, unknown>;
  readonly usesInjectedClient: boolean;
  readonly close: () => void;
}

interface RuntimeSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  model: string;
  status: ProviderSession["status"];
  readonly createdAt: string;
  updatedAt: string;
  activeTurnId: TurnId | null;
}

interface OpencodeEvent {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
}

interface OpencodeSessionInfo {
  readonly id: string;
  readonly time?: { readonly created?: number; readonly updated?: number };
}

interface OpencodeMessage {
  readonly info?: { readonly id?: string; readonly role?: string };
  readonly parts?: ReadonlyArray<unknown>;
}

interface NormalizedOpenCodeQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: Array<{ label: string; description: string }>;
}

interface ParsedSlashInvocation {
  readonly name: string;
  readonly arguments: string;
}

class OpencodeRequestFailure extends Data.TaggedError("OpencodeRequestFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "question" || normalized === "askuserquestion";
}

function parseComputerUseTextBridge(output: string | undefined): {
  readonly output?: string;
  readonly structuredContent?: unknown;
} {
  if (!output) {
    return {};
  }
  const match = output.match(
    /(?:\r?\n){0,2}<t3_computer_result>([\s\S]*?)<\/t3_computer_result>\s*$/u,
  );
  if (!match?.[1]) {
    return { output };
  }
  try {
    return {
      output: output.slice(0, match.index).trimEnd(),
      structuredContent: JSON.parse(match[1]) as unknown,
    };
  } catch {
    return { output };
  }
}

function sanitizeAttachmentSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "unknown";
}

function attachmentRelativePathFromUrl(url: string): string | null {
  if (!url.startsWith("/attachments/")) {
    return null;
  }
  return url
    .slice("/attachments/".length)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function resolveAttachmentPathFromCapture(input: {
  readonly stateDir: string;
  readonly capture: Record<string, unknown>;
}): string | null {
  const attachmentsRoot = NodePath.resolve(NodePath.join(input.stateDir, "attachments"));
  const explicitPath = asString(input.capture.path);
  if (explicitPath) {
    const resolved = NodePath.resolve(explicitPath);
    if (resolved === attachmentsRoot || resolved.startsWith(`${attachmentsRoot}${NodePath.sep}`)) {
      return resolved;
    }
  }

  const url = asString(input.capture.url);
  const relativePath = url ? attachmentRelativePathFromUrl(url) : null;
  if (!relativePath) {
    return null;
  }
  const resolved = NodePath.resolve(NodePath.join(attachmentsRoot, relativePath));
  if (!resolved.startsWith(`${attachmentsRoot}${NodePath.sep}`)) {
    return null;
  }
  return resolved;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFS.access(path);
    return true;
  } catch {
    return false;
  }
}

async function moveFileIfPresent(sourcePath: string, destinationPath: string): Promise<void> {
  if (sourcePath === destinationPath || (await pathExists(destinationPath))) {
    return;
  }
  if (!(await pathExists(sourcePath))) {
    return;
  }
  await NodeFS.mkdir(NodePath.dirname(destinationPath), { recursive: true });
  try {
    await NodeFS.rename(sourcePath, destinationPath);
  } catch {
    await NodeFS.copyFile(sourcePath, destinationPath);
    await NodeFS.unlink(sourcePath).catch(() => undefined);
  }
}

async function normalizeOpenCodeComputerCaptureStorage(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly structuredContent: unknown;
}): Promise<unknown> {
  const record = asObject(input.structuredContent);
  if (!record || !Array.isArray(record.captures)) {
    return input.structuredContent;
  }

  const attachmentsRoot = NodePath.resolve(NodePath.join(input.stateDir, "attachments"));
  const threadSegment = sanitizeAttachmentSegment(input.threadId);
  const captures = await Promise.all(
    record.captures.map(async (captureValue) => {
      const capture = asObject(captureValue);
      if (!capture) {
        return captureValue;
      }
      const captureId =
        asString(capture.captureId) ||
        NodePath.basename(asString(capture.path) ?? asString(capture.url) ?? "", ".png") ||
        randomUUID();
      const destinationRelativePath = NodePath.posix.join(
        "computer-use",
        threadSegment,
        "captures",
        `${sanitizeAttachmentSegment(captureId)}.png`,
      );
      const destinationPath = NodePath.join(
        attachmentsRoot,
        ...destinationRelativePath.split("/"),
      );
      const sourcePath = resolveAttachmentPathFromCapture({
        stateDir: input.stateDir,
        capture,
      });
      if (sourcePath) {
        await moveFileIfPresent(sourcePath, destinationPath);
      }
      return {
        ...capture,
        captureId,
        url: `/attachments/${destinationRelativePath}`,
        path: destinationPath,
      };
    }),
  );

  return { ...record, captures };
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

function causeCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const value = cause as { code?: unknown; cause?: unknown };
  if (typeof value.code === "string" && value.code.length > 0) {
    return value.code;
  }
  return causeCode(value.cause);
}

function isConnectionRefused(cause: unknown): boolean {
  const code = causeCode(cause);
  if (code === "ECONNREFUSED") {
    return true;
  }
  const message = toMessage(cause, "").toLowerCase();
  return message.includes("econnrefused") || message.includes("connect refused");
}

function readResumeCursor(value: unknown): { sessionId: string; directory?: string } | undefined {
  if (typeof value === "string" && value.trim()) return { sessionId: value.trim() };
  const record = asObject(value);
  if (!record) return undefined;
  const sessionId = asString(record.sessionId) ?? asString(record.sessionID) ?? asString(record.id);
  if (!sessionId || !sessionId.trim()) return undefined;
  const directory = asString(record.directory)?.trim();
  return { sessionId: sessionId.trim(), ...(directory ? { directory } : {}) };
}

function requestTypeFromPermission(value: string | undefined): CanonicalRequestType {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("read")) return "file_read_approval";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change_approval";
  }
  if (
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("exec")
  ) {
    return "command_execution_approval";
  }
  return "unknown";
}

function streamKindFromPartType(
  partType: string | undefined,
): "assistant_text" | "reasoning_text" | "unknown" {
  switch (partType?.toLowerCase()) {
    case "text":
      return "assistant_text";
    case "reasoning":
      return "reasoning_text";
    default:
      return "unknown";
  }
}

function canonicalItemTypeFromToolName(
  value: string | undefined,
):
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "image_view"
  | "dynamic_tool_call" {
  const normalized = value?.toLowerCase() ?? "";
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("websearch") || normalized.includes("web search")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function decisionFromPermissionReply(
  value: string | undefined,
): "accept" | "acceptForSession" | "decline" | "cancel" | undefined {
  const normalized = value?.toLowerCase().trim();
  switch (normalized) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
      return "decline";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

function isPendingPermissionStatus(status: string): boolean {
  return status === "pending" || status === "open" || status === "requested";
}

function extractAssistantTextFromParts(partsValue: unknown): string {
  const parts = asArray(partsValue) ?? [];
  const text = parts
    .map((partValue) => {
      const part = asObject(partValue);
      if (!part) return "";
      if (asString(part.type) !== "text") return "";
      return asString(part.text) ?? asString(asObject(part.content)?.text) ?? "";
    })
    .filter((chunk) => chunk.length > 0)
    .join("");
  return text.trim();
}

function parseLeadingSlashInvocation(input: string): ParsedSlashInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const body = trimmed.slice(1).trimStart();
  if (body.length === 0) {
    return { name: "", arguments: "" };
  }
  const firstWhitespaceIndex = body.search(/\s/);
  if (firstWhitespaceIndex === -1) {
    return { name: body, arguments: "" };
  }
  return {
    name: body.slice(0, firstWhitespaceIndex).trim(),
    arguments: body.slice(firstWhitespaceIndex + 1).trim(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asObject(value);
  if (!record) {
    throw new Error("Injected OpenCode runtime returned an invalid client shape.");
  }
  return record;
}

function asFunction(
  record: Record<string, unknown>,
  key: string,
): (...args: ReadonlyArray<unknown>) => Promise<unknown> {
  const value = record[key];
  if (typeof value !== "function") {
    throw new Error(`Injected OpenCode runtime client is missing '${key}' function.`);
  }
  return value.bind(record) as (...args: ReadonlyArray<unknown>) => Promise<unknown>;
}

function decodePathSegment(path: string, index: number): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const value = segments[index];
  if (!value) {
    throw new Error(`Cannot parse OpenCode path segment at index ${index} from '${path}'.`);
  }
  return decodeURIComponent(value);
}

function asAsyncIterable(value: unknown): AsyncIterable<unknown> {
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  ) {
    return value as AsyncIterable<unknown>;
  }
  throw new Error("Injected OpenCode runtime returned an invalid event stream.");
}

function asEventSubscriptionResult(value: unknown): EventSubscriptionResult {
  const record = asRecord(value);
  return {
    stream: asAsyncIterable(record.stream),
  };
}

function eventBase(input: {
  readonly threadId: ThreadId;
  readonly type: ProviderRuntimeEvent["type"];
  readonly payload: unknown;
  readonly method: string;
  readonly rawPayload: unknown;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
}): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    raw: { source: "opencode.sdk.event", method: input.method, payload: input.rawPayload },
    type: input.type,
    payload: input.payload,
  } as ProviderRuntimeEvent;
}

const makeOpencodeAdapter = (options?: OpencodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettings = Option.getOrUndefined(
      yield* Effect.serviceOption(ServerSettingsService),
    ) ?? {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    };
    const services = yield* Effect.services<never>();
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeRef = yield* Ref.make<RuntimeHandle | null>(null);
    const runtimeFactory =
      typeof options?.createRuntime === "function"
        ? (options.createRuntime as RuntimeFactory)
        : undefined;

    const sessions = new Map<ThreadId, RuntimeSession>();
    const commandCacheByCwd = new Map<string, ProviderListCommandsResult>();
    const pendingCommandDiscoveryByCwd = new Map<string, Promise<ProviderListCommandsResult>>();
    const threadBySessionId = new Map<string, ThreadId>();
    const permissionTypeByRequest = new Map<string, CanonicalRequestType>();
    const questionIdsByRequest = new Map<string, ReadonlyArray<string>>();
    const partMetadataById = new Map<
      string,
      {
        sessionId: string;
        messageId: string;
        streamKind: "assistant_text" | "reasoning_text" | "unknown";
        text: string;
      }
    >();
    const toolPartStatusById = new Map<
      string,
      {
        sessionId: string;
        messageId: string;
        status: "pending" | "running" | "completed" | "error";
      }
    >();
    const messageRoleGate = new OpencodeMessageRoleGate();
    const completedAssistantMessageSessionById = new Map<string, string>();
    const controllersByDirectory = new Map<string, AbortController>();

    const emit = (event: ProviderRuntimeEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
    const runWithServices = Effect.runPromiseWith(services);
    const emitAsync = (event: ProviderRuntimeEvent) =>
      emit(event)
        .pipe(runWithServices)
        .catch(() => undefined);
    const resolveMessageRole = async (input: {
      readonly threadId: ThreadId;
      readonly sessionId: string;
      readonly messageId: string;
      readonly directory: string;
      readonly roleHint?: string | undefined;
    }): Promise<string | undefined> => {
      return messageRoleGate.resolve({
        sessionId: input.sessionId,
        messageId: input.messageId,
        ...(input.roleHint !== undefined ? { roleHint: input.roleHint } : {}),
        fetchRole: async () => {
          const fullMessage = await requestJson<unknown>({
            threadId: input.threadId,
            methodName: "session.message",
            httpMethod: "GET",
            path: `/session/${encodeURIComponent(input.sessionId)}/message/${encodeURIComponent(input.messageId)}`,
            directory: input.directory,
            body: undefined,
          })
            .pipe(Effect.option, runWithServices)
            .catch(() => undefined);
          return asString(asObject(asObject(fullMessage)?.info)?.role);
        },
      });
    };

    const processError = (threadId: ThreadId, detail: string, cause?: unknown) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail,
        ...(cause !== undefined ? { cause } : {}),
      });

    const requestError = (threadId: ThreadId, method: string, detail: string, cause?: unknown) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail,
        ...(cause !== undefined ? { cause } : {}),
      });

    const releaseDirectoryStreamIfUnused = (directory: string) => {
      const stillUsed = Array.from(sessions.values()).some((session) => session.cwd === directory);
      if (stillUsed) {
        return;
      }
      const controller = controllersByDirectory.get(directory);
      if (controller) {
        controller.abort();
      }
      controllersByDirectory.delete(directory);
    };

    const clearRuntimeIfMatches = (runtimeToClear: RuntimeHandle) =>
      Ref.update(runtimeRef, (runtime) => (runtime === runtimeToClear ? null : runtime));

    const closeRuntime = (runtime: RuntimeHandle) =>
      Effect.sync(() => {
        runtime.close();
      });

    const ensureRuntime = (
      threadId: ThreadId,
    ): Effect.Effect<RuntimeHandle, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(runtimeRef);
        if (existing) return existing;

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map((value) => value.providers.opencode),
          Effect.mapError((cause) =>
            processError(threadId, toMessage(cause, "Failed to read OpenCode settings."), cause),
          ),
        );
        const serverPassword =
          settings.serverPassword.trim().length > 0 ? settings.serverPassword.trim() : undefined;
        const runtimeStartupStartedAt = Date.now();

        const runtimeFromSdk = yield* Effect.tryPromise({
          try: async () => {
            if (runtimeFactory) {
              return runtimeFactory({
                binaryPath: settings.binaryPath,
                serverUrl: settings.serverUrl,
                ...(options?.host ? { hostname: options.host } : {}),
                ...(options?.port ? { port: options.port } : {}),
                timeoutMs: STARTUP_TIMEOUT_MS,
                workspaceCwd: serverConfig.cwd,
                stateDir: serverConfig.stateDir,
              });
            }
            const server = await connectToOpenCodeServer({
              binaryPath: settings.binaryPath,
              serverUrl: settings.serverUrl,
              ...(options?.host ? { hostname: options.host } : {}),
              ...(options?.port ? { port: options.port } : {}),
              timeoutMs: STARTUP_TIMEOUT_MS,
              workspaceCwd: serverConfig.cwd,
              stateDir: serverConfig.stateDir,
            });
            logger.info("OpenCode runtime connected", {
              threadId,
              binaryPath: settings.binaryPath,
              configuredServerUrl: settings.serverUrl,
              startupDurationMs: Date.now() - runtimeStartupStartedAt,
              runtimeUrl: server.url,
            });
            return { server };
          },
          catch: (cause) => {
            const startupMetadata = getOpenCodeStartupMetadata(cause);
            logger.warn("OpenCode runtime startup failed", {
              threadId,
              binaryPath: settings.binaryPath,
              configuredServerUrl: settings.serverUrl,
              startupDurationMs:
                startupMetadata?.startupDurationMs ?? Date.now() - runtimeStartupStartedAt,
              reason: toMessage(cause, "Failed to connect to OpenCode runtime."),
              ...(startupMetadata?.hostname ? { hostname: startupMetadata.hostname } : {}),
              ...(startupMetadata?.port ? { port: startupMetadata.port } : {}),
              ...(startupMetadata?.stdout ? { stdout: startupMetadata.stdout } : {}),
              ...(startupMetadata?.stderr ? { stderr: startupMetadata.stderr } : {}),
            });
            return processError(
              threadId,
              toMessage(cause, "Failed to connect to OpenCode runtime."),
              cause,
            );
          },
        });

        const runtime: RuntimeHandle = {
          baseUrl: runtimeFromSdk.server.url,
          ...(serverPassword ? { serverPassword } : {}),
          ...(asObject(runtimeFromSdk)?.client
            ? { client: asRecord(asObject(runtimeFromSdk)?.client) }
            : {}),
          usesInjectedClient: runtimeFactory !== undefined,
          close: runtimeFromSdk.server.close,
        };
        yield* Ref.set(runtimeRef, runtime);
        return runtime;
      });

    const requestJson = <T>(input: {
      readonly threadId: ThreadId;
      readonly methodName: string;
      readonly httpMethod: "GET" | "POST";
      readonly path: string;
      readonly directory: string | undefined;
      readonly body: unknown;
    }): Effect.Effect<T, ProviderAdapterProcessError | ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const executeRequest = (runtime: RuntimeHandle) =>
          Effect.tryPromise({
            try: async () => {
              if (runtime.client) {
                const client = runtime.client;
                const bodyRecord = asObject(input.body) ?? {};
                const command = asRecord(client.command);
                const session = asRecord(client.session);
                const provider = asObject(client.provider);

                switch (input.methodName) {
                  case "command.list":
                    return (await asFunction(
                      command,
                      "list",
                    )({
                      ...(input.directory ? { directory: input.directory } : {}),
                    })) as T;
                  case "provider.list":
                    if (!provider) {
                      throw new Error("Injected OpenCode runtime client is missing provider API.");
                    }
                    return (await asFunction(provider, "list")()) as T;
                  case "session.create":
                    return (await asFunction(
                      session,
                      "create",
                    )({
                      body: bodyRecord,
                    })) as T;
                  case "session.get": {
                    const sessionID = decodePathSegment(input.path, 1);
                    return (await asFunction(
                      session,
                      "retrieve",
                    )({
                      path: { sessionID },
                    })) as T;
                  }
                  case "session.command": {
                    const id = decodePathSegment(input.path, 1);
                    return (await asFunction(
                      session,
                      "command",
                    )({
                      path: { id, sessionID: id },
                      body: bodyRecord,
                    })) as T;
                  }
                  case "session.prompt_async": {
                    const id = decodePathSegment(input.path, 1);
                    return (await asFunction(
                      session,
                      "promptAsync",
                    )({
                      path: { id, sessionID: id },
                      body: bodyRecord,
                    })) as T;
                  }
                  case "session.abort": {
                    const id = decodePathSegment(input.path, 1);
                    return (await asFunction(
                      session,
                      "abort",
                    )({
                      path: { id, sessionID: id },
                    })) as T;
                  }
                  default:
                    throw new Error(
                      `Injected OpenCode runtime does not support '${input.methodName}'.`,
                    );
                }
              }

              const bodyRecord = asObject(input.body);
              const url = new URL(input.path, runtime.baseUrl);
              if (input.directory) {
                url.searchParams.set("directory", input.directory);
              }
              const response = await fetch(url, {
                method: input.httpMethod,
                headers: {
                  Accept: "application/json",
                  ...(input.httpMethod === "POST" ? { "Content-Type": "application/json" } : {}),
                  ...(runtime.serverPassword
                    ? {
                        Authorization: buildOpenCodeBasicAuthorizationHeader(
                          runtime.serverPassword,
                        ),
                      }
                    : {}),
                },
                ...(input.httpMethod === "POST" ? { body: JSON.stringify(bodyRecord ?? {}) } : {}),
              });
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
              }
              if (response.status === 204) {
                return undefined as T;
              }
              const text = await response.text();
              if (text.trim().length === 0) {
                return undefined as T;
              }
              const parsed = JSON.parse(text) as { data?: unknown };
              return (
                parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed
              ) as T;
            },
            catch: (cause) =>
              new OpencodeRequestFailure({
                message: toMessage(cause, "OpenCode request failed."),
                cause,
              }),
          });

        const runtime = yield* ensureRuntime(input.threadId);
        const result = yield* executeRequest(runtime).pipe(
          Effect.catchIf(
            (error) => isConnectionRefused(error.cause),
            () =>
              Effect.gen(function* () {
                yield* clearRuntimeIfMatches(runtime);
                yield* closeRuntime(runtime);
                const restarted = yield* ensureRuntime(input.threadId);
                return yield* executeRequest(restarted);
              }),
          ),
          Effect.mapError((error) =>
            requestError(
              input.threadId,
              input.methodName,
              error.message || `${input.methodName} failed.`,
              error.cause,
            ),
          ),
        );
        return result;
      });

    const generatedQuestionId = (index: number, question: Record<string, unknown>) => {
      const header = (asString(question.header) ?? asString(question.title) ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-");
      return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
    };

    const toQuestionPayload = (
      rawQuestion: unknown,
    ): ReadonlyArray<NormalizedOpenCodeQuestion> | undefined => {
      const record = asObject(rawQuestion);
      if (!record) return undefined;
      const list = asArray(record.questions);
      const questions = (list ?? [record])
        .map((entry, index) => {
          const question = asObject(entry);
          if (!question) return undefined;
          const id = asString(question.id)?.trim() || generatedQuestionId(index, question);
          const header = asString(question.header)?.trim() ?? asString(question.title)?.trim();
          const questionText =
            asString(question.question)?.trim() ?? asString(question.prompt)?.trim();
          const options = (asArray(question.options) ?? [])
            .map((optionValue) => {
              if (typeof optionValue === "string") {
                const label = optionValue.trim();
                return label.length > 0 ? { label, description: label } : undefined;
              }
              const option = asObject(optionValue);
              if (!option) return undefined;
              const label = asString(option.label)?.trim();
              const description =
                asString(option.description)?.trim() ??
                asString(option.detail)?.trim() ??
                asString(option.value)?.trim() ??
                label;
              if (!label || !description) return undefined;
              return { label, description };
            })
            .filter(
              (option): option is { label: string; description: string } => option !== undefined,
            );
          if (!id || !header || !questionText || options.length === 0) {
            return undefined;
          }
          return { id, header, question: questionText, options };
        })
        .filter((question): question is NormalizedOpenCodeQuestion => question !== undefined);
      return questions.length > 0 ? questions : undefined;
    };

    const emitQuestionRequested = async (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | undefined;
      readonly requestId: string;
      readonly questions: ReadonlyArray<NormalizedOpenCodeQuestion>;
      readonly method: string;
      readonly rawPayload: unknown;
    }) => {
      questionIdsByRequest.set(
        input.requestId,
        input.questions.map((question) => question.id),
      );
      await emitAsync(
        eventBase({
          threadId: input.threadId,
          type: "user-input.requested",
          payload: { questions: input.questions },
          method: input.method,
          rawPayload: input.rawPayload,
          turnId: input.turnId,
          requestId: input.requestId,
        }),
      );
    };

    const handleSseEvent = async (event: OpencodeEvent): Promise<void> => {
      const properties = asObject(event.properties) ?? {};
      const sessionId =
        asString(properties.sessionID) ??
        asString(properties.sessionId) ??
        asString(asObject(properties.session)?.id);
      if (!sessionId) {
        return;
      }
      const threadId = threadBySessionId.get(sessionId);
      if (!threadId) {
        return;
      }
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      const turnId = session.activeTurnId ?? undefined;

      if (event.type === "session.status") {
        const statusRecord = asObject(properties.status) ?? properties;
        const statusType = asString(statusRecord.type)?.toLowerCase() ?? "";
        if (statusType === "busy" || statusType === "running") {
          session.status = "running";
          session.updatedAt = nowIso();
          await emitAsync(
            eventBase({
              threadId,
              type: "session.state.changed",
              payload: { state: "running" },
              method: event.type,
              rawPayload: event,
              turnId,
            }),
          );
          return;
        }
        if (statusType === "idle" || statusType === "ready") {
          const completedTurnId = session.activeTurnId;
          session.activeTurnId = null;
          session.status = "ready";
          session.updatedAt = nowIso();
          if (completedTurnId) {
            await emitAsync(
              eventBase({
                threadId,
                type: "turn.completed",
                payload: { state: "completed" } satisfies TurnCompletedPayload,
                method: event.type,
                rawPayload: event,
                turnId: completedTurnId,
              }),
            );
          }
          await emitAsync(
            eventBase({
              threadId,
              type: "session.state.changed",
              payload: { state: "ready" },
              method: event.type,
              rawPayload: event,
            }),
          );
          return;
        }
        if (statusType === "error") {
          const reason = asString(statusRecord.message) ?? "OpenCode runtime reported an error.";
          const failedTurnId = session.activeTurnId;
          session.activeTurnId = null;
          session.status = "error";
          session.updatedAt = nowIso();
          if (failedTurnId) {
            await emitAsync(
              eventBase({
                threadId,
                type: "turn.completed",
                payload: { state: "failed", errorMessage: reason } satisfies TurnCompletedPayload,
                method: event.type,
                rawPayload: event,
                turnId: failedTurnId,
              }),
            );
          }
          await emitAsync(
            eventBase({
              threadId,
              type: "session.state.changed",
              payload: { state: "error", reason },
              method: event.type,
              rawPayload: event,
            }),
          );
          await emitAsync(
            eventBase({
              threadId,
              type: "runtime.error",
              payload: { message: reason, class: "provider_error" },
              method: event.type,
              rawPayload: event,
            }),
          );
          return;
        }
      }

      if (event.type === "message.part.updated") {
        const part = asObject(properties.part) ?? properties;
        const partId = asString(part.id);
        const messageId = asString(part.messageID) ?? asString(properties.messageID);
        if (!partId || !messageId) {
          return;
        }
        const role = await resolveMessageRole({
          threadId,
          sessionId,
          messageId,
          directory: session.cwd,
          roleHint:
            asString(part.role) ??
            asString(properties.role) ??
            asString(properties.messageRole) ??
            asString(asObject(properties.message)?.role) ??
            asString(asObject(properties.info)?.role),
        });
        if (role !== "assistant") {
          return;
        }
        if (part["ignored"] === true || asObject(part["content"])?.["ignored"] === true) {
          return;
        }

        const partType = asString(part.type)?.toLowerCase();
        if (partType === "tool") {
          const toolName = asString(part.tool) ?? "tool";
          const state = asObject(part.state);
          const statusValue = asString(state?.status)?.toLowerCase();
          const status =
            statusValue === "pending" ||
            statusValue === "running" ||
            statusValue === "completed" ||
            statusValue === "error"
              ? statusValue
              : "running";
          const itemId = asString(part.callID) ?? partId;
          const input = asObject(state?.input) ?? {};
          const metadata = asObject(state?.metadata) ?? asObject(part.metadata) ?? {};
          const output = asString(state?.output);
          const parsedOutput = parseComputerUseTextBridge(output);
          const structuredContent =
            parsedOutput.structuredContent !== undefined
              ? await normalizeOpenCodeComputerCaptureStorage({
                  stateDir: serverConfig.stateDir,
                  threadId,
                  structuredContent: parsedOutput.structuredContent,
                })
              : undefined;
          if (isQuestionToolName(toolName)) {
            const questions = toQuestionPayload(input);
            if (questions && (status === "pending" || status === "running")) {
              await emitQuestionRequested({
                threadId,
                method: event.type,
                rawPayload: event,
                turnId,
                requestId: itemId,
                questions,
              });
              toolPartStatusById.set(partId, { sessionId, messageId, status });
              return;
            }
          }
          const data: Record<string, unknown> = {
            toolName,
            input,
            metadata,
            ...(parsedOutput.output ? { output: parsedOutput.output } : {}),
            ...(structuredContent ? { structuredContent } : {}),
          };
          const diffFiles = normalizeInvocationDiffFiles(data);
          if (diffFiles.length > 0) {
            data.diff = { files: diffFiles };
          }
          const itemType = canonicalItemTypeFromToolName(toolName);
          const title = asString(state?.title) ?? toolName;
          const previous = toolPartStatusById.get(partId);
          const shouldEmitStarted =
            !previous || (previous.sessionId === sessionId && previous.status !== status);

          if (shouldEmitStarted && (status === "pending" || status === "running")) {
            await emitAsync(
              eventBase({
                threadId,
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title,
                  data,
                },
                method: event.type,
                rawPayload: event,
                turnId,
                itemId,
              }),
            );
          }

          if (status === "pending" || status === "running") {
            await emitAsync(
              eventBase({
                threadId,
                type: "item.updated",
                payload: {
                  itemType,
                  status: "inProgress",
                  title,
                  data,
                },
                method: event.type,
                rawPayload: event,
                turnId,
                itemId,
              }),
            );
          } else {
            await emitAsync(
              eventBase({
                threadId,
                type: "item.completed",
                payload: {
                  itemType,
                  status: status === "completed" ? "completed" : "failed",
                  title,
                  data,
                },
                method: event.type,
                rawPayload: event,
                turnId,
                itemId,
              }),
            );
          }

          toolPartStatusById.set(partId, { sessionId, messageId, status });
          return;
        }

        const streamKind = streamKindFromPartType(asString(part.type));
        const nextText = asString(part.text) ?? asString(asObject(part.content)?.text) ?? "";
        const previous = partMetadataById.get(partId);
        partMetadataById.set(partId, { sessionId, messageId, streamKind, text: nextText });

        if (nextText.length > 0) {
          const delta =
            previous && previous.messageId === messageId && nextText.startsWith(previous.text)
              ? nextText.slice(previous.text.length)
              : nextText;
          if (delta.length > 0) {
            await emitAsync(
              eventBase({
                threadId,
                type: "content.delta",
                payload: {
                  streamKind,
                  delta,
                },
                method: event.type,
                rawPayload: event,
                turnId,
                itemId: messageId,
              }),
            );
          }
        }
        return;
      }

      if (event.type === "message.part.delta") {
        const messageId =
          asString(properties.messageID) ?? asString(asObject(properties.part)?.messageID);
        const partId = asString(properties.partID) ?? asString(asObject(properties.part)?.id);
        const delta = asString(properties.delta);
        if (!messageId || !delta) {
          return;
        }
        const role = await resolveMessageRole({
          threadId,
          sessionId,
          messageId,
          directory: session.cwd,
          roleHint:
            asString(properties.role) ??
            asString(properties.messageRole) ??
            asString(asObject(properties.message)?.role) ??
            asString(asObject(properties.info)?.role),
        });
        if (role !== "assistant") {
          return;
        }

        let streamKind: "assistant_text" | "reasoning_text" | "unknown" = "unknown";
        if (partId) {
          const previous = partMetadataById.get(partId);
          if (previous?.sessionId !== sessionId) {
            return;
          }
          if (previous) {
            streamKind = previous.streamKind;
            partMetadataById.set(partId, {
              ...previous,
              sessionId,
              messageId,
              text: `${previous.text}${delta}`,
            });
          } else {
            streamKind =
              asString(properties.field)?.toLowerCase() === "text" ? "assistant_text" : "unknown";
            partMetadataById.set(partId, { sessionId, messageId, streamKind, text: delta });
          }
        }

        await emitAsync(
          eventBase({
            threadId,
            type: "content.delta",
            payload: {
              streamKind,
              delta,
            },
            method: event.type,
            rawPayload: event,
            turnId,
            itemId: messageId,
          }),
        );
        return;
      }

      if (event.type === "message.updated" || event.type === "message.completed") {
        const message = asObject(properties.info) ?? asObject(properties.message) ?? properties;
        const messageId = asString(message.id);
        const role = asString(message.role)?.toLowerCase();
        const completedAt = asObject(message.time)?.completed;
        if (messageId) {
          messageRoleGate.remember(sessionId, messageId, role);
        }
        if (!messageId || role !== "assistant") {
          return;
        }
        if (completedAssistantMessageSessionById.has(messageId)) {
          return;
        }
        if (event.type === "message.completed" || typeof completedAt === "number") {
          const hasStreamedAssistantText = Array.from(partMetadataById.values()).some(
            (entry) =>
              entry.messageId === messageId &&
              entry.streamKind === "assistant_text" &&
              entry.text.length > 0,
          );
          if (!hasStreamedAssistantText) {
            const fullMessage = await requestJson<unknown>({
              threadId,
              methodName: "session.message",
              httpMethod: "GET",
              path: `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
              directory: session.cwd,
              body: undefined,
            })
              .pipe(Effect.option, runWithServices)
              .catch(() => undefined);
            const fallbackText = extractAssistantTextFromParts(asObject(fullMessage)?.parts);
            if (fallbackText.length > 0) {
              await emitAsync(
                eventBase({
                  threadId,
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta: fallbackText,
                  },
                  method: event.type,
                  rawPayload: event,
                  turnId,
                  itemId: messageId,
                }),
              );
            }
          }

          await emitAsync(
            eventBase({
              threadId,
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
              },
              method: event.type,
              rawPayload: event,
              turnId,
              itemId: messageId,
            }),
          );
          completedAssistantMessageSessionById.set(messageId, sessionId);
        }
        return;
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        const permission = asObject(properties.permission) ?? properties;
        const requestId = asString(permission.id) ?? asString(permission.requestID);
        if (!requestId) {
          return;
        }
        const requestType = requestTypeFromPermission(
          asString(permission.permission) ?? asString(permission.type) ?? asString(permission.kind),
        );

        const status = asString(permission.status)?.toLowerCase() ?? "";
        if (event.type === "permission.asked" || isPendingPermissionStatus(status)) {
          permissionTypeByRequest.set(requestId, requestType);
          const session = sessions.get(threadId);
          if (session?.runtimeMode === "full-access") {
            try {
              await requestJson<void>({
                threadId,
                methodName: "permission.reply",
                httpMethod: "POST",
                path: `/permission/${encodeURIComponent(requestId)}/reply`,
                directory: session.cwd,
                body: { reply: "always" },
              }).pipe(runWithServices);
              return;
            } catch (cause) {
              await emitAsync(
                eventBase({
                  threadId,
                  type: "runtime.warning",
                  payload: {
                    message: toMessage(
                      cause,
                      "Failed to auto-approve OpenCode permission request in full-access mode.",
                    ),
                    detail: {
                      requestId,
                      requestType,
                      runtimeMode: session.runtimeMode,
                    },
                  },
                  method: "permission.reply",
                  rawPayload: {
                    requestId,
                    requestType,
                    reply: "always",
                    error: toMessage(cause, "OpenCode permission auto-approval failed."),
                  },
                  turnId,
                }),
              );
            }
          }
          await emitAsync(
            eventBase({
              threadId,
              type: "request.opened",
              payload: { requestType, args: permission },
              method: event.type,
              rawPayload: event,
              turnId,
              requestId,
            }),
          );
          return;
        }

        const decision =
          status === "approved" || status === "accepted" || status === "granted"
            ? "accept"
            : status === "cancelled"
              ? "cancel"
              : status === "rejected" || status === "denied"
                ? "decline"
                : undefined;
        if (!decision) {
          return;
        }
        await emitAsync(
          eventBase({
            threadId,
            type: "request.resolved",
            payload: {
              requestType: permissionTypeByRequest.get(requestId) ?? requestType,
              decision,
              resolution: permission,
            },
            method: event.type,
            rawPayload: event,
            turnId,
            requestId,
          }),
        );
        permissionTypeByRequest.delete(requestId);
        return;
      }

      if (event.type === "permission.replied") {
        const requestId = asString(properties.requestID) ?? asString(properties.requestId);
        if (!requestId) {
          return;
        }
        const requestType = permissionTypeByRequest.get(requestId) ?? "unknown";
        const decision = decisionFromPermissionReply(
          asString(properties.reply) ?? asString(properties.response),
        );
        await emitAsync(
          eventBase({
            threadId,
            type: "request.resolved",
            payload: {
              requestType,
              ...(decision ? { decision } : {}),
              resolution: properties,
            },
            method: event.type,
            rawPayload: event,
            turnId,
            requestId,
          }),
        );
        permissionTypeByRequest.delete(requestId);
        return;
      }

      if (event.type === "question.asked" || event.type === "question.updated") {
        const questionRecord = asObject(properties.question) ?? properties;
        const requestId =
          asString(questionRecord.id) ??
          asString(questionRecord.questionID) ??
          asString(properties.questionID);
        if (!requestId) {
          return;
        }

        if (event.type === "question.asked") {
          const questions = toQuestionPayload(questionRecord);
          if (!questions) {
            return;
          }
          await emitQuestionRequested({
            threadId,
            method: event.type,
            rawPayload: event,
            turnId,
            requestId,
            questions,
          });
          return;
        }

        const status = asString(questionRecord.status)?.toLowerCase() ?? "";
        if (status === "pending" || status === "open" || status === "requested") {
          const questions = toQuestionPayload(questionRecord);
          if (!questions) return;
          await emitQuestionRequested({
            threadId,
            method: event.type,
            rawPayload: event,
            turnId,
            requestId,
            questions,
          });
          return;
        }
        if (
          status === "answered" ||
          status === "resolved" ||
          status === "completed" ||
          status === "closed"
        ) {
          const answers = asObject(questionRecord.answers) ?? asObject(properties.answers) ?? {};
          await emitAsync(
            eventBase({
              threadId,
              type: "user-input.resolved",
              payload: { answers },
              method: event.type,
              rawPayload: event,
              turnId,
              requestId,
            }),
          );
          questionIdsByRequest.delete(requestId);
          return;
        }
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = asString(properties.requestID) ?? asString(properties.requestId);
        if (!requestId) {
          return;
        }
        const questionIds = questionIdsByRequest.get(requestId) ?? [];
        const answerGroups = asArray(properties.answers) ?? [];
        const answers: Record<string, unknown> = {};

        if (event.type === "question.replied") {
          if (questionIds.length > 0) {
            questionIds.forEach((questionId, index) => {
              const group = asArray(answerGroups[index]) ?? [];
              const values = group.filter((entry): entry is string => typeof entry === "string");
              if (values.length === 1) {
                answers[questionId] = values[0];
              } else if (values.length > 1) {
                answers[questionId] = values;
              }
            });
          } else {
            answerGroups.forEach((groupValue, index) => {
              const group = asArray(groupValue) ?? [];
              const values = group.filter((entry): entry is string => typeof entry === "string");
              if (values.length > 0) {
                answers[`question-${index + 1}`] = values.length === 1 ? values[0] : values;
              }
            });
          }
        }

        await emitAsync(
          eventBase({
            threadId,
            type: "user-input.resolved",
            payload: { answers },
            method: event.type,
            rawPayload: event,
            turnId,
            requestId,
          }),
        );
        questionIdsByRequest.delete(requestId);
        return;
      }

      if (event.type.toLowerCase().includes("error")) {
        const message =
          asString(asObject(properties.error)?.message) ??
          asString(properties.message) ??
          "OpenCode runtime error";
        await emitAsync(
          eventBase({
            threadId,
            type: "runtime.error",
            payload: { message, class: "provider_error", detail: properties },
            method: event.type,
            rawPayload: event,
            turnId,
          }),
        );
      }
    };

    const ensureDirectoryStream = (threadId: ThreadId, directory: string): void => {
      if (controllersByDirectory.has(directory)) {
        return;
      }
      const controller = new AbortController();
      controllersByDirectory.set(directory, controller);

      const runLoop = async () => {
        while (!controller.signal.aborted) {
          let runtime: RuntimeHandle | null = null;
          try {
            runtime = await ensureRuntime(threadId).pipe(runWithServices);
            const eventClient =
              runtime.client ??
              createOpenCodeSdkClient({
                baseUrl: runtime.baseUrl,
                directory,
                ...(runtime.serverPassword ? { serverPassword: runtime.serverPassword } : {}),
              });
            const eventApi = asRecord(asObject(eventClient)?.event);
            const subscribe = asFunction(eventApi, "subscribe");
            const eventStream = runtime.usesInjectedClient
              ? asEventSubscriptionResult(
                  await subscribe({
                    directory,
                    signal: controller.signal,
                  }),
                )
              : asEventSubscriptionResult(
                  await subscribe(
                    {
                      directory,
                    },
                    {
                      signal: controller.signal,
                    },
                  ),
                );
            for await (const streamEvent of eventStream.stream) {
              if (controller.signal.aborted) {
                break;
              }
              const eventRecord = asObject(streamEvent);
              const eventType = asString(eventRecord?.type);
              if (!eventType) {
                continue;
              }
              const eventProperties = asObject(eventRecord?.properties);
              await handleSseEvent({
                type: eventType,
                ...(eventProperties ? { properties: eventProperties } : {}),
              });
            }
          } catch (cause) {
            if (controller.signal.aborted) break;
            if (runtime && isConnectionRefused(cause)) {
              await clearRuntimeIfMatches(runtime)
                .pipe(runWithServices)
                .catch(() => undefined);
              await closeRuntime(runtime)
                .pipe(runWithServices)
                .catch(() => undefined);
            }
            await emitAsync(
              eventBase({
                threadId,
                type: "runtime.warning",
                payload: {
                  message: toMessage(cause, "OpenCode event stream disconnected; retrying."),
                  detail: {
                    error: toMessage(cause, "OpenCode event stream failed."),
                    directory,
                  },
                },
                method: "sse.event",
                rawPayload: { error: toMessage(cause, "OpenCode event stream failed."), directory },
              }),
            );
            await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
          }
        }
      };
      void runLoop();
    };

    const resolveModel = (
      threadId: ThreadId,
      directory: string,
      requested: string | undefined,
      fallback: string | undefined,
      operation: string,
    ) =>
      Effect.gen(function* () {
        const normalized =
          normalizeModelSlug(requested ?? fallback ?? OPENCODE_DEFAULT_MODEL_SLUG, "opencode") ??
          getDefaultModel("opencode");
        const parsed = parseOpencodeModelSlug(normalized);
        if (parsed) {
          return { slug: normalized, providerID: parsed.providerID, modelID: parsed.modelID };
        }
        if (normalized !== OPENCODE_DEFAULT_MODEL_SLUG) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: `Invalid OpenCode model slug '${normalized}'. Expected '<providerID>/<modelID>' or '${OPENCODE_DEFAULT_MODEL_SLUG}'.`,
          });
        }
        const providerList = yield* requestJson<unknown>({
          threadId,
          methodName: "provider.list",
          httpMethod: "GET",
          path: "/provider",
          directory,
          body: undefined,
        });
        const defaults =
          asObject(asObject(providerList)?.default) ?? asObject(asObject(providerList)?.defaults);
        const providerID = defaults
          ? Object.keys(defaults).find((key) => typeof defaults[key] === "string")
          : undefined;
        const modelID = providerID ? asString(defaults?.[providerID]) : undefined;
        if (!providerID || !modelID) {
          return yield* requestError(
            threadId,
            "provider.list",
            "OpenCode default model resolution returned no usable provider/model pair.",
          );
        }
        return { slug: `${providerID}/${modelID}`, providerID, modelID };
      });

    const mapOpencodeCommands = (value: unknown): ProviderListCommandsResult => {
      const commands: ProviderNativeCommandDescriptor[] = [];
      for (const entry of asArray(value) ?? []) {
        const command = asObject(entry);
        if (!command) {
          continue;
        }
        const name = asString(command.name)?.trim();
        if (!name) {
          continue;
        }
        const description = asString(command.description)?.trim();
        if (description) {
          commands.push({ name, description });
        } else {
          commands.push({ name });
        }
      }

      return {
        commands,
        source: "opencodeSdk",
        cached: false,
      } satisfies ProviderListCommandsResult;
    };

    const discoverCommandsForCwd = (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly forceReload?: boolean;
    }) =>
      Effect.gen(function* () {
        if (!input.forceReload) {
          const cached = commandCacheByCwd.get(input.cwd);
          if (cached) {
            return { ...cached, cached: true } satisfies ProviderListCommandsResult;
          }
        }

        let pending = pendingCommandDiscoveryByCwd.get(input.cwd);
        if (!pending) {
          pending = requestJson<unknown>({
            threadId: input.threadId,
            methodName: "command.list",
            httpMethod: "GET",
            path: "/command",
            directory: input.cwd,
            body: undefined,
          })
            .pipe(Effect.map(mapOpencodeCommands), runWithServices)
            .then((result) => {
              commandCacheByCwd.set(input.cwd, result);
              return result;
            })
            .finally(() => {
              pendingCommandDiscoveryByCwd.delete(input.cwd);
            });
          pendingCommandDiscoveryByCwd.set(input.cwd, pending);
        }

        return yield* Effect.tryPromise({
          try: () => pending!,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to discover OpenCode commands."),
              cause,
            }),
        });
      });

    const startSession: OpencodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const resumeCursor = readResumeCursor(input.resumeCursor);
        const cwd = input.cwd ?? resumeCursor?.directory ?? process.cwd();
        const resolvedModel = yield* resolveModel(
          input.threadId,
          cwd,
          input.model,
          undefined,
          "startSession",
        );

        let sessionInfo: OpencodeSessionInfo | undefined;
        if (resumeCursor?.sessionId) {
          const resumedSessionInfo = yield* requestJson<OpencodeSessionInfo>({
            threadId: input.threadId,
            methodName: "session.get",
            httpMethod: "GET",
            path: `/session/${encodeURIComponent(resumeCursor.sessionId)}`,
            directory: cwd,
            body: undefined,
          }).pipe(Effect.option);
          sessionInfo = Option.getOrUndefined(resumedSessionInfo);
        }
        if (!sessionInfo?.id) {
          sessionInfo = yield* requestJson<OpencodeSessionInfo>({
            threadId: input.threadId,
            methodName: "session.create",
            httpMethod: "POST",
            path: "/session",
            directory: cwd,
            body: {},
          });
        }
        if (!sessionInfo?.id) {
          return yield* processError(
            input.threadId,
            "OpenCode session initialization returned no session id.",
          );
        }

        const session: RuntimeSession = {
          threadId: input.threadId,
          sessionId: sessionInfo.id,
          cwd,
          runtimeMode: input.runtimeMode,
          model: resolvedModel.slug,
          status: "ready",
          createdAt:
            typeof sessionInfo.time?.created === "number"
              ? new Date(sessionInfo.time.created).toISOString()
              : nowIso(),
          updatedAt:
            typeof sessionInfo.time?.updated === "number"
              ? new Date(sessionInfo.time.updated).toISOString()
              : nowIso(),
          activeTurnId: null,
        };
        sessions.set(input.threadId, session);
        threadBySessionId.set(session.sessionId, input.threadId);
        ensureDirectoryStream(input.threadId, session.cwd);

        const rawPayload = { sessionId: session.sessionId, directory: session.cwd };
        yield* emit(
          eventBase({
            threadId: input.threadId,
            type: "session.started",
            payload: { resume: rawPayload },
            method: "session.create",
            rawPayload,
          }),
        );
        yield* emit(
          eventBase({
            threadId: input.threadId,
            type: "session.state.changed",
            payload: { state: "ready" },
            method: "session.create",
            rawPayload,
          }),
        );
        yield* emit(
          eventBase({
            threadId: input.threadId,
            type: "thread.started",
            payload: { providerThreadId: session.sessionId },
            method: "session.create",
            rawPayload,
          }),
        );

        return {
          provider: PROVIDER,
          status: session.status,
          runtimeMode: session.runtimeMode,
          cwd: session.cwd,
          model: session.model,
          threadId: session.threadId,
          resumeCursor: { sessionId: session.sessionId, directory: session.cwd },
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        };
      });

    const sendTurn: OpencodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const session = sessions.get(input.threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });

        const resolvedModel = yield* resolveModel(
          input.threadId,
          session.cwd,
          input.model,
          session.model,
          "sendTurn",
        );
        session.model = resolvedModel.slug;
        const openCodeOptions = normalizeOpenCodeModelOptions(
          resolvedModel.slug,
          input.modelOptions?.opencode as OpenCodeModelOptions | undefined,
        );
        const text = materializeSkillMentionsForProvider({
          cwd: session.cwd,
          prompt: input.input?.trim() ?? "",
          providerName: "OpenCode",
        });
        const slashInvocation = parseLeadingSlashInvocation(text);
        const selectedAgent =
          openCodeOptions?.agent ?? opencodeAgentForInteractionMode(input.interactionMode);
        const selectedVariant = openCodeOptions?.variant;

        if (slashInvocation !== null) {
          if ((input.attachments?.length ?? 0) > 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "OpenCode native slash commands do not support attachments.",
            });
          }
          if (!slashInvocation.name) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Slash command name is required.",
            });
          }

          const commandCatalog = yield* discoverCommandsForCwd({
            threadId: input.threadId,
            cwd: session.cwd,
            forceReload: false,
          });
          const commandExists = commandCatalog.commands.some(
            (command) => command.name === slashInvocation.name,
          );
          if (!commandExists) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Unknown OpenCode slash command '/${slashInvocation.name}'.`,
            });
          }

          const turnId = TurnId.makeUnsafe(randomUUID());
          session.activeTurnId = turnId;
          session.status = "running";
          session.updatedAt = nowIso();

          yield* requestJson<void>({
            threadId: input.threadId,
            methodName: "session.command",
            httpMethod: "POST",
            path: `/session/${encodeURIComponent(session.sessionId)}/command`,
            directory: session.cwd,
            body: {
              command: slashInvocation.name,
              arguments: slashInvocation.arguments,
              model: resolvedModel.slug,
              ...(selectedAgent !== undefined ? { agent: selectedAgent } : {}),
              ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
            },
          });

          const rawPayload = {
            sessionId: session.sessionId,
            model: resolvedModel.slug,
            command: slashInvocation.name,
            arguments: slashInvocation.arguments,
            ...(input.interactionMode !== undefined
              ? { interactionMode: input.interactionMode }
              : {}),
            ...(selectedAgent !== undefined ? { agent: selectedAgent } : {}),
            ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
          };
          yield* emit(
            eventBase({
              threadId: input.threadId,
              type: "session.state.changed",
              payload: { state: "running" },
              method: "session.command",
              rawPayload,
              turnId,
            }),
          );
          yield* emit(
            eventBase({
              threadId: input.threadId,
              type: "turn.started",
              payload: { model: resolvedModel.slug },
              method: "session.command",
              rawPayload,
              turnId,
            }),
          );

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: { sessionId: session.sessionId, directory: session.cwd },
          };
        }

        const imageParts = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fs
                .readFile(attachmentPath)
                .pipe(
                  Effect.mapError((cause) =>
                    requestError(
                      input.threadId,
                      "session.prompt_async",
                      toMessage(cause, "Failed to read attachment file."),
                      cause,
                    ),
                  ),
                );
              return {
                type: "file",
                filename: attachment.name,
                mime: attachment.mimeType,
                url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
              };
            }),
          { concurrency: 1 },
        );

        const parts: Array<Record<string, unknown>> = [];
        if (text) parts.push({ type: "text", text });
        parts.push(...imageParts);
        if (parts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Either input text or at least one attachment is required.",
          });
        }

        const turnId = TurnId.makeUnsafe(randomUUID());
        session.activeTurnId = turnId;
        session.status = "running";
        session.updatedAt = nowIso();
        const promptBody = buildOpencodePromptAsyncBody({
          providerID: resolvedModel.providerID,
          modelID: resolvedModel.modelID,
          parts,
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
        });
        const promptBodyWithOptions = {
          ...promptBody,
          ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
          ...(selectedAgent !== undefined ? { agent: selectedAgent } : {}),
        };

        yield* requestJson<void>({
          threadId: input.threadId,
          methodName: "session.prompt_async",
          httpMethod: "POST",
          path: `/session/${encodeURIComponent(session.sessionId)}/prompt_async`,
          directory: session.cwd,
          body: promptBodyWithOptions,
        });

        const rawPayload = {
          sessionId: session.sessionId,
          model: resolvedModel.slug,
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(selectedAgent !== undefined ? { agent: selectedAgent } : {}),
          ...(selectedVariant !== undefined ? { variant: selectedVariant } : {}),
        };
        yield* emit(
          eventBase({
            threadId: input.threadId,
            type: "session.state.changed",
            payload: { state: "running" },
            method: "session.prompt_async",
            rawPayload,
            turnId,
          }),
        );
        yield* emit(
          eventBase({
            threadId: input.threadId,
            type: "turn.started",
            payload: { model: resolvedModel.slug },
            method: "session.prompt_async",
            rawPayload,
            turnId,
          }),
        );

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { sessionId: session.sessionId, directory: session.cwd },
        };
      });

    const interruptTurn: OpencodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        const activeTurnId = session.activeTurnId;
        yield* requestJson<void>({
          threadId,
          methodName: "session.abort",
          httpMethod: "POST",
          path: `/session/${encodeURIComponent(session.sessionId)}/abort`,
          directory: session.cwd,
          body: {},
        });
        session.activeTurnId = null;
        session.status = "ready";
        session.updatedAt = nowIso();
        if (activeTurnId) {
          yield* emit(
            eventBase({
              threadId,
              type: "turn.aborted",
              payload: { reason: "Interrupted by user." },
              method: "session.abort",
              rawPayload: { sessionId: session.sessionId },
              turnId: activeTurnId,
            }),
          );
        }
        yield* emit(
          eventBase({
            threadId,
            type: "session.state.changed",
            payload: { state: "ready" },
            method: "session.abort",
            rawPayload: { sessionId: session.sessionId },
          }),
        );
      });

    const respondToRequest: OpencodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        const reply =
          decision === "accept" ? "once" : decision === "acceptForSession" ? "always" : "reject";
        yield* requestJson<void>({
          threadId,
          methodName: "permission.reply",
          httpMethod: "POST",
          path: `/session/${encodeURIComponent(session.sessionId)}/permissions/${encodeURIComponent(requestId)}`,
          directory: session.cwd,
          body: { reply },
        });
        yield* emit(
          eventBase({
            threadId,
            type: "request.resolved",
            payload: {
              requestType: permissionTypeByRequest.get(requestId) ?? "unknown",
              decision,
              resolution: { reply },
            },
            method: "permission.reply",
            rawPayload: { requestId, reply },
            requestId,
            turnId: session.activeTurnId ?? undefined,
          }),
        );
        permissionTypeByRequest.delete(requestId);
      });

    const respondToUserInput: OpencodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        const orderedQuestionIds = questionIdsByRequest.get(requestId) ?? [];
        const orderedAnswers = orderedQuestionIds.map((questionId) => {
          const value = answers[questionId];
          if (typeof value === "string") return [value];
          if (Array.isArray(value))
            return value.filter((entry): entry is string => typeof entry === "string");
          const nested = asArray(asObject(value)?.answers);
          return (nested ?? []).filter((entry): entry is string => typeof entry === "string");
        });
        yield* requestJson<void>({
          threadId,
          methodName: "question.reply",
          httpMethod: "POST",
          path: `/question/${encodeURIComponent(requestId)}/reply`,
          directory: session.cwd,
          body: { answers: orderedAnswers },
        });
        yield* emit(
          eventBase({
            threadId,
            type: "user-input.resolved",
            payload: { answers },
            method: "question.reply",
            rawPayload: { requestId, answers },
            requestId,
            turnId: session.activeTurnId ?? undefined,
          }),
        );
        questionIdsByRequest.delete(requestId);
      });

    const readThread: OpencodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        const messages = yield* requestJson<ReadonlyArray<OpencodeMessage>>({
          threadId,
          methodName: "session.messages",
          httpMethod: "GET",
          path: `/session/${encodeURIComponent(session.sessionId)}/message`,
          directory: session.cwd,
          body: undefined,
        });
        const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
        let current: { id: TurnId; items: Array<unknown> } | null = null;
        for (const message of messages) {
          const role = message.info?.role;
          const id = message.info?.id;
          if (role === "user") {
            current = { id: TurnId.makeUnsafe(id ?? randomUUID()), items: [message] };
            turns.push(current);
            continue;
          }
          if (!current) {
            current = { id: TurnId.makeUnsafe(id ?? randomUUID()), items: [] };
            turns.push(current);
          }
          current.items.push(message);
        }
        return { threadId, turns: turns.map((turn) => ({ id: turn.id, items: turn.items })) };
      });

    const rollbackThread: OpencodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const session = sessions.get(threadId);
        if (!session)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        const messages = yield* requestJson<ReadonlyArray<OpencodeMessage>>({
          threadId,
          methodName: "session.messages",
          httpMethod: "GET",
          path: `/session/${encodeURIComponent(session.sessionId)}/message`,
          directory: session.cwd,
          body: undefined,
        });
        const userMessageIds = messages
          .filter(
            (message): message is OpencodeMessage & { info: { id: string; role: "user" } } =>
              message.info?.role === "user" &&
              typeof message.info.id === "string" &&
              message.info.id.length > 0,
          )
          .map((message) => message.info.id);
        if (numTurns > userMessageIds.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot rollback ${numTurns} turn(s); thread has ${userMessageIds.length} user turn(s).`,
          });
        }
        const target = userMessageIds[userMessageIds.length - numTurns]!;
        yield* requestJson<void>({
          threadId,
          methodName: "session.revert",
          httpMethod: "POST",
          path: `/session/${encodeURIComponent(session.sessionId)}/revert`,
          directory: session.cwd,
          body: { messageID: target },
        });
        return yield* readThread(threadId);
      });

    const stopSession: OpencodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        if (!session) return;
        sessions.delete(threadId);
        threadBySessionId.delete(session.sessionId);
        for (const [partId, metadata] of partMetadataById.entries()) {
          if (metadata.sessionId === session.sessionId) {
            partMetadataById.delete(partId);
          }
        }
        for (const [partId, metadata] of toolPartStatusById.entries()) {
          if (metadata.sessionId === session.sessionId) {
            toolPartStatusById.delete(partId);
          }
        }
        messageRoleGate.clearSession(session.sessionId);
        for (const [
          messageId,
          messageSessionId,
        ] of completedAssistantMessageSessionById.entries()) {
          if (messageSessionId === session.sessionId) {
            completedAssistantMessageSessionById.delete(messageId);
          }
        }
        releaseDirectoryStreamIfUnused(session.cwd);
      });

    const listSessions: OpencodeAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values(), (session) => ({
          provider: PROVIDER,
          status: session.status,
          runtimeMode: session.runtimeMode,
          cwd: session.cwd,
          model: session.model,
          threadId: session.threadId,
          resumeCursor: { sessionId: session.sessionId, directory: session.cwd },
          ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })),
      );

    const hasSession: OpencodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const composerCapabilities: ProviderComposerCapabilities = {
      provider: PROVIDER,
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
    };

    const getComposerCapabilities: NonNullable<
      OpencodeAdapterShape["getComposerCapabilities"]
    > = () => Effect.succeed(composerCapabilities);

    const listSkills: NonNullable<OpencodeAdapterShape["listSkills"]> = (
      input: ProviderListSkillsInput,
    ) =>
      Effect.succeed({
        skills: discoverSkillsForCwd(input.cwd),
        source: "local-scan",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const listCommands: NonNullable<OpencodeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        const discoveryThreadId =
          input.threadId !== undefined
            ? ThreadId.makeUnsafe(input.threadId)
            : ([...sessions.values()][0]?.threadId ?? ThreadId.makeUnsafe("discovery"));
        if (input.forceReload !== undefined) {
          return yield* discoverCommandsForCwd({
            threadId: discoveryThreadId,
            cwd: input.cwd,
            forceReload: input.forceReload,
          });
        }
        return yield* discoverCommandsForCwd({
          threadId: discoveryThreadId,
          cwd: input.cwd,
        });
      });

    const listModels: NonNullable<OpencodeAdapterShape["listModels"]> = () =>
      Effect.gen(function* () {
        const discoveryThreadId =
          [...sessions.values()][0]?.threadId ?? ThreadId.makeUnsafe("discovery");
        const directory = [...sessions.values()][0]?.cwd ?? serverConfig.cwd;
        const providerList = yield* requestJson<unknown>({
          threadId: discoveryThreadId,
          methodName: "provider.list",
          httpMethod: "GET",
          path: "/provider",
          directory,
          body: undefined,
        });

        const providerListRecord = asObject(providerList);
        const connected = new Set(
          (asArray(providerListRecord?.connected) ?? []).flatMap((value) =>
            typeof value === "string" ? [value] : [],
          ),
        );
        const allProviders = asArray(providerListRecord?.all) ?? [];
        const models = allProviders
          .flatMap((providerValue) => {
            const provider = asObject(providerValue);
            const providerId = asString(provider?.id);
            const providerName = asString(provider?.name) ?? providerId;
            if (!providerId || !providerName || !connected.has(providerId)) {
              return [];
            }
            const providerModels = asObject(provider?.models) ?? {};
            return Object.values(providerModels).flatMap((modelValue) => {
              const model = asObject(modelValue);
              const modelId = asString(model?.id);
              const modelName = asString(model?.name) ?? modelId;
              if (!modelId || !modelName) {
                return [];
              }
              return [
                {
                  slug: `${providerId}/${modelId}`,
                  name: `${providerName} · ${modelName}`,
                },
              ];
            });
          })
          .toSorted((left, right) => left.name.localeCompare(right.name))
          .filter(
            (model, index, collection) =>
              collection.findIndex((candidate) => candidate.slug === model.slug) === index,
          );

        return {
          models,
          source: "runtime",
          cached: false,
        } satisfies ProviderListModelsResult;
      });

    const stopAll: OpencodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        sessions.clear();
        threadBySessionId.clear();
        permissionTypeByRequest.clear();
        questionIdsByRequest.clear();
        partMetadataById.clear();
        toolPartStatusById.clear();
        messageRoleGate.clearAll();
        completedAssistantMessageSessionById.clear();
        commandCacheByCwd.clear();
        pendingCommandDiscoveryByCwd.clear();
        for (const controller of controllersByDirectory.values()) controller.abort();
        controllersByDirectory.clear();
        const runtime = yield* Ref.get(runtimeRef);
        if (runtime) {
          yield* closeRuntime(runtime);
          yield* Ref.set(runtimeRef, null);
        }
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.flatMap(() => Queue.shutdown(queue)),
        Effect.catch(() => Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      getComposerCapabilities,
      listSkills,
      listCommands,
      listModels,
      streamEvents: Stream.fromQueue(queue),
    } satisfies OpencodeAdapterShape;
  });

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter());

export function makeOpencodeAdapterLive(options?: OpencodeAdapterLiveOptions) {
  return Layer.effect(OpencodeAdapter, makeOpencodeAdapter(options));
}
