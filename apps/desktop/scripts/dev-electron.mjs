import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import waitOn from "wait-on";

import { desktopDir, repoRootDir, resolveElectronPath } from "./electron-launcher.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5733);
const devServerUrl = `http://localhost:${port}`;
const appEntryPath = join(desktopDir, "dist-electron", "bootstrap.js");
const electronPath = resolveElectronPath();
const devRootArg = `--t3code-dev-root=${repoRootDir}`;
const requiredFiles = [
  "dist-electron/bootstrap.js",
  "dist-electron/main.js",
  "dist-electron/preload.js",
  "../server/dist/index.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["bootstrap.js", "main.js", "preload.js"]) },
  { directory: "../server/dist", files: new Set(["index.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const restartDependencyWaitTimeoutMs = 60_000;
const dependencyResources = [`tcp:${port}`, ...requiredFiles.map((filePath) => `file:${filePath}`)];

async function waitForDependencies() {
  await waitOn({
    resources: dependencyResources,
    timeout: restartDependencyWaitTimeoutMs,
  });
}

console.info(
  `[dev-electron] waiting for renderer and build outputs (url=${devServerUrl}, entry=${appEntryPath})`,
);
await waitForDependencies();
console.info(`[dev-electron] dependencies ready; launching Electron from ${electronPath}`);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function killChildTreeByPid(pid) {
  if (typeof pid !== "number") {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  const signal = "TERM";
  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  if (process.platform === "win32") {
    // Remove orphaned dev Electron instances from previous runs.
    const escapedDesktopDir = desktopDir.replaceAll("'", "''");
    const script = [
      `$target = '--t3code-dev-root=${escapedDesktopDir}'`,
      "Get-CimInstance Win32_Process |",
      "  Where-Object { $_.CommandLine -and $_.CommandLine -like \"*$target*\" } |",
      "  ForEach-Object {",
      "    try {",
      "      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop",
      "    } catch {",
      "      # best effort cleanup only",
      "    }",
      "  }",
    ].join("\n");
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
    });
    return;
  }

  spawnSync("pkill", ["-f", "--", devRootArg], { stdio: "ignore" });
}

async function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  try {
    await waitForDependencies();
  } catch (error) {
    console.error(
      `[dev-electron] dependencies not ready before spawn: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!shuttingDown) {
      scheduleRestart();
    }
    return;
  }

  if (shuttingDown || currentApp !== null) {
    return;
  }

  const app = spawn(electronPath, [devRootArg, appEntryPath], {
    cwd: desktopDir,
    env: {
      ...childEnv,
      VITE_DEV_SERVER_URL: devServerUrl,
    },
    stdio: "inherit",
  });

  currentApp = app;
  console.info(`[dev-electron] spawned electron pid=${app.pid ?? "unknown"}`);

  app.once("error", (error) => {
    console.error(`[dev-electron] spawn error: ${error instanceof Error ? error.message : String(error)}`);
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    console.info(
      `[dev-electron] electron exited pid=${app.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown && !expectedExits.has(app)) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    if (process.platform === "win32") {
      killChildTreeByPid(app.pid);
    } else {
      app.kill("SIGTERM");
      killChildTreeByPid(app.pid);
    }

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      killChildTreeByPid(app.pid);
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          await startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = watch(join(desktopDir, directory), { persistent: true }, (_eventType, filename) => {
      if (typeof filename !== "string" || !files.has(filename)) {
        return;
      }

      scheduleRestart();
    });

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (process.platform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], { stdio: "ignore" });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
void startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
