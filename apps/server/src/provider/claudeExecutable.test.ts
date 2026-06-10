import assert from "node:assert/strict";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { it } from "@effect/vitest";

import {
  resolveClaudeCodeExecutablePath,
  resolveClaudeCodeSdkExecutablePath,
} from "./claudeExecutable";

function makeTempClaudeInstall() {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-claude-path-"));
  const binDir = Path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin");
  Fs.mkdirSync(binDir, { recursive: true });
  const executable = Path.join(binDir, "claude.exe");
  Fs.writeFileSync(executable, "");
  Fs.writeFileSync(Path.join(root, "claude.cmd"), "");
  Fs.writeFileSync(Path.join(root, "claude.ps1"), "");
  return { root, executable };
}

it("resolves Windows npm Claude wrappers to the native executable", () => {
  const install = makeTempClaudeInstall();
  try {
    const resolved = resolveClaudeCodeExecutablePath(undefined, {
      PATH: install.root,
      APPDATA: "",
    });

    assert.strictEqual(
      process.platform === "win32" ? resolved : "claude",
      process.platform === "win32" ? install.executable : resolved,
    );
  } finally {
    Fs.rmSync(install.root, { force: true, recursive: true });
  }
});

it("resolves an explicit Windows wrapper path to the native executable", () => {
  const install = makeTempClaudeInstall();
  try {
    const wrapperPath = Path.join(install.root, "claude.cmd");
    const resolved = resolveClaudeCodeExecutablePath(wrapperPath);

    assert.strictEqual(
      process.platform === "win32" ? resolved : wrapperPath,
      process.platform === "win32" ? install.executable : resolved,
    );
  } finally {
    Fs.rmSync(install.root, { force: true, recursive: true });
  }
});

it("uses the resolved native executable for Windows SDK launches", () => {
  const install = makeTempClaudeInstall();
  try {
    const resolved = resolveClaudeCodeSdkExecutablePath(Path.join(install.root, "claude.cmd"));

    assert.strictEqual(
      process.platform === "win32" ? resolved : Path.join(install.root, "claude.cmd"),
      process.platform === "win32" ? install.executable : resolved,
    );
  } finally {
    Fs.rmSync(install.root, { force: true, recursive: true });
  }
});
