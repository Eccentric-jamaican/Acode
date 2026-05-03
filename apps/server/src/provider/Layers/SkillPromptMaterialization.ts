import fs from "node:fs";
import path from "node:path";

import type { ProviderSkillDescriptor } from "@t3tools/contracts";

import { discoverSkillsForCwd } from "./SkillDiscovery.ts";

const MAX_MATERIALIZED_SKILL_CHARS = 90_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillMentionPattern(skillName: string): RegExp {
  const escaped = escapeRegExp(skillName);
  return new RegExp(`(^|\\s)([$/])(?:\\[${escaped}\\]|${escaped})(?=\\s|$)`, "gi");
}

function readSkillMarkdown(skill: ProviderSkillDescriptor): string | null {
  const skillFilePath = path.join(skill.path, "SKILL.md");
  try {
    const raw = fs.readFileSync(skillFilePath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function appendSkillBlock(input: {
  readonly skill: ProviderSkillDescriptor;
  readonly markdown: string;
}): string {
  return [
    `## ${input.skill.name}`,
    `Path: ${input.skill.path}`,
    "",
    "```markdown",
    input.markdown,
    "```",
  ].join("\n");
}

export function materializeSkillMentionsForProvider(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly providerName: "OpenCode" | "Claude";
}): string {
  const skills = discoverSkillsForCwd(input.cwd);
  let prompt = input.prompt;
  const selectedSkills: Array<{ skill: ProviderSkillDescriptor; markdown: string }> = [];

  for (const skill of skills) {
    const pattern = skillMentionPattern(skill.name);
    if (!pattern.test(prompt)) {
      continue;
    }
    pattern.lastIndex = 0;
    prompt = prompt
      .replace(pattern, (fullMatch, prefix: string) => prefix)
      .replace(/[ \t]{2,}/g, " ")
      .trimStart();
    const markdown = readSkillMarkdown(skill);
    if (markdown) {
      selectedSkills.push({ skill, markdown });
    }
  }

  if (selectedSkills.length === 0) {
    return input.prompt;
  }

  const skillBlocks: string[] = [];
  let remainingChars = MAX_MATERIALIZED_SKILL_CHARS;
  for (const selected of selectedSkills) {
    const block = appendSkillBlock(selected);
    if (block.length > remainingChars) {
      continue;
    }
    skillBlocks.push(block);
    remainingChars -= block.length;
  }

  if (skillBlocks.length === 0) {
    return prompt;
  }

  const preface = [
    "T3 resolved the user's local skill mention(s) for this provider turn.",
    `Provider: ${input.providerName}.`,
    "Follow these skill instructions when they apply to the user's request.",
    "If a skill mentions Codex-only built-in tools that are not available in this provider, do not pretend those tools exist; use the provider's available tools or the skill's documented fallback path, and ask only when the skill requires confirmation.",
    "For the imagegen skill, use t3_imagegen image_generate/image_edit if those MCP tools are available. They use the skill's CLI/API fallback and require OPENAI_API_KEY.",
    "",
    "# Local Skill Instructions",
    "",
    ...skillBlocks,
    "",
    "# User Request",
  ].join("\n");

  return prompt.trim().length > 0 ? `${preface}\n\n${prompt.trim()}` : preface;
}
