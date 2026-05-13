import { describe, expect, it } from "vitest";

import { classifyComputerUseApp } from "./computerUseService";

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
