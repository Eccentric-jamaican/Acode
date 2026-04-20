import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as Net from "node:net";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ChatAttachment,
  ModelCapabilities,
  ProviderApprovalDecision,
  RuntimeMode,
  ServerProviderStatus,
} from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const PORT_POLL_INTERVAL_MS = 200;

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  variantOptions: [],
  agentOptions: [],
};

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly process: ChildProcess | null;
  readonly external: boolean;
  close(): void;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function buildOpenCodeBasicAuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

function buildVariantOptions(
  providerID: string,
  model: ProviderListResponse["all"][number]["models"][string],
) {
  const values = Object.keys(model.variants ?? {});
  return values.map((value, index) => ({
    value,
    label: titleCaseSlug(value),
    ...(index === 0 ? { isDefault: true as const } : {}),
  }));
}

function buildAgentOptions(agents: ReadonlyArray<Agent>) {
  const visibleAgents = agents.filter((agent) => !agent.hidden);
  return visibleAgents.map((agent, index) => ({
    value: agent.name,
    label: titleCaseSlug(agent.name),
    ...(index === 0 || agent.name === "build" ? { isDefault: true as const } : {}),
  }));
}

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  return {
    ...DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    variantOptions: buildVariantOptions(input.providerID, input.model),
    agentOptions: buildAgentOptions(input.agents),
  };
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }
  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      return [raw];
    }
    return [];
  });
}

export async function findAvailablePort(): Promise<number> {
  const server = Net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_HOSTNAME, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Failed to resolve OpenCode port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startOpenCodeServerProcess(input: {
  readonly binaryPath: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}): Promise<OpenCodeServerConnection> {
  const hostname = input.hostname ?? DEFAULT_HOSTNAME;
  const port = input.port ?? (await findAvailablePort());
  const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
  const child = spawn(input.binaryPath, ["serve", `--hostname=${hostname}`, `--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
    },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  const serverUrl = `http://${hostname}:${port}`;
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for OpenCode server after ${timeoutMs}ms.`));
    }, timeoutMs);
    let portPoll: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      if (portPoll) {
        clearInterval(portPoll);
        portPoll = null;
      }
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onStdout = (chunk: string) => {
      stdout += chunk;
      const parsed = parseServerUrlFromOutput(stdout);
      if (!parsed) {
        return;
      }
      cleanup();
      resolve(parsed);
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          [
            `OpenCode server exited before startup completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
            stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    };

    const pollPort = () => {
      const socket = Net.createConnection({ host: hostname, port });
      socket.once("connect", () => {
        socket.destroy();
        cleanup();
        resolve(serverUrl);
      });
      socket.once("error", () => {
        socket.destroy();
      });
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    portPoll = setInterval(pollPort, PORT_POLL_INTERVAL_MS);
    pollPort();
  });

  let closed = false;
  return {
    url,
    process: child,
    external: false,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      child.kill();
    },
  };
}

export async function connectToOpenCodeServer(input: {
  readonly binaryPath: string;
  readonly serverUrl?: string | null;
  readonly port?: number;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}): Promise<OpenCodeServerConnection> {
  const serverUrl = input.serverUrl?.trim();
  if (serverUrl) {
    return {
      url: serverUrl,
      process: null,
      external: true,
      close() {},
    };
  }
  return startOpenCodeServerProcess(input);
}

export async function runOpenCodeCommand(input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = spawn(input.binaryPath, [...input.args], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: process.env,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 0));
  });
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    code,
  };
}

export function createOpenCodeSdkClient(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
}): OpencodeClient {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    directory: input.directory,
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: buildOpenCodeBasicAuthorizationHeader(input.serverPassword),
          },
        }
      : {}),
    throwOnError: true,
  });
}

export async function loadOpenCodeInventory(client: OpencodeClient): Promise<OpenCodeInventory> {
  const [providerListResult, agentsResult] = await Promise.all([
    client.provider.list(),
    client.app.agents(),
  ]);
  if (!providerListResult.data) {
    throw new Error("OpenCode provider inventory was empty.");
  }
  return {
    providerList: providerListResult.data,
    agents: agentsResult.data ?? [],
  };
}

export function flattenOpenCodeModels(
  input: OpenCodeInventory,
): ReadonlyArray<NonNullable<ServerProviderStatus["models"]>[number]> {
  const connected = new Set(input.providerList.connected);
  const models: Array<NonNullable<ServerProviderStatus["models"]>[number]> = [];
  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }
    for (const model of Object.values(provider.models)) {
      models.push({
        slug: `${provider.id}/${model.id}`,
        name: `${provider.name} · ${model.name}`,
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function resolveOpenCodeBinaryPath(binaryPath: string): string {
  if (Path.isAbsolute(binaryPath)) {
    return binaryPath;
  }
  const candidates = execFileSync(process.platform === "win32" ? "where" : "which", [binaryPath], {
    encoding: "utf8",
    timeout: 3_000,
    shell: process.platform === "win32",
  })
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (process.platform === "win32") {
    return (
      candidates.find((entry) => entry.toLowerCase().endsWith(".cmd")) ??
      candidates.find((entry) => entry.toLowerCase().endsWith(".exe")) ??
      candidates[0] ??
      binaryPath
    );
  }
  return candidates[0] ?? binaryPath;
}
