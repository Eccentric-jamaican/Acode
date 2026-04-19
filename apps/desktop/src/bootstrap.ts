import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

function resolveBootstrapLogPath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const baseDir = localAppData && localAppData.length > 0 ? localAppData : OS.tmpdir();
  return Path.join(baseDir, "t3-code-bootstrap.log");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function appendBootstrapLog(message: string): void {
  try {
    FS.appendFileSync(resolveBootstrapLogPath(), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Bootstrap logging is best-effort only.
  }
}

appendBootstrapLog(
  `bootstrap entry start pid=${process.pid} execPath=${process.execPath} argv=${JSON.stringify(process.argv)}`,
);

process.on("uncaughtException", (error) => {
  appendBootstrapLog(`uncaught exception ${formatError(error)}`);
});

process.on("unhandledRejection", (reason) => {
  appendBootstrapLog(`unhandled rejection ${formatError(reason)}`);
});

try {
  require("./main.js");
  appendBootstrapLog("main module loaded");
} catch (error) {
  appendBootstrapLog(`main module failed ${formatError(error)}`);
  try {
    const { app, dialog } = require("electron") as typeof import("electron");
    dialog.showErrorBox("A Code failed to start", formatError(error));
    app.quit();
  } catch {
    // Ignore follow-up failures while surfacing bootstrap errors.
  }
  throw error;
}
