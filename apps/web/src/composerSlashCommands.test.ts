import { describe, expect, it } from "vitest";

import { buildSubagentsPrompt, getAvailableComposerSlashCommands } from "./composerSlashCommands";

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

  it("filters out built-in commands that collide with opencode native slash commands", () => {
    expect(
      getAvailableComposerSlashCommands({
        provider: "opencode",
        supportsFastSlashCommand: false,
        canOfferReviewCommand: true,
        canOfferForkCommand: true,
        providerNativeCommandNames: ["clear", "status"],
      }),
    ).toEqual([
      "model",
      "plan",
      "default",
      "review",
      "fork",
      "subagents",
    ]);
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
