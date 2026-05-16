import path from "node:path";

import { describe, expect, it } from "vitest";

import { bundledHelperCandidatesForRoot } from "./bridge";

describe("bundledHelperCandidatesForRoot", () => {
  it("includes the packaged dist helper path used by desktop releases", () => {
    const packageRoot = path.join("C:", "repo", "apps", "server");

    const candidates = bundledHelperCandidatesForRoot({
      packageRoot,
      platform: "win32",
      arch: "x64",
      helperFileName: "bridge.exe",
    });

    expect(candidates).toContain(
      path.join(packageRoot, "dist", "computer-use", "prebuilt", "windows", "x64", "bridge.exe"),
    );
    expect(candidates).toContain(
      path.join(packageRoot, "computer-use", "prebuilt", "windows", "x64", "bridge.exe"),
    );
  });
});
