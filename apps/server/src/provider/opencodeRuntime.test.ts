import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOpenCodeMcpWrapperPath } from "./opencodeRuntime";

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
