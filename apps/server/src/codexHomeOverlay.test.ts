import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexHomeOverlay, shouldCopyCodexHomeEntry } from "./codexHomeOverlay";

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];

function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createCodexHomeOverlay", () => {
  it("skips Codex plugin cache latest pointers when copying the base home", () => {
    const baseHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));
    const latestPath = path.join(
      baseHomePath,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
      "latest",
    );
    const versionPath = path.join(
      baseHomePath,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
      "0.1.7",
    );
    mkdirSync(latestPath, { recursive: true });
    mkdirSync(versionPath, { recursive: true });

    expect(shouldCopyCodexHomeEntry(latestPath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(versionPath, baseHomePath)).toBe(true);
  });

  it("skips volatile Codex home state when copying the base home", () => {
    const baseHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));
    const configPath = path.join(baseHomePath, "config.toml");
    const sessionPath = path.join(
      baseHomePath,
      "sessions",
      "2026",
      "05",
      "13",
      "rollout.jsonl",
    );
    const stateDbPath = path.join(baseHomePath, "state_5.sqlite-wal");
    const logsDbPath = path.join(baseHomePath, "logs_2.sqlite");
    const globalStatePath = path.join(baseHomePath, ".codex-global-state.json");
    const globalStateTempPath = path.join(
      baseHomePath,
      "..codex-global-state.json.tmp-1776994806766-da4a5f84",
    );
    const modelsCachePath = path.join(baseHomePath, "models_cache.json");
    const tmpPluginPath = path.join(baseHomePath, ".tmp", "plugins", "cache.json");
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    mkdirSync(path.dirname(tmpPluginPath), { recursive: true });
    writeFileSync(configPath, "", "utf8");
    writeFileSync(sessionPath, "", "utf8");
    writeFileSync(stateDbPath, "", "utf8");
    writeFileSync(logsDbPath, "", "utf8");
    writeFileSync(globalStatePath, "", "utf8");
    writeFileSync(globalStateTempPath, "", "utf8");
    writeFileSync(modelsCachePath, "", "utf8");
    writeFileSync(tmpPluginPath, "", "utf8");

    expect(shouldCopyCodexHomeEntry(configPath, baseHomePath)).toBe(true);
    expect(shouldCopyCodexHomeEntry(sessionPath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(stateDbPath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(logsDbPath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(globalStatePath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(globalStateTempPath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(modelsCachePath, baseHomePath)).toBe(false);
    expect(shouldCopyCodexHomeEntry(tmpPluginPath, baseHomePath)).toBe(false);
  });

  it("creates a T3 Computer Use overlay outside full-access mode without browser MCP", () => {
    const stateDir = trackTempDir(makeTempDir("t3-codex-overlay-state-"));
    const preferredHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));

    const overlayPath = createCodexHomeOverlay({
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      runtimeMode: "approval-required",
      stateDir,
      preferredHomePath,
      bridgeUrl: "http://127.0.0.1:4123/rpc",
      bridgeToken: "secret",
    });

    expect(overlayPath).toBeTruthy();
    expect(overlayPath).not.toBe(preferredHomePath);
    const configToml = readFileSync(path.join(overlayPath!, "config.toml"), "utf8");
    expect(configToml).toContain("[mcp_servers.t3_computer]");
    expect(configToml).not.toContain("[mcp_servers.t3_browser]");
    expect(configToml).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(configToml).toContain(`cwd = "${process.cwd().replace(/\\/g, "\\\\")}"`);
    expect(configToml).toContain("required = true");
    expect(configToml).toContain(`T3CODE_STATE_DIR = "${stateDir.replace(/\\/g, "\\\\")}"`);
  });

  it("still creates a T3 Computer Use overlay when the browser bridge is unavailable", () => {
    const stateDir = trackTempDir(makeTempDir("t3-codex-overlay-state-"));
    const preferredHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));

    const overlayPath = createCodexHomeOverlay({
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      runtimeMode: "full-access",
      stateDir,
      preferredHomePath,
    });

    expect(overlayPath).toBeTruthy();
    expect(overlayPath).not.toBe(preferredHomePath);
    const configToml = readFileSync(path.join(overlayPath!, "config.toml"), "utf8");
    expect(configToml).not.toContain("[mcp_servers.t3_browser]");
    expect(configToml).toContain("[mcp_servers.t3_computer]");
    expect(configToml).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(configToml).toContain(`T3CODE_STATE_DIR = "${stateDir.replace(/\\/g, "\\\\")}"`);
  });

  it("copies the base codex home and appends the t3 browser MCP entry", () => {
    const stateDir = trackTempDir(makeTempDir("t3-codex-overlay-state-"));
    const baseHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));
    mkdirSync(path.join(baseHomePath, "nested"), { recursive: true });
    writeFileSync(
      path.join(baseHomePath, "config.toml"),
      ["[profiles.default]", 'model = "gpt-5.4"'].join("\n"),
      "utf8",
    );
    writeFileSync(path.join(baseHomePath, "nested", "keep.txt"), "preserve me", "utf8");

    const overlayPath = createCodexHomeOverlay({
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      runtimeMode: "full-access",
      stateDir,
      preferredHomePath: baseHomePath,
      bridgeUrl: "http://127.0.0.1:4123/rpc",
      bridgeToken: "secret-token",
    });

    expect(overlayPath).toBeTruthy();
    expect(overlayPath).not.toBe(baseHomePath);

    const configToml = readFileSync(path.join(overlayPath!, "config.toml"), "utf8");
    expect(configToml).toContain('[profiles.default]\nmodel = "gpt-5.4"');
    expect(configToml).toContain("[mcp_servers.t3_browser]");
    expect(configToml).toContain("[mcp_servers.t3_computer]");
    expect(configToml).toContain('command = "');
    expect(configToml).toContain('args = ["');
    expect(configToml).toContain(`cwd = "${process.cwd().replace(/\\/g, "\\\\")}"`);
    expect(configToml).toContain("required = true");
    expect(configToml).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(configToml).toContain('T3_BROWSER_BRIDGE_URL = "http://127.0.0.1:4123/rpc"');
    expect(configToml).toContain('T3_BROWSER_BRIDGE_TOKEN = "secret-token"');
    expect(configToml).toContain('T3_BROWSER_PROJECT_ID = "project-1"');
    expect(configToml).toContain('T3_BROWSER_THREAD_ID = "thread-1"');
    expect(configToml).toContain('T3_COMPUTER_THREAD_ID = "thread-1"');
    expect(readFileSync(path.join(overlayPath!, "nested", "keep.txt"), "utf8")).toBe("preserve me");
  });

  it("does not copy volatile Codex home entries into the overlay", () => {
    const stateDir = trackTempDir(makeTempDir("t3-codex-overlay-state-"));
    const baseHomePath = trackTempDir(makeTempDir("t3-codex-overlay-home-"));
    mkdirSync(path.join(baseHomePath, ".tmp", "plugins"), { recursive: true });
    mkdirSync(path.join(baseHomePath, "sessions", "2026"), { recursive: true });
    writeFileSync(path.join(baseHomePath, "config.toml"), 'model = "gpt-5.4"', "utf8");
    writeFileSync(path.join(baseHomePath, ".tmp", "plugins", "cache.json"), "skip", "utf8");
    writeFileSync(path.join(baseHomePath, "sessions", "2026", "thread.jsonl"), "skip", "utf8");
    writeFileSync(path.join(baseHomePath, "logs_2.sqlite"), "skip", "utf8");
    writeFileSync(path.join(baseHomePath, "logs_2.sqlite-wal"), "skip", "utf8");
    writeFileSync(path.join(baseHomePath, "state_5.sqlite"), "skip", "utf8");
    writeFileSync(path.join(baseHomePath, ".codex-global-state.json"), "skip", "utf8");
    writeFileSync(
      path.join(baseHomePath, "..codex-global-state.json.tmp-1776994806766-da4a5f84"),
      "skip",
      "utf8",
    );

    const overlayPath = createCodexHomeOverlay({
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      runtimeMode: "full-access",
      stateDir,
      preferredHomePath: baseHomePath,
    });

    expect(overlayPath).toBeTruthy();
    expect(readFileSync(path.join(overlayPath!, "config.toml"), "utf8")).toContain(
      'model = "gpt-5.4"',
    );
    expect(() => readFileSync(path.join(overlayPath!, ".tmp", "plugins", "cache.json"), "utf8"))
      .toThrow();
    expect(() => readFileSync(path.join(overlayPath!, "sessions", "2026", "thread.jsonl"), "utf8"))
      .toThrow();
    expect(() => readFileSync(path.join(overlayPath!, "logs_2.sqlite"), "utf8")).toThrow();
    expect(() => readFileSync(path.join(overlayPath!, "logs_2.sqlite-wal"), "utf8")).toThrow();
    expect(() => readFileSync(path.join(overlayPath!, "state_5.sqlite"), "utf8")).toThrow();
    expect(() => readFileSync(path.join(overlayPath!, ".codex-global-state.json"), "utf8"))
      .toThrow();
    expect(() =>
      readFileSync(
        path.join(overlayPath!, "..codex-global-state.json.tmp-1776994806766-da4a5f84"),
        "utf8",
      ),
    ).toThrow();
  });
});
