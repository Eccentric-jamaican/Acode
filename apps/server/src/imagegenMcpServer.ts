import { spawn } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { stdin, stdout } from "node:process";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  outputs: string[];
}

function writeMessage(payload: unknown): void {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8");
  stdout.write(`Content-Length: ${encoded.length}\r\n\r\n`);
  stdout.write(encoded);
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeError(id: JsonRpcId, message: string): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || Path.join(OS.homedir(), ".codex");
}

function resolveWorkspace(): string {
  const configured = process.env.T3_IMAGEGEN_WORKSPACE?.trim();
  return configured && Path.isAbsolute(configured) ? configured : process.cwd();
}

function resolveImagegenScriptPath(): string {
  const configured = process.env.T3_IMAGEGEN_SCRIPT_PATH?.trim();
  if (configured) {
    return configured;
  }
  return Path.join(resolveCodexHome(), "skills", ".system", "imagegen", "scripts", "image_gen.py");
}

function resolvePythonCommand(): string {
  return process.env.PYTHON?.trim() || process.env.PYTHON_EXE?.trim() || "python";
}

function outputPathFor(input: {
  readonly cwd: string;
  readonly out: string | undefined;
  readonly format: string;
  readonly prefix: string;
}): string {
  if (input.out) {
    return Path.isAbsolute(input.out) ? input.out : Path.resolve(input.cwd, input.out);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return Path.join(input.cwd, "output", "imagegen", `${input.prefix}-${timestamp}.${input.format}`);
}

function pushOptional(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}

function pushOptionalNumber(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(flag, String(value));
  }
}

