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
import {
  attachComputerUseWindow,
  closeComputerUseWindow,
  focusComputerUseWindow,
  getActiveComputerUseWindow,
  getComputerUseWindowBounds,
  launchComputerUseApp,
  listComputerUseApps,
  moveComputerUseWindow,
  resizeComputerUseWindow,
} from "./computerUseService";
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

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function parseComputerUseTargetInput(args: Record<string, unknown>): {
  app?: string;
  launchId?: string;
  pid?: number;
  windowId?: number;
  windowTitle?: string;
} {
  const app = stringArg(args, "app");
  const launchId = stringArg(args, "launchId");
  const windowTitle = stringArg(args, "windowTitle");
  const pid = parsePositiveInteger(args.pid);
  const windowId = parsePositiveInteger(args.windowId);
  return {
    ...(app ? { app } : {}),
    ...(launchId ? { launchId } : {}),
    ...(typeof pid === "number" ? { pid } : {}),
    ...(typeof windowId === "number" ? { windowId } : {}),
    ...(windowTitle ? { windowTitle } : {}),
  };
}

function targetInputForLaunchedApp(launched: {
  readonly appName: string;
  readonly launchId: string;
  readonly pid?: number;
  readonly windowId?: number;
  readonly windowTitle?: string;
}): Record<string, unknown> {
  return {
    app: launched.appName,
    launchId: launched.launchId,
    ...(typeof launched.pid === "number" && launched.pid > 0 ? { pid: launched.pid } : {}),
    ...(typeof launched.windowId === "number" && launched.windowId > 0
      ? { windowId: launched.windowId }
      : {}),
    ...(launched.windowTitle ? { windowTitle: launched.windowTitle } : {}),
  };
}

