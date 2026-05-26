import { spawnSync } from "node:child_process";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  console.log("Skipping effect-language-service patch in CI.");
  process.exit(0);
}

const command = process.platform === "win32" ? "effect-language-service.cmd" : "effect-language-service";
const result = spawnSync(command, ["patch"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.warn(`Skipping effect-language-service patch: ${result.error.message}`);
  process.exit(0);
}

if (result.status !== 0) {
  console.warn(`Skipping effect-language-service patch: command exited with ${result.status ?? "unknown status"}.`);
  process.exit(0);
}

process.exit(0);
