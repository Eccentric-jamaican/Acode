// This file mostly exists because we want dev mode to say "T3 Code (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_DESKTOP_APP_ID, getAppDisplayName } from "@t3tools/shared/branding";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = getAppDisplayName(isDevelopment);
const APP_BUNDLE_ID = APP_DESKTOP_APP_ID;
const LAUNCHER_VERSION = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");
export const repoRootDir = resolve(desktopDir, "..", "..");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${APP_BUNDLE_ID}.helper.${helperIdSuffix}`
      : `${APP_BUNDLE_ID}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function ensureDirectory(path) {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

function escapePowerShellSingleQuoted(value) {
  return value.replaceAll("'", "''");
}

function ensureWindowsShortcut(targetBinaryPath, iconPath) {
  const appData = process.env.APPDATA;
  if (!appData) {
    return;
  }

  const shortcutPath = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", `${APP_DISPLAY_NAME}.lnk`);
  const workingDirectory = dirname(targetBinaryPath);
  const resolvedIconPath = existsSync(iconPath) ? iconPath : targetBinaryPath;
  ensureDirectory(dirname(shortcutPath));

  const script = [
    `$shortcutPath = '${escapePowerShellSingleQuoted(shortcutPath)}'`,
    `$targetPath = '${escapePowerShellSingleQuoted(targetBinaryPath)}'`,
    `$workingDirectory = '${escapePowerShellSingleQuoted(workingDirectory)}'`,
    `$iconPath = '${escapePowerShellSingleQuoted(resolvedIconPath)}'`,
    `$description = '${escapePowerShellSingleQuoted(APP_DISPLAY_NAME)}'`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($shortcutPath)",
    "$shortcut.TargetPath = $targetPath",
    "$shortcut.WorkingDirectory = $workingDirectory",
    '$shortcut.Arguments = ""',
    '$shortcut.IconLocation = "$iconPath,0"',
    "$shortcut.Description = $description",
    "$shortcut.Save()",
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to create Windows launcher shortcut: ${result.stderr || result.stdout || "unknown error"}`.trim(),
    );
  }
}

function buildWindowsLauncher(electronBinaryPath) {
  const sourceDir = dirname(electronBinaryPath);
  const runtimeDir = join(desktopDir, ".electron-runtime", "win32");
  const targetDir = join(runtimeDir, APP_DISPLAY_NAME);
  const sourceExePath = join(sourceDir, "electron.exe");
  const targetExeName = `${APP_DISPLAY_NAME}.exe`;
  const targetExePath = join(targetDir, targetExeName);
  const iconPath = join(desktopDir, "resources", "icon.ico");
  const metadataPath = join(runtimeDir, "metadata.win32.json");

  ensureDirectory(runtimeDir);

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceDir,
    sourceExeMtimeMs: statSync(sourceExePath).mtimeMs,
    sourceResourcesMtimeMs: statSync(join(sourceDir, "resources")).mtimeMs,
    iconMtimeMs: existsSync(iconPath) ? statSync(iconPath).mtimeMs : null,
    displayName: APP_DISPLAY_NAME,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetExePath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    ensureWindowsShortcut(targetExePath, iconPath);
    return targetExePath;
  }

  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  const originalTargetExePath = join(targetDir, "electron.exe");
  if (existsSync(originalTargetExePath)) {
    renameSync(originalTargetExePath, targetExePath);
  } else {
    copyFileSync(sourceExePath, targetExePath);
  }
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  ensureWindowsShortcut(targetExePath, iconPath);

  return targetExePath;
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = join(desktopDir, "resources", "icon.icns");
  const metadataPath = join(runtimeDir, "metadata.json");

  ensureDirectory(runtimeDir);

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  patchHelperBundleInfoPlists(targetAppBundlePath);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform === "win32") {
    return buildWindowsLauncher(electronBinaryPath);
  }

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}
