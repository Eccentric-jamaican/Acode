#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isComputerUseAppAllowed } from "@t3tools/shared/computerUsePermissions";
import { normalizeServerSettings } from "@t3tools/shared/serverSettings";

import {
  executeActivateElement,
  executeClick,
  executeDoubleClick,
  executeDrag,
  executeGetVisibleText,
  executeKeypress,
  executeListAppWindows,
  executeListElements,
  executeMoveMouse,
  executeScreenshot,
  executeScroll,
  executeTypeText,
  executeWait,
} from "./computerUse/bridge";
import { launchComputerUseApp, listComputerUseApps } from "./computerUseService";
import type {
  AgentToolResult,
  ExtensionContextLike,
  ToolContentPart,
} from "./computerUse/tool-contract";

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stateDir = process.env.T3CODE_STATE_DIR?.trim() || path.join(os.homedir(), ".t3", "dev");
const threadId = process.env.T3_COMPUTER_THREAD_ID?.trim() || "standalone";
const enableTextResultBridge = process.env.T3_COMPUTER_TEXT_RESULT_BRIDGE === "1";
const settingsPath = path.join(stateDir, "settings.json");

const context: ExtensionContextLike = {
  hasUI: false,
  ui: {
    async select() {
      return undefined;
    },
    notify() {},
  },
  sessionManager: {
    getBranch() {
      return [];
    },
  },
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "screenshot",
    description:
      "Capture a screenshot of a desktop app or the frontmost window. Use this first before coordinate actions.",
    inputSchema: objectSchema({
      app: {
        type: "string",
        description: "Optional running app name, such as Visual Studio Code.",
      },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
    }),
  },
  {
    name: "observe_app",
    description:
      "Observe a desktop app through accessibility text and element refs. Prefer this for non-image models and semantic UI Automation actions.",
    inputSchema: objectSchema({
      app: {
        type: "string",
        description: "Optional app name, such as Visual Studio Code.",
      },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
      actionableOnly: { type: "boolean" },
      maxItems: { type: "number" },
      maxDepth: { type: "number" },
    }),
  },
  {
    name: "list_apps",
    description: "List running and installed desktop apps visible to T3 Computer Use.",
    inputSchema: objectSchema({}),
  },
  {
    name: "launch_app",
    description: "Launch an installed Windows desktop app before using screenshot or actions.",
    inputSchema: objectSchema({
      app: { type: "string", description: "App name, such as Calculator or Visual Studio Code." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
    }),
  },
  {
    name: "list_windows",
    description: "List controllable windows for a running app pid.",
    inputSchema: objectSchema({ pid: { type: "number" } }, ["pid"]),
  },
  {
    name: "list_elements",
    description: "List semantic UI Automation elements in the current controlled window.",
    inputSchema: objectSchema({
      actionableOnly: { type: "boolean" },
      maxItems: { type: "number" },
      maxDepth: { type: "number" },
    }),
  },
  {
    name: "get_visible_text",
    description: "Read visible text from the current controlled window.",
    inputSchema: objectSchema({ maxItems: { type: "number" }, maxDepth: { type: "number" } }),
  },
  {
    name: "activate_element",
    description: "Activate a semantic UI element from list_elements by elementRef.",
    inputSchema: objectSchema(
      {
        elementRef: { type: "string" },
        action: { type: "string", enum: ["default", "focus", "invoke", "select"] },
      },
      ["elementRef"],
    ),
  },
  {
    name: "click",
    description: "Click at window-relative screenshot coordinates from the latest screenshot.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "wheel", "back", "forward"] },
        captureId: { type: "string" },
        allowGlobalInput: {
          type: "boolean",
          description:
            "Only set true after user approval; allows fallback to the real mouse if semantic UI Automation cannot perform the click.",
        },
      },
      ["x", "y"],
    ),
  },
  {
    name: "double_click",
    description:
      "Double-click at window-relative screenshot coordinates from the latest screenshot.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        captureId: { type: "string" },
        allowGlobalInput: { type: "boolean" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "move_mouse",
    description:
      "Move the T3 virtual agent cursor to window-relative screenshot coordinates. Set allowGlobalInput true only after user approval to move the real pointer.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        captureId: { type: "string" },
        allowGlobalInput: { type: "boolean" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "drag",
    description: "Drag through window-relative screenshot coordinate points.",
    inputSchema: objectSchema(
      {
        path: {
          type: "array",
          items: objectSchema({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
        },
        captureId: { type: "string" },
        allowGlobalInput: { type: "boolean" },
      },
      ["path"],
    ),
  },
  {
    name: "scroll",
    description: "Scroll at window-relative screenshot coordinates.",
    inputSchema: objectSchema(
      {
        x: { type: "number" },
        y: { type: "number" },
        scrollX: { type: "number" },
        scrollY: { type: "number" },
        captureId: { type: "string" },
        allowGlobalInput: { type: "boolean" },
      },
      ["x", "y", "scrollX", "scrollY"],
    ),
  },
  {
    name: "type_text",
    description:
      "Type text into the currently focused desktop control. Uses UI Automation value setting first; set allowGlobalInput true only after user approval for keyboard/clipboard fallback.",
    inputSchema: objectSchema({ text: { type: "string" }, allowGlobalInput: { type: "boolean" } }, [
      "text",
    ]),
  },
  {
    name: "keypress",
    description:
      "Press a keyboard shortcut, for example { keys: ['CTRL', 'L'] }. Requires user approval via allowGlobalInput because it uses real keyboard input.",
    inputSchema: objectSchema(
      {
        keys: { type: "array", items: { type: "string" } },
        allowGlobalInput: { type: "boolean" },
      },
      ["keys"],
    ),
  },
  {
    name: "wait",
    description: "Wait for the current desktop app to settle and return a fresh screenshot.",
    inputSchema: objectSchema({ ms: { type: "number" } }),
  },
];

function writeResponse(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: JsonRpcRequest["id"], message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "unknown";
}

async function persistImages(content: ToolContentPart[], details: unknown): Promise<unknown[]> {
  const images = content.filter(
    (part): part is Extract<ToolContentPart, { type: "image" }> => part.type === "image",
  );
  const captures: unknown[] = [];
  for (const image of images) {
    const captureId =
      typeof (details as { capture?: { captureId?: unknown } })?.capture?.captureId === "string"
        ? (details as { capture: { captureId: string } }).capture.captureId
        : randomUUID();
    const relativePath = path.posix.join(
      "computer-use",
      sanitizeSegment(threadId),
      "captures",
      `${sanitizeSegment(captureId)}.png`,
    );
    const filePath = path.join(stateDir, "attachments", ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(image.data, "base64"));
    captures.push({
      captureId,
      mimeType: image.mimeType,
      url: `/attachments/${relativePath}`,
      path: filePath,
      width: (details as { capture?: { width?: unknown } })?.capture?.width,
      height: (details as { capture?: { height?: unknown } })?.capture?.height,
    });
  }
  return captures;
}

function textContent(result: AgentToolResult<unknown>): ToolContentPart[] {
  const hasText = result.content.some((part) => part.type === "text");
  if (hasText) return result.content;
  return [{ type: "text", text: JSON.stringify(result.details, null, 2) }, ...result.content];
}

function contentWithTextResultBridge(
  content: ToolContentPart[],
  structuredContent: Record<string, unknown>,
): ToolContentPart[] {
  if (!enableTextResultBridge) {
    return content;
  }
  const marker = `<t3_computer_result>${JSON.stringify(structuredContent)}</t3_computer_result>`;
  const textIndex = content.findIndex((part) => part.type === "text");
  if (textIndex >= 0) {
    return content.map((part, index) =>
      index === textIndex && part.type === "text"
        ? { ...part, text: `${part.text}\n\n${marker}` }
        : part,
    );
  }
  return [{ type: "text", text: marker }, ...content];
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readComputerUseSettings() {
  try {
    const raw = await readFile(settingsPath, "utf8");
    return normalizeServerSettings(JSON.parse(raw) as Record<string, unknown>).computerUse;
  } catch {
    return normalizeServerSettings({}).computerUse;
  }
}

async function assertComputerUseAppAllowed(args: Record<string, unknown>): Promise<void> {
  const appName = stringArg(args, "app");
  const launchId = stringArg(args, "launchId");
  if (!appName && !launchId && typeof args.pid !== "number") return;

  const settings = await readComputerUseSettings();
  if (!settings.enabled) {
    throw new Error("T3 Computer Use is disabled in settings.");
  }

  const appsResult = await listComputerUseApps();
  const normalizedAppName = appName?.toLowerCase();
  const app = appsResult.apps.find((candidate) => {
    if (launchId && candidate.launchId === launchId) return true;
    if (typeof args.pid === "number" && candidate.pid === args.pid) return true;
    return normalizedAppName ? candidate.name.toLowerCase() === normalizedAppName : false;
  });
  if (!app) return;
  if (!isComputerUseAppAllowed(app, settings)) {
    throw new Error(
      `${app.name} is disabled for T3 Computer Use. Enable it in Computer use settings first.`,
    );
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = `computer_${Date.now()}`;
  switch (name) {
    case "screenshot":
      await assertComputerUseAppAllowed(args);
      try {
        return await executeScreenshot(id, args, undefined, undefined, context);
      } catch (error) {
        const appName = stringArg(args, "app");
        if (!appName) throw error;
        await launchComputerUseApp({ appName });
        await delay(1_200);
        return executeScreenshot(`${id}_after_launch`, args, undefined, undefined, context);
      }
    case "observe_app": {
      await assertComputerUseAppAllowed(args);
      if (stringArg(args, "app") || stringArg(args, "windowTitle")) {
        try {
          await executeScreenshot(id, args, undefined, undefined, context);
        } catch (error) {
          const appName = stringArg(args, "app");
          if (!appName) throw error;
          await launchComputerUseApp({ appName });
          await delay(1_200);
          await executeScreenshot(`${id}_after_launch`, args, undefined, undefined, context);
        }
      }
      const [visibleText, elements] = await Promise.all([
        executeGetVisibleText(
          `${id}_visible_text`,
          {
            maxItems: typeof args.maxItems === "number" ? args.maxItems : 120,
            maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : 12,
          },
          undefined,
          undefined,
          context,
        ),
        executeListElements(
          `${id}_elements`,
          {
            actionableOnly: args.actionableOnly !== false,
            maxItems: typeof args.maxItems === "number" ? args.maxItems : 120,
            maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : 12,
          },
          undefined,
          undefined,
          context,
        ),
      ]);
      const text = [
        visibleText.content.find((part) => part.type === "text")?.text,
        elements.content.find((part) => part.type === "text")?.text,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: {
          tool: "observe_app",
          visibleText: visibleText.details,
          elements: elements.details,
        },
      } satisfies AgentToolResult<unknown>;
    }
    case "list_apps": {
      const settings = await readComputerUseSettings();
      const result = await listComputerUseApps();
      const apps = result.apps.filter((app) => isComputerUseAppAllowed(app, settings));
      return {
        content: [
          {
            type: "text",
            text: `Found ${apps.length} desktop apps enabled for T3 Computer Use.`,
          },
        ],
        details: { ...result, apps },
      } satisfies AgentToolResult<unknown>;
    }
    case "launch_app": {
      await assertComputerUseAppAllowed(args);
      const appName = stringArg(args, "app");
      const launchId = stringArg(args, "launchId");
      await launchComputerUseApp({ appName, launchId });
      return {
        content: [
          {
            type: "text",
            text: `Launched ${appName ?? launchId ?? "desktop app"}.`,
          },
        ],
        details: { appName, launchId },
      } satisfies AgentToolResult<unknown>;
    }
    case "list_windows":
      await assertComputerUseAppAllowed(args);
      return executeListAppWindows(id, { pid: Number(args.pid) }, undefined, undefined, context);
    case "list_elements":
      return executeListElements(id, args, undefined, undefined, context);
    case "get_visible_text":
      return executeGetVisibleText(id, args, undefined, undefined, context);
    case "activate_element":
      return executeActivateElement(
        id,
        args as { elementRef: string; action?: "default" | "focus" | "invoke" | "select" },
        undefined,
        undefined,
        context,
      );
    case "click":
      return executeClick(
        id,
        args as {
          x: number;
          y: number;
          button?: "left" | "right" | "wheel" | "back" | "forward";
          captureId?: string;
        },
        undefined,
        undefined,
        context,
      );
    case "double_click":
      return executeDoubleClick(
        id,
        args as { x: number; y: number; captureId?: string },
        undefined,
        undefined,
        context,
      );
    case "move_mouse":
      return executeMoveMouse(
        id,
        args as { x: number; y: number; captureId?: string },
        undefined,
        undefined,
        context,
      );
    case "drag":
      return executeDrag(
        id,
        args as { path: Array<{ x: number; y: number }>; captureId?: string },
        undefined,
        undefined,
        context,
      );
    case "scroll":
      return executeScroll(
        id,
        args as { x: number; y: number; scrollX: number; scrollY: number; captureId?: string },
        undefined,
        undefined,
        context,
      );
    case "type_text":
      return executeTypeText(id, args as { text: string }, undefined, undefined, context);
    case "keypress":
      return executeKeypress(id, args as { keys: string[] }, undefined, undefined, context);
    case "wait":
      return executeWait(id, args as { ms?: number }, undefined, undefined, context);
    default:
      throw new Error(`Unknown T3 Computer Use tool '${name}'.`);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  switch (request.method) {
    case "initialize":
      writeResponse(request.id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "t3-computer-use", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      writeResponse(request.id ?? null, { tools: TOOL_DEFINITIONS });
      return;
    case "tools/call": {
      const params = request.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const name = params?.name;
      if (!name) {
        writeError(request.id ?? null, "tools/call missing tool name.");
        return;
      }
      const result = (await callTool(name, params.arguments ?? {})) as AgentToolResult<unknown>;
      const captures = await persistImages(result.content, result.details);
      const structuredContent = {
        providerNeutralType: "computer_use",
        tool: name,
        details: result.details,
        captures,
      };
      writeResponse(request.id ?? null, {
        content: contentWithTextResultBridge(textContent(result), structuredContent),
        structuredContent,
      });
      return;
    }
    default:
      if (request.id == null) {
        return;
      }
      writeError(request.id ?? null, `Unsupported MCP method '${request.method}'.`);
  }
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  while (true) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    void (async () => {
      let requestId: JsonRpcRequest["id"] = null;
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        requestId = request.id ?? null;
        await handleRequest(request);
      } catch (error) {
        writeError(requestId, error instanceof Error ? error.message : String(error));
      }
    })();
  }
});
