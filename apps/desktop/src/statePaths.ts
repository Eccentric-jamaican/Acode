import * as OS from "node:os";
import * as Path from "node:path";

import { APP_DESKTOP_STATE_ROOT_DIRNAME } from "@t3tools/shared/branding";

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

export function resolveDesktopStateDir(explicitStateDir?: string): string {
  const override = explicitStateDir?.trim();
  if (override) {
    return override;
  }

  return Path.join(OS.homedir(), APP_DESKTOP_STATE_ROOT_DIRNAME, "userdata");
}

export function resolveDesktopElectronUserDataDir(input: {
  readonly stateDir: string;
  readonly appDataDir: string;
  readonly appDisplayName: string;
  readonly isDevelopment: boolean;
  readonly explicitElectronUserDataDir?: string | null | undefined;
  readonly devInstance?: string | null | undefined;
}): string {
  const override = input.explicitElectronUserDataDir?.trim();
  if (override) {
    return override;
  }

  if (!input.isDevelopment) {
    return Path.join(input.appDataDir, input.appDisplayName);
  }

  const devInstance = input.devInstance?.trim();
  return Path.join(
    input.stateDir,
    "electron",
    devInstance ? sanitizePathSegment(devInstance) || "default" : "default",
  );
}

export function resolveDesktopElectronSessionDataDir(userDataDir: string): string {
  return Path.join(userDataDir, "session");
}