async function runImagegenCli(args: string[], cwd: string): Promise<ToolResult> {
  const scriptPath = resolveImagegenScriptPath();
  if (!FS.existsSync(scriptPath)) {
    throw new Error(`Codex imagegen CLI was not found at '${scriptPath}'.`);
  }

  const command = [resolvePythonCommand(), scriptPath, ...args];
  const outputCandidates = args
    .flatMap((arg, index) => (arg === "--out" ? [args[index + 1]] : []))
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return await new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: resolveCodexHome(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutText = "";
    let stderrText = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        command,
        cwd,
        stdout: stdoutText.trim(),
        stderr: stderrText.trim(),
        outputs: outputCandidates,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          [
            `imagegen CLI failed with exit code ${code ?? "unknown"}.`,
            stderrText.trim() || stdoutText.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function buildGenerateArgs(input: Record<string, unknown>): string[] {
  const prompt = asString(input.prompt);
  if (!prompt) {
    throw new Error("image_generate requires a non-empty prompt.");
  }

  const cwd = resolveWorkspace();
  const format = asString(input.output_format) ?? "png";
  const out = outputPathFor({
    cwd,
    out: asString(input.out),
    format,
    prefix: "generated",
  });
  const args = ["generate", "--prompt", prompt, "--out", out, "--output-format", format];
  pushOptional(args, "--model", asString(input.model));
  pushOptional(args, "--size", asString(input.size));
  pushOptional(args, "--quality", asString(input.quality));
  pushOptional(args, "--background", asString(input.background));
  pushOptional(args, "--use-case", asString(input.use_case));
  pushOptional(args, "--style", asString(input.style));
  pushOptional(args, "--composition", asString(input.composition));
  pushOptional(args, "--lighting", asString(input.lighting));
  pushOptional(args, "--constraints", asString(input.constraints));
  pushOptionalNumber(args, "--n", input.n);
  if (asBoolean(input.force)) {
    args.push("--force");
  }
  return args;
}

function buildEditArgs(input: Record<string, unknown>): string[] {
  const prompt = asString(input.prompt);
  if (!prompt) {
    throw new Error("image_edit requires a non-empty prompt.");
  }
  const images = asStringArray(input.images);
  if (images.length === 0) {
    throw new Error("image_edit requires at least one image path in images.");
  }

  const cwd = resolveWorkspace();
  const format = asString(input.output_format) ?? "png";
  const out = outputPathFor({
    cwd,
    out: asString(input.out),
    format,
    prefix: "edited",
  });
  const args = ["edit", "--prompt", prompt, "--out", out, "--output-format", format];
  for (const image of images) {
    args.push("--image", Path.isAbsolute(image) ? image : Path.resolve(cwd, image));
  }
  pushOptional(args, "--mask", asString(input.mask));
  pushOptional(args, "--model", asString(input.model));
  pushOptional(args, "--quality", asString(input.quality));
  pushOptional(args, "--input-fidelity", asString(input.input_fidelity));
  if (asBoolean(input.force)) {
    args.push("--force");
  }
  return args;
}

const TOOL_DEFINITIONS = [
  {
    name: "image_generate",
    description:
      "Generate a bitmap image with the Codex imagegen CLI fallback. Requires OPENAI_API_KEY. Saves the output in the workspace.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        size: { type: "string" },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        output_format: { type: "string", enum: ["png", "jpeg", "jpg", "webp"] },
        background: { type: "string", enum: ["transparent", "opaque", "auto"] },
        n: { type: "number" },
        force: { type: "boolean" },
        use_case: { type: "string" },
        style: { type: "string" },
        composition: { type: "string" },
        lighting: { type: "string" },
        constraints: { type: "string" },
      },
    },
  },
  {
    name: "image_edit",
    description:
      "Edit one or more bitmap images with the Codex imagegen CLI fallback. Requires OPENAI_API_KEY. Saves the output in the workspace.",
    inputSchema: {
      type: "object",
      required: ["prompt", "images"],
      properties: {
        prompt: { type: "string" },
        images: { type: "array", items: { type: "string" } },
        mask: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        input_fidelity: { type: "string", enum: ["low", "high"] },
        output_format: { type: "string", enum: ["png", "jpeg", "jpg", "webp"] },
        force: { type: "boolean" },
      },
    },
  },
] as const;

async function callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "OPENAI_API_KEY is not set. T3 imagegen MCP uses the Codex skill CLI fallback for non-Codex providers, so set OPENAI_API_KEY locally before generating images.",
    );
  }
  const input = asRecord(args);
  const cwd = resolveWorkspace();
  switch (name) {
    case "image_generate":
      return runImagegenCli(buildGenerateArgs(input), cwd);
    case "image_edit":
      return runImagegenCli(buildEditArgs(input), cwd);
    default:
      throw new Error(`Unknown tool '${name}'.`);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case "initialize":
        writeResult(request.id ?? null, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "t3-imagegen",
            version: "0.1.0",
          },
        });
        return;
      case "notifications/initialized":
        return;
      case "ping":
        writeResult(request.id ?? null, {});
        return;
      case "tools/list":
        writeResult(request.id ?? null, { tools: TOOL_DEFINITIONS });
        return;
      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string" || name.length === 0) {
          throw new Error("Tool call is missing a tool name.");
        }
        const result = await callTool(
          name,
          request.params?.arguments &&
            typeof request.params.arguments === "object" &&
            !Array.isArray(request.params.arguments)
            ? (request.params.arguments as Record<string, unknown>)
            : undefined,
        );
        writeResult(request.id ?? null, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        });
        return;
      }
      default:
        if (request.id !== undefined) {
          writeError(request.id ?? null, `Unsupported MCP method '${request.method}'.`);
        }
    }
  } catch (error) {
    if (request.id !== undefined) {
      writeError(request.id ?? null, error instanceof Error ? error.message : String(error));
    }
  }
}

let inputBuffer = Buffer.alloc(0);
stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

  while (inputBuffer.length > 0) {
    const separatorIndex = inputBuffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }
    const headerText = inputBuffer.slice(0, separatorIndex).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch?.[1]) {
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = separatorIndex + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
      return;
    }
    const bodyText = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(bodyEnd);
    const message = JSON.parse(bodyText) as JsonRpcRequest;
    void handleRequest(message);
  }
});
