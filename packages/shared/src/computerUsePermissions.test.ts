import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import {
  isComputerUseAppAllowed,
  normalizeComputerUseCategoryList,
} from "./computerUsePermissions";

describe("computerUsePermissions", () => {
  it("treats legacy agent app categories as desktop permissions", () => {
    expect(normalizeComputerUseCategoryList(["desktop", "agent"])).toEqual(["desktop"]);
    expect(
      isComputerUseAppAllowed(
        { appId: "win32:codex:123", category: "agent" },
        {
          ...DEFAULT_SERVER_SETTINGS.computerUse,
          enabledAppCategories: ["desktop"],
        },
      ),
    ).toBe(true);
  });
});