async function performWindowToolWithOptionalScreenshot(
  id: string,
  tool: string,
  managed: {
    readonly appName: string;
    readonly launchId: string;
    readonly pid: number;
    readonly windowId: number;
    readonly windowTitle: string;
  },
  screenshotFallbackText: string,
): Promise<AgentToolResult<unknown>> {
  try {
    const screenshot = await executeScreenshot(
      `${id}_after_${tool}`,
      {
        pid: managed.pid,
        windowId: managed.windowId,
        launchId: managed.launchId,
      },
      undefined,
      undefined,
      context,
    );
    const screenshotText =
      screenshot.content.find((part) => part.type === "text")?.text ??
      `${screenshotFallbackText} for ${managed.appName} (${managed.windowTitle}).`;
    return {
      ...screenshot,
      content: [
        {
          type: "text",
          text: `${screenshotFallbackText} ${screenshotText}`,
        },
        ...screenshot.content.filter((part) => part.type !== "text"),
      ],
      details: {
        ...(typeof screenshot.details === "object" && screenshot.details !== null
          ? screenshot.details
          : {}),
        tool,
        appName: managed.appName,
        launchId: managed.launchId,
        pid: managed.pid,
        windowId: managed.windowId,
        windowTitle: managed.windowTitle,
        attached: true,
      },
    } satisfies AgentToolResult<unknown>;
  } catch {
    return {
      content: [{ type: "text", text: screenshotFallbackText }],
      details: {
        tool,
        appName: managed.appName,
        launchId: managed.launchId,
        pid: managed.pid,
        windowId: managed.windowId,
        windowTitle: managed.windowTitle,
        attached: true,
      },
    } satisfies AgentToolResult<unknown>;
  }
}

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
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional target process id." },
      windowId: { type: "number", description: "Optional target window id." },
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
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional target process id." },
      windowId: { type: "number", description: "Optional target window id." },
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
    description:
      "Launch an installed Windows desktop app, restore/focus its window when possible, and optionally resize it before using screenshot or actions.",
    inputSchema: objectSchema({
      app: { type: "string", description: "App name, such as Calculator or Visual Studio Code." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      width: { type: "number", description: "Optional target window width in screen pixels." },
      height: { type: "number", description: "Optional target window height in screen pixels." },
    }),
  },
  {
    name: "attach_app",
    description:
      "Attach to a running desktop app window by app, launchId, pid, windowId, or window title.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
      x: { type: "number", description: "Optional target window x coordinate in screen coordinates." },
      y: { type: "number", description: "Optional target window y coordinate in screen coordinates." },
      width: { type: "number", description: "Optional target window width in screen pixels." },
      height: { type: "number", description: "Optional target window height in screen pixels." },
    }),
  },
  {
    name: "focus_app",
    description: "Attach and bring an existing desktop app window to the foreground.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
    }),
  },
  {
    name: "move_window",
    description: "Move an attached desktop app window.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
      x: { type: "number", description: "Target x coordinate in screen pixels." },
      y: { type: "number", description: "Target y coordinate in screen pixels." },
    }),
  },
  {
    name: "resize_window",
    description: "Resize an attached desktop app window.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
      width: { type: "number", description: "Target width in screen pixels." },
      height: { type: "number", description: "Target height in screen pixels." },
    }),
  },
  {
    name: "close_window",
    description: "Close a desktop app window.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
    }),
  },
  {
    name: "active_window",
    description: "Get the currently active desktop app window from T3 context.",
    inputSchema: objectSchema({}),
  },
  {
    name: "window_bounds",
    description:
      "Get window bounds for a desktop app or window id; useful before move/resize coordination.",
    inputSchema: objectSchema({
      app: { type: "string", description: "Optional running app name." },
      launchId: { type: "string", description: "Optional Windows StartApps AppID." },
      pid: { type: "number", description: "Optional process id." },
      windowId: { type: "number", description: "Optional window id." },
      windowTitle: { type: "string", description: "Optional window title or partial title." },
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
    description:
      "Scroll at window-relative screenshot coordinates. This uses real/global input; set allowGlobalInput true only after the user explicitly approves mouse or keyboard fallback.",
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
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: JsonRpcRequest["id"], message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function writeMessage(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
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
        const launchId = stringArg(args, "launchId");
        if (!appName && !launchId) throw error;
        const launched = await launchComputerUseApp({ appName, launchId });
        await delay(1_200);
        return executeScreenshot(
          `${id}_after_launch`,
          { ...args, ...targetInputForLaunchedApp(launched) },
          undefined,
          undefined,
          context,
        );
      }
    case "observe_app": {
      await assertComputerUseAppAllowed(args);
      let screenshot: AgentToolResult<unknown> | null = null;
      if (stringArg(args, "app") || stringArg(args, "launchId") || stringArg(args, "windowTitle")) {
        try {
          screenshot = await executeScreenshot(id, args, undefined, undefined, context);
        } catch (error) {
          const appName = stringArg(args, "app");
          const launchId = stringArg(args, "launchId");
          if (!appName && !launchId) throw error;
          const launched = await launchComputerUseApp({ appName, launchId });
          await delay(1_200);
          screenshot = await executeScreenshot(
            `${id}_after_launch`,
            { ...args, ...targetInputForLaunchedApp(launched) },
            undefined,
            undefined,
            context,
          );
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
      const screenshotText = screenshot?.content
        .filter(
          (part): part is Extract<ToolContentPart, { type: "text" }> => part.type === "text",
        )
        .map((part) => part.text)
        .filter((part) => part.length > 0)
        .join("\n\n");
      const screenshotImageParts = screenshot?.content?.filter((part): part is ToolContentPart =>
        ["image", "image_view"].includes(part.type),
      );
      const screenshotDetails =
        screenshot && typeof screenshot.details === "object" && screenshot.details !== null
          ? screenshot.details
          : null;
      const mergedText = [screenshotText, text].filter((part) => Boolean(part)).join("\n\n");
      return {
        content: [
          { type: "text", text: mergedText },
          ...(screenshotImageParts ?? []),
        ],
        details: {
          tool: "observe_app",
          ...(screenshotDetails ? screenshotDetails : {}),
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
      const launched = await launchComputerUseApp({
        appName,
        launchId,
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
      });
      try {
        const screenshot = await executeScreenshot(
          `${id}_after_launch`,
          targetInputForLaunchedApp(launched),
          undefined,
          undefined,
          context,
        );
        const screenshotText =
          screenshot.content.find((part) => part.type === "text")?.text ??
          `Attached to ${launched.appName}.`;
        return {
          ...screenshot,
          content: [
            {
              type: "text",
              text: `Launched ${launched.appName}. ${screenshotText}`,
            },
            ...screenshot.content.filter((part) => part.type !== "text"),
          ],
          details: {
            ...(typeof screenshot.details === "object" && screenshot.details !== null
              ? screenshot.details
              : {}),
            launchId: launched.launchId,
            appName: launched.appName,
            attached: true,
            tool: "launch_app",
          },
        } satisfies AgentToolResult<unknown>;
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Launched ${launched.appName}, but T3 could not yet attach to a controllable window.`,
            },
          ],
          details: {
            tool: "launch_app",
            appName: launched.appName,
            launchId: launched.launchId,
            attached: false,
          },
        } satisfies AgentToolResult<unknown>;
      }
    }
    case "attach_app": {
      await assertComputerUseAppAllowed(args);
      const target = parseComputerUseTargetInput(args);
      const width = parsePositiveInteger(args.width);
      const height = parsePositiveInteger(args.height);
      const x = parseInteger(args.x);
      const y = parseInteger(args.y);
      const managed = await attachComputerUseWindow({
        ...target,
        ...(typeof width === "number" ? { width } : {}),
        ...(typeof height === "number" ? { height } : {}),
        ...(typeof x === "number" ? { x } : {}),
        ...(typeof y === "number" ? { y } : {}),
      });
      return performWindowToolWithOptionalScreenshot(
        id,
        "attach_app",
        managed,
        `Attached to ${managed.appName} (${managed.windowTitle}).`,
      );
    }
    case "focus_app": {
      await assertComputerUseAppAllowed(args);
      const target = parseComputerUseTargetInput(args);
      const managed = await focusComputerUseWindow(target);
      return performWindowToolWithOptionalScreenshot(
        id,
        "focus_app",
        managed,
        `Focused ${managed.appName} (${managed.windowTitle}).`,
      );
    }
    case "move_window": {
      await assertComputerUseAppAllowed(args);
      const target = parseComputerUseTargetInput(args);
      const x = parseInteger(args.x);
      const y = parseInteger(args.y);
      if (typeof x !== "number" || typeof y !== "number") {
        throw new Error("move_window requires x and y numbers.");
      }
      const managed = await moveComputerUseWindow({
        ...target,
        x,
        y,
      });
      return performWindowToolWithOptionalScreenshot(
        id,
        "move_window",
        managed,
        `Moved ${managed.appName} (${managed.windowTitle}) to (${x}, ${y}).`,
      );
    }
    case "resize_window": {
      await assertComputerUseAppAllowed(args);
      const target = parseComputerUseTargetInput(args);
      const width = parsePositiveInteger(args.width);
      const height = parsePositiveInteger(args.height);
      if (typeof width !== "number" || typeof height !== "number") {
        throw new Error("resize_window requires width and height numbers.");
      }
      const managed = await resizeComputerUseWindow({
        ...target,
        width,
        height,
      });
      return performWindowToolWithOptionalScreenshot(
        id,
        "resize_window",
        managed,
        `Resized ${managed.appName} (${managed.windowTitle}) to ${width}x${height}.`,
      );
    }
    case "close_window": {
      await assertComputerUseAppAllowed(args);
      const target = parseComputerUseTargetInput(args);
      const managed = await closeComputerUseWindow(target);
      return {
        content: [
          {
            type: "text",
            text: `Closed ${managed.appName} (${managed.windowTitle}).`,
          },
        ],
        details: {
          tool: "close_window",
          appName: managed.appName,
          launchId: managed.launchId,
          pid: managed.pid,
          windowId: managed.windowId,
          windowTitle: managed.windowTitle,
          attached: false,
          closed: true,
        },
      } satisfies AgentToolResult<unknown>;
    }
    case "active_window": {
      const active = await getActiveComputerUseWindow();
      if (!active) {
        return {
          content: [{ type: "text", text: "No active desktop window was available." }],
          details: { tool: "active_window", attached: false },
        } satisfies AgentToolResult<unknown>;
      }
      return {
        content: [
          {
            type: "text",
            text: `Active window is ${active.appName} (${active.windowTitle}, pid ${active.pid}, window ${active.windowId}).`,
          },
        ],
        details: {
          tool: "active_window",
          appName: active.appName,
          launchId: active.launchId,
          pid: active.pid,
          windowId: active.windowId,
          windowTitle: active.windowTitle,
          focused: active.focused,
          attached: true,
        },
      } satisfies AgentToolResult<unknown>;
    }
    case "window_bounds": {
      const target = parseComputerUseTargetInput(args);
      const bounds = await getComputerUseWindowBounds(target);
      if (!bounds) {
        throw new Error("No matching desktop window could be found for bounds inspection.");
      }
      return {
        content: [
          {
            type: "text",
            text: `Window bounds for ${bounds.appName} (${bounds.windowTitle}): x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}.`,
          },
        ],
        details: {
          tool: "window_bounds",
          appName: bounds.appName,
          launchId: bounds.launchId,
          pid: bounds.pid,
          windowId: bounds.windowId,
          windowTitle: bounds.windowTitle,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isFocused: bounds.isFocused,
          isMinimized: bounds.isMinimized,
          isOnscreen: bounds.isOnscreen,
          isMain: bounds.isMain,
          attached: true,
        },
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

function dispatchJsonRpcBody(bodyText: string): void {
  void (async () => {
    let requestId: JsonRpcRequest["id"] = null;
    try {
      const request = JSON.parse(bodyText) as JsonRpcRequest;
      requestId = request.id ?? null;
      await handleRequest(request);
    } catch (error) {
      writeError(requestId, error instanceof Error ? error.message : String(error));
    }
  })();
}

let inputBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: string | Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  while (inputBuffer.length > 0) {
    const prefix = inputBuffer.slice(0, Math.min(inputBuffer.length, 32)).toString("utf8");
    if (/^Content-Length:/i.test(prefix)) {
      const separatorIndex = inputBuffer.indexOf("\r\n\r\n");
      if (separatorIndex < 0) {
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
      dispatchJsonRpcBody(bodyText);
      continue;
    }

    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex < 0) {
      return;
    }
    const lineText = inputBuffer.slice(0, newlineIndex).toString("utf8").trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (lineText.length === 0) {
      continue;
    }
    dispatchJsonRpcBody(lineText);
  }
});
