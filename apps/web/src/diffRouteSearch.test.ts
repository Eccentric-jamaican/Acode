import { describe, expect, it } from "vitest";
import { TurnId } from "@t3tools/contracts";

import {
  parseDiffRouteSearch,
  resolveRightPanelMode,
  stripRightPanelSearchParams,
  withDiffSelection,
  withRightPanelMode,
} from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      panel: "diff",
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      panel: "diff",
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
    });
  });

  it("parses browser panel mode and drops diff state", () => {
    const parsed = parseDiffRouteSearch({
      panel: "browser",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "browser",
    });
  });
});

describe("right panel search helpers", () => {
  it("resolves panel mode from parsed search", () => {
    expect(resolveRightPanelMode({ panel: "browser" })).toBe("browser");
    expect(resolveRightPanelMode({ panel: "diff" })).toBe("diff");
    expect(resolveRightPanelMode({ diff: "1" })).toBe("diff");
    expect(resolveRightPanelMode({})).toBe("none");
  });

  it("strips right panel params while preserving unrelated search values", () => {
    expect(
      stripRightPanelSearchParams({
        panel: "browser",
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        q: "hello",
      }),
    ).toEqual({ q: "hello" });
  });

  it("writes browser mode search state", () => {
    expect(
      withRightPanelMode(
        {
          diff: "1",
          diffTurnId: "turn-1",
          q: "hello",
        },
        "browser",
      ),
    ).toEqual({
      panel: "browser",
      q: "hello",
    });
  });

  it("writes diff mode + diff selection", () => {
    expect(
      withDiffSelection(
        {
          panel: "browser",
          q: "hello",
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          filePath: "src/index.ts",
        },
      ),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-2",
      diffFilePath: "src/index.ts",
      q: "hello",
    });
  });

  it("clears panel state when mode is none", () => {
    expect(
      withRightPanelMode(
        {
          panel: "diff",
          diff: "1",
          q: "hello",
        },
        "none",
      ),
    ).toEqual({ q: "hello" });
  });
});
