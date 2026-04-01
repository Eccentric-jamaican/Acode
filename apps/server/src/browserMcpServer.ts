import { stdin, stdout } from "node:process";

import type { ProjectId } from "@t3tools/contracts";

import { DesktopBrowserClient } from "./browserDesktopClient";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
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

function readDefaultProjectId(): ProjectId | undefined {
  const value = process.env.T3_BROWSER_PROJECT_ID?.trim();
  if (!value) {
    return undefined;
  }
  return value as ProjectId;
}

const defaultProjectId = readDefaultProjectId();
const client = new DesktopBrowserClient({
  bridgeUrl: process.env.T3_BROWSER_BRIDGE_URL ?? "",
  authToken: process.env.T3_BROWSER_BRIDGE_TOKEN ?? "",
  ...(defaultProjectId ? { defaultProjectId } : {}),
});

const TOOL_DEFINITIONS = [
  {
    name: "browser_ensure",
    description: "Ensure the project browser exists and return its current state.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "browser_show",
    description: "Ask the desktop app to show the project browser pane.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "browser_kill",
    description: "Kill the project browser instance.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "browser_new_tab",
    description: "Create a new browser tab and make it active.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        url: { type: "string" },
      },
    },
  },
  {
    name: "browser_activate_tab",
    description: "Activate a browser tab by tab id.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      properties: {
        projectId: { type: "string" },
        tabId: { type: "string" },
      },
    },
  },
  {
    name: "browser_close_tab",
    description: "Close a browser tab by tab id.",
    inputSchema: {
      type: "object",
      required: ["tabId"],
      properties: {
        projectId: { type: "string" },
        tabId: { type: "string" },
      },
    },
  },
  {
    name: "browser_list_tabs",
    description: "List browser tabs and return the active tab id.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
      },
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate the project browser to a URL.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        projectId: { type: "string" },
        url: { type: "string" },
      },
    },
  },
  {
    name: "browser_back",
    description: "Navigate backward in the project browser history.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "browser_forward",
    description: "Navigate forward in the project browser history.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "browser_reload",
    description: "Reload the current page.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "browser_snapshot",
    description: "Return a text and HTML snapshot of the current page.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot of the current page as a data URL.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "browser_wait_for",
    description: "Wait for a selector or text to appear on the page.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_click",
    description: "Click the element matching a CSS selector.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        projectId: { type: "string" },
        selector: { type: "string" },
      },
    },
  },
  {
    name: "browser_hover",
    description: "Hover the element matching a CSS selector.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        projectId: { type: "string" },
        selector: { type: "string" },
      },
    },
  },
  {
    name: "browser_fill",
    description: "Replace the value of an input matching a CSS selector.",
    inputSchema: {
      type: "object",
      required: ["selector", "value"],
      properties: {
        projectId: { type: "string" },
        selector: { type: "string" },
        value: { type: "string" },
      },
    },
  },
  {
    name: "browser_type_text",
    description: "Append text into an input matching a CSS selector.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        projectId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "browser_press_key",
    description: "Send a key press to the page.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        projectId: { type: "string" },
        key: { type: "string" },
      },
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the page context.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: {
        projectId: { type: "string" },
        expression: { type: "string" },
      },
    },
  },
] as const;

async function callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  switch (name) {
    case "browser_ensure":
      return client.call("browser.ensure", args);
    case "browser_show":
      return client.call("browser.show", args);
    case "browser_kill":
      return client.call("browser.kill", args);
    case "browser_new_tab":
      return client.call("browser.new_tab", args);
    case "browser_activate_tab":
      return client.call("browser.activate_tab", args);
    case "browser_close_tab":
      return client.call("browser.close_tab", args);
    case "browser_list_tabs":
      return client.call("browser.list_tabs", args);
    case "browser_navigate":
      return client.call("browser.navigate", args);
    case "browser_back":
      return client.call("browser.back", args);
    case "browser_forward":
      return client.call("browser.forward", args);
    case "browser_reload":
      return client.call("browser.reload", args);
    case "browser_snapshot":
      return client.call("browser.snapshot", args);
    case "browser_screenshot":
      return client.call("browser.screenshot", args);
    case "browser_wait_for":
      return client.call("browser.wait_for", args);
    case "browser_click":
      return client.call("browser.click", args);
    case "browser_hover":
      return client.call("browser.hover", args);
    case "browser_fill":
      return client.call("browser.fill", args);
    case "browser_type_text":
      return client.call("browser.type_text", args);
    case "browser_press_key":
      return client.call("browser.press_key", args);
    case "browser_evaluate":
      return client.call("browser.evaluate", args);
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
            name: "t3-browser",
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
