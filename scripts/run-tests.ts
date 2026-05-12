#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join } from "node:path";

type TestStep = {
  readonly label: string;
  readonly cwd?: string;
  readonly args: ReadonlyArray<string>;
};

const root = process.cwd();
const bunExecutable = process.execPath;

const steps: ReadonlyArray<TestStep> = [
  { label: "build contracts", args: ["run", "build:contracts"] },
  { label: "contracts tests", cwd: join(root, "packages", "contracts"), args: ["run", "test"] },
  { label: "shared tests", cwd: join(root, "packages", "shared"), args: ["run", "test"] },
  { label: "web tests", cwd: join(root, "apps", "web"), args: ["run", "test"] },
  { label: "desktop tests", cwd: join(root, "apps", "desktop"), args: ["run", "test"] },
  { label: "scripts tests", cwd: join(root, "scripts"), args: ["run", "test"] },
  { label: "server tests", cwd: join(root, "apps", "server"), args: ["run", "test"] },
];

for (const step of steps) {
  console.log(`\n> ${step.label}`);
  const result = spawnSync(bunExecutable, step.args, {
    cwd: step.cwd ?? root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    console.error(`Failed to run ${step.label}:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
