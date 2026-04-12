import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderSkillDescriptor } from "@t3tools/contracts";

const MAX_SCAN_DEPTH = 4;
const MAX_SKILLS = 200;

function readFirstSummaryLine(skillFilePath: string): {
  displayName?: string;
  shortDescription?: string;
} {
  try {
    const raw = fs.readFileSync(skillFilePath, "utf8");
    const lines = raw.split(/\r?\n/);
    let displayName: string | undefined;
    let shortDescription: string | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!displayName) {
        const heading = /^#\s+(.+)$/.exec(trimmed);
        if (heading?.[1]) {
          displayName = heading[1].trim();
          continue;
        }
      }
      if (!trimmed.startsWith("#")) {
        shortDescription = trimmed.slice(0, 200);
        break;
      }
    }
    return {
      ...(displayName ? { displayName } : {}),
      ...(shortDescription ? { shortDescription } : {}),
    };
  } catch {
    return {};
  }
}

function collectSkillFiles(rootDir: string, depth = 0, output: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_SKILLS) {
    return output;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (output.length >= MAX_SKILLS) break;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      output.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      collectSkillFiles(entryPath, depth + 1, output);
    }
  }
  return output;
}

function toSkillDescriptor(skillFilePath: string, scope: "workspace" | "personal"): ProviderSkillDescriptor {
  const skillDir = path.dirname(skillFilePath);
  const skillName = path.basename(skillDir);
  const ui = readFirstSummaryLine(skillFilePath);
  const description = ui.shortDescription;
  return {
    name: skillName,
    ...(description ? { description } : {}),
    path: skillDir,
    enabled: true,
    scope,
    ...(ui.displayName || ui.shortDescription
      ? {
          interface: {
            ...(ui.displayName ? { displayName: ui.displayName } : {}),
            ...(ui.shortDescription ? { shortDescription: ui.shortDescription } : {}),
          },
        }
      : {}),
  };
}

function normalizePathKey(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function discoverSkillsForCwd(cwd: string): ProviderSkillDescriptor[] {
  const workspaceSkillsRoot = path.resolve(cwd, ".agents", "skills");
  const homeSkillsRoot = path.resolve(os.homedir(), ".codex", "skills");
  const workspaceSkillFiles = collectSkillFiles(workspaceSkillsRoot).map((skillPath) =>
    toSkillDescriptor(skillPath, "workspace"),
  );
  const personalSkillFiles = collectSkillFiles(homeSkillsRoot).map((skillPath) =>
    toSkillDescriptor(skillPath, "personal"),
  );
  const deduped = new Map<string, ProviderSkillDescriptor>();
  for (const skill of [...workspaceSkillFiles, ...personalSkillFiles]) {
    const key = normalizePathKey(skill.path);
    if (!deduped.has(key)) {
      deduped.set(key, skill);
    }
  }
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}
