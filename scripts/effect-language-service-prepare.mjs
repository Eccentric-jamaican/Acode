import { spawnSync } from "node:child_process";

if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  console.log("Skipping effect-language-service patch in CI.");
  process.exit(0);
}

const command = process.platform === "win32" ? "effect-language-service.cmd" : "effect-language-service";
const result = spawnSync(command, ["patch"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
