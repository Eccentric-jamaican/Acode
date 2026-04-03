import { describe, expect, it } from "vitest";

import {
  buildOpencodePromptAsyncBody,
  opencodeAgentForInteractionMode,
} from "./OpencodeTurnMapping.ts";

describe("opencodeAgentForInteractionMode", () => {
  it("maps plan interaction mode to plan agent", () => {
    expect(opencodeAgentForInteractionMode("plan")).toBe("plan");
  });

  it("maps default interaction mode to build agent", () => {
    expect(opencodeAgentForInteractionMode("default")).toBe("build");
  });

  it("omits agent when interaction mode is not provided", () => {
    expect(opencodeAgentForInteractionMode(undefined)).toBeUndefined();
  });
});

describe("buildOpencodePromptAsyncBody", () => {
  const baseParts = [{ type: "text", text: "hello" }] as const;

  it("includes plan agent when interaction mode is plan", () => {
    expect(
      buildOpencodePromptAsyncBody({
        providerID: "opencode-go",
        modelID: "kimi-k2.5",
        parts: baseParts,
        interactionMode: "plan",
      }),
    ).toEqual({
      model: { providerID: "opencode-go", modelID: "kimi-k2.5" },
      parts: baseParts,
      agent: "plan",
    });
  });

  it("includes build agent when interaction mode is default", () => {
    expect(
      buildOpencodePromptAsyncBody({
        providerID: "opencode-go",
        modelID: "kimi-k2.5",
        parts: baseParts,
        interactionMode: "default",
      }),
    ).toEqual({
      model: { providerID: "opencode-go", modelID: "kimi-k2.5" },
      parts: baseParts,
      agent: "build",
    });
  });

  it("omits agent when interaction mode is undefined", () => {
    expect(
      buildOpencodePromptAsyncBody({
        providerID: "opencode-go",
        modelID: "kimi-k2.5",
        parts: baseParts,
      }),
    ).toEqual({
      model: { providerID: "opencode-go", modelID: "kimi-k2.5" },
      parts: baseParts,
    });
  });
});
