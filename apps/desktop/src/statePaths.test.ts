import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveDesktopElectronSessionDataDir,
  resolveDesktopElectronUserDataDir,
  resolveDesktopStateDir,
} from "./statePaths";

describe("statePaths", () => {
  it("uses the default desktop state root when no override is provided", () => {
    expect(resolveDesktopStateDir()).toContain(Path.join(".t3-mine", "userdata"));
  });

  it("preserves an explicit desktop state override", () => {
    expect(resolveDesktopStateDir("C:\\custom-state")).toBe("C:\\custom-state");
  });

  it("stores development electron data under the desktop state dir", () => {
    expect(
      resolveDesktopElectronUserDataDir({
        stateDir: "C:\\state",
        appDataDir: "C:\\Users\\Addis\\AppData\\Roaming",
        appDisplayName: "A Code (Dev)",
        isDevelopment: true,
      }),
    ).toBe(Path.join("C:\\state", "electron", "default"));
  });

  it("isolates development electron data by dev instance when present", () => {
    expect(
      resolveDesktopElectronUserDataDir({
        stateDir: "C:\\state",
        appDataDir: "C:\\Users\\Addis\\AppData\\Roaming",
        appDisplayName: "A Code (Dev)",
        isDevelopment: true,
        devInstance: "Chrome MCP / QA",
      }),
    ).toBe(Path.join("C:\\state", "electron", "chrome-mcp-qa"));
  });

  it("uses appData for packaged electron data by default", () => {
    expect(
      resolveDesktopElectronUserDataDir({
        stateDir: "C:\\state",
        appDataDir: "C:\\Users\\Addis\\AppData\\Roaming",
        appDisplayName: "A Code",
        isDevelopment: false,
      }),
    ).toBe(Path.join("C:\\Users\\Addis\\AppData\\Roaming", "A Code"));
  });

  it("honors an explicit electron userData override", () => {
    expect(
      resolveDesktopElectronUserDataDir({
        stateDir: "C:\\state",
        appDataDir: "C:\\Users\\Addis\\AppData\\Roaming",
        appDisplayName: "A Code (Dev)",
        isDevelopment: true,
        explicitElectronUserDataDir: "D:\\electron-data",
      }),
    ).toBe("D:\\electron-data");
  });

  it("derives session data from the electron userData dir", () => {
    expect(resolveDesktopElectronSessionDataDir("C:\\state\\electron\\default")).toBe(
      Path.join("C:\\state\\electron\\default", "session"),
    );
  });
});
