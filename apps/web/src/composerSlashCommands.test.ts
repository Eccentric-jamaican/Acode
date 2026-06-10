import { describe, expect, it } from "vitest";

import {
  buildBrowserUseComposerPrompt,
  buildSubagentsPrompt,
  getAvailableComposerSlashCommands,
} from "./composerSlashCommands";

describe("getAvailableComposerSlashCommands", () => {
  it("offers the app-level slash menu for opencode", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "opencode",
        supportsFastSlashCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: [],
      }),
    ).toEqual([
      "clear",
      "model",
      "plan",
      "default",
      "review",
      "fork",
      "status",
      "browser",
      "subagents",
    ]);
  });

  it("keeps fast mode codex-only", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "opencode",
        supportsFastSlashCommand: true,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: [],
      }),
    ).not.toContain("fast");
  });

  it("offers browser command through the T3 Browser Use client", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "codex",
        supportsFastSlashCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: [],
      }),
    ).toContain("browser");

    expect(
      getAvailableComposerSlashCommands({
        provider: "opencode",
        supportsFastSlashCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: [],
      }),
    ).toContain("browser");
  });

  it("filters out built-in commands that collide with opencode native slash commands", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "opencode",
        supportsFastSlashCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: ["clear", "status"],
      }),
    ).toEqual(["model", "plan", "default", "review", "fork", "browser", "subagents"]);
  });
});

describe("buildBrowserUseComposerPrompt", () => {
  it("scopes browser work to T3 Browser Use", () => {
    const prompt = buildBrowserUseComposerPrompt("open localhost:3000", {
      projectId: "project-1",
    });

    expect(prompt).toContain("T3 Browser Use");
    expect(prompt).toContain("If a `t3_browser` MCP server is exposed");
    expect(prompt).toContain("Do not use OpenAI Browser Use");
    expect(prompt).not.toContain("`t3_browser` MCP, Playwright");
    expect(prompt).toContain("pathToFileURL");
    expect(prompt).toContain('projectId: "PROJECT_ID"');
    expect(prompt).toContain("Use projectId `project-1`");
    expect(prompt).toContain("Task: open localhost:3000");
  });
});

describe("buildSubagentsPrompt", () => {
  it("adds codex-safe spawn guidance for full-history subagents", () => {
    const prompt = buildSubagentsPrompt("");

    expect(prompt).toContain("Run subagents for different tasks.");
    expect(prompt).toContain("do not specify agent_type, model, or reasoning_effort");
  });

  it("appends the canned guidance after existing text", () => {
    const prompt = buildSubagentsPrompt("Explain this repo.");

    expect(prompt).toContain("Explain this repo.\n\nRun subagents for different tasks.");
  });
});
