import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyComputerUseApp,
  readPersistedComputerUseAppIcon,
  resolveComputerUseAppIconCachePaths,
  writePersistedComputerUseAppIcon,
} from "./computerUseService";

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

describe("classifyComputerUseApp", () => {
  it("keeps user-facing installed apps in the desktop group", () => {
    expect(
      classifyComputerUseApp({
        name: "Notion",
        appId: "win32-app:Notion.Notion_123!App",
        launchId: "Notion.Notion_123!App",
        isRunning: false,
        windowCount: 0,
      }),
    ).toBe("desktop");
    expect(
      classifyComputerUseApp({
        name: "ChatGPT",
        appId: "win32-app:OpenAI.ChatGPT_123!App",
        launchId: "OpenAI.ChatGPT_123!App",
        isRunning: false,
        windowCount: 0,
      }),
    ).toBe("desktop");
    expect(
      classifyComputerUseApp({
        name: "T3 Code",
        appId: "win32-app:com.t3tools.app",
        launchId: "com.t3tools.app",
        isRunning: false,
        windowCount: 0,
      }),
    ).toBe("desktop");
  });

  it("moves Windows utilities out of the desktop group", () => {
    for (const name of [
      "Application Verifier (X64)",
      "Character Map",
      "Command Prompt",
      "Component Services",
      "Computer Management",
    ]) {
      expect(
        classifyComputerUseApp({
          name,
          appId: `win32-app:${name}`,
          launchId: name,
          isRunning: false,
          windowCount: 0,
        }),
      ).toBe("system");
    }
  });

  it("treats helper processes without useful app surfaces as background apps", () => {
    expect(
      classifyComputerUseApp({
        name: "Runtime Broker",
        appId: "win32:runtimebroker:1234",
        isRunning: true,
        windowCount: 0,
      }),
    ).toBe("background");
    expect(
      classifyComputerUseApp({
        name: "Notion Helper",
        appId: "win32:notion-helper:1234",
        isRunning: true,
        windowCount: 0,
      }),
    ).toBe("background");
  });
});

describe("computer use icon cache", () => {
  it("persists cached icon bytes to disk", async () => {
    const stateDir = makeTempDir("t3-computer-icon-cache-");
    const cacheKey = JSON.stringify({
      launchId: "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT",
      name: "chatgpt",
      pid: 0,
    });
    const bytes = Buffer.from("png-bytes");

    await writePersistedComputerUseAppIcon({
      cacheKey,
      bytes,
      stateDir,
    });

    const persisted = await readPersistedComputerUseAppIcon({ cacheKey, stateDir });
    expect(persisted?.equals(bytes)).toBe(true);
  });

  it("persists negative cache entries for missing icons", async () => {
    const stateDir = makeTempDir("t3-computer-icon-cache-");
    const cacheKey = JSON.stringify({
      launchId: "missing-app",
      name: "missing-app",
      pid: 0,
    });

    await writePersistedComputerUseAppIcon({
      cacheKey,
      bytes: null,
      stateDir,
    });

    const persisted = await readPersistedComputerUseAppIcon({ cacheKey, stateDir });
    expect(persisted).toBeNull();
    const paths = resolveComputerUseAppIconCachePaths({ cacheKey, stateDir });
    expect(paths.missPath.endsWith(".miss")).toBe(true);
  });

  it("expires stale negative cache entries so icons can be retried", async () => {
    const stateDir = makeTempDir("t3-computer-icon-cache-");
    const cacheKey = JSON.stringify({
      launchId: "missing-app",
      name: "missing-app",
      pid: 0,
    });

    await writePersistedComputerUseAppIcon({
      cacheKey,
      bytes: null,
      stateDir,
    });

    const paths = resolveComputerUseAppIconCachePaths({ cacheKey, stateDir });
    const staleDate = new Date(Date.now() - 7 * 60 * 60 * 1_000);
    utimesSync(paths.missPath, staleDate, staleDate);

    await expect(readPersistedComputerUseAppIcon({ cacheKey, stateDir })).resolves.toBeUndefined();
  });
});
