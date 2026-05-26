import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveOpenCodeBinaryPath,
  resolveOpenCodeMcpWrapperPath,
  resolveOpenCodeProcessLaunch,
  waitForOpenCodeHttpReady,
} from "./opencodeRuntime";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOpenCodeMcpWrapperPath", () => {
  it("writes a reusable Windows launcher script for Electron-hosted MCP servers", () => {
    const stateDir = makeTempDir("t3-opencode-wrapper-");
    const wrapperPath = resolveOpenCodeMcpWrapperPath({
      stateDir,
      wrapperName: "t3-computer",
      scriptPath: "C:\\Program Files\\T3\\computerMcpServer.mjs",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_STATE_DIR: "C:\\Users\\Addis\\.t3-mine\\userdata",
      },
    });

    expect(wrapperPath.endsWith(".cmd")).toBe(true);
    const contents = readFileSync(wrapperPath, "utf8");
    expect(contents).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(contents).toContain('set "T3CODE_STATE_DIR=C:\\Users\\Addis\\.t3-mine\\userdata"');
    expect(contents).toContain('"C:\\Program Files\\T3\\computerMcpServer.mjs"');
    expect(contents).toContain(`"${process.execPath}"`);
  });
});

describe("resolveOpenCodeProcessLaunch", () => {
  it("launches Windows batch shims through a quoted cmd call", () => {
    const launch = resolveOpenCodeProcessLaunch({
      binaryPath: "C:\\Users\\First Last\\AppData\\Roaming\\npm\\opencode.cmd",
      args: ["serve", "--hostname=127.0.0.1", "--port=65004"],
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(launch).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        'call "C:\\Users\\First Last\\AppData\\Roaming\\npm\\opencode.cmd" "serve" "--hostname=127.0.0.1" "--port=65004"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("launches non-batch commands without cmd", () => {
    const launch = resolveOpenCodeProcessLaunch({
      binaryPath: "C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
      args: ["--version"],
      platform: "win32",
    });

    expect(launch).toEqual({
      command:
        "C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
      args: ["--version"],
    });
  });
});

describe("resolveOpenCodeBinaryPath", () => {
  const itOnWindows = process.platform === "win32" ? it : it.skip;

  itOnWindows("prefers an adjacent Windows batch shim for extensionless npm commands", () => {
    const npmBinDir = makeTempDir("t3-opencode-bin-");
    const shimPath = path.join(npmBinDir, "opencode");
    const cmdPath = `${shimPath}.cmd`;
    writeFileSync(shimPath, "#!/bin/sh\n", "utf8");
    writeFileSync(cmdPath, "@echo off\r\n", "utf8");

    expect(resolveOpenCodeBinaryPath(shimPath)).toBe(cmdPath);
  });

  itOnWindows("resolves an extensionless npm POSIX shim to the target Windows executable", () => {
    const npmBinDir = makeTempDir("t3-opencode-bin-");
    const shimPath = path.join(npmBinDir, "opencode");
    const exeDir = path.join(npmBinDir, "node_modules", "opencode-ai", "bin");
    const exePath = path.join(exeDir, "opencode.exe");
    mkdirSync(exeDir, { recursive: true });
    writeFileSync(
      shimPath,
      [
        "#!/bin/sh",
        'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
        'exec "$basedir/node_modules/opencode-ai/bin/opencode.exe" "$@"',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(exePath, "", "utf8");

    expect(resolveOpenCodeBinaryPath(shimPath)).toBe(exePath);
  });
});

describe("waitForOpenCodeHttpReady", () => {
  it("uses the cheap app endpoint instead of waiting on provider inventory", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/provider") {
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 test server address.");
      }
      await expect(
        waitForOpenCodeHttpReady({
          url: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
          startedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
