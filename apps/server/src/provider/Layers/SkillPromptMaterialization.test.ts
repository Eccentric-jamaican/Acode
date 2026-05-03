import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeSkillMentionsForProvider } from "./SkillPromptMaterialization.ts";

const tempDirs: string[] = [];

function makeSkillWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-skill-materialization-"));
  tempDirs.push(cwd);
  const skillDir = path.join(cwd, ".agents", "skills", "imagegen");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      'name: "imagegen"',
      'description: "Generate images"',
      "---",
      "",
      "# Image Generation Skill",
      "",
      "Use image generation when a raster asset is required.",
    ].join("\n"),
  );
  return cwd;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("materializeSkillMentionsForProvider", () => {
  it("injects selected skill markdown and removes plain skill token", () => {
    const cwd = makeSkillWorkspace();
    const prompt = materializeSkillMentionsForProvider({
      cwd,
      prompt: "$imagegen make a hero image",
      providerName: "OpenCode",
    });

    expect(prompt).toContain("Provider: OpenCode.");
    expect(prompt).toContain("# Local Skill Instructions");
    expect(prompt).toContain("## imagegen");
    expect(prompt).toContain("# Image Generation Skill");
    expect(prompt).toContain("# User Request\n\nmake a hero image");
    expect(prompt).not.toContain("$imagegen make");
  });

  it("supports bracketed skill tokens", () => {
    const cwd = makeSkillWorkspace();
    const prompt = materializeSkillMentionsForProvider({
      cwd,
      prompt: "$[imagegen] make an icon",
      providerName: "Claude",
    });

    expect(prompt).toContain("Provider: Claude.");
    expect(prompt).toContain("# User Request\n\nmake an icon");
  });
});
