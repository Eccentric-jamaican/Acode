#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: run-vitest <vitest arguments>");
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const patchPath = path.resolve(__dirname, "patch-net-use.cjs");
const vitestCli = path.resolve(projectRoot, "node_modules", "vitest", "vitest.mjs");

const vitestArgs = [vitestCli, ...args];

const alreadyHasPool = args.includes("--pool");
const alreadyHasNoFileParallelism = args.includes("--no-file-parallelism");

if (!alreadyHasPool) {
  vitestArgs.push("--pool", "threads");
}
if (!alreadyHasNoFileParallelism) {
  vitestArgs.push("--no-file-parallelism");
}

const command = process.platform === "win32" ? "node" : "node";
const commandArgs = ["-r", patchPath, ...vitestArgs];

const result = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Failed to run Vitest via ${command}:`, result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
