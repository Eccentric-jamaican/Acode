#!/usr/bin/env node

import { spawn } from "node:child_process";

const serverDir = new URL("..", import.meta.url);
const watchDesktopServer = process.env.T3CODE_DESKTOP_SERVER_WATCH === "1";

const command =
  process.platform === "win32"
    ? {
        file: "cmd.exe",
        args: watchDesktopServer
          ? ["/d", "/s", "/c", "bun x tsdown --watch --no-clean"]
          : ["/d", "/s", "/c", "bun run src/index.ts"],
      }
    : {
        file: "bun",
        args: watchDesktopServer ? ["x", "tsdown", "--watch", "--no-clean"] : ["run", "src/index.ts"],
      };

const child = spawn(command.file, command.args, {
  cwd: serverDir,
  env: process.env,
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
