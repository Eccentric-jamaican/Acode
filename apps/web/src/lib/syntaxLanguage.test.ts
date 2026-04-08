import { describe, expect, it } from "vitest";
import { normalizeSyntaxLanguage } from "./syntaxLanguage";

describe("normalizeSyntaxLanguage", () => {
  it("falls back to text for empty or missing values", () => {
    expect(normalizeSyntaxLanguage(undefined)).toBe("text");
    expect(normalizeSyntaxLanguage(null)).toBe("text");
    expect(normalizeSyntaxLanguage("   ")).toBe("text");
  });

  it("normalizes language aliases used by syntax highlighters", () => {
    expect(normalizeSyntaxLanguage("env")).toBe("dotenv");
    expect(normalizeSyntaxLanguage(" ENV ")).toBe("dotenv");
  });

  it("preserves non-aliased language ids", () => {
    expect(normalizeSyntaxLanguage("typescript")).toBe("typescript");
    expect(normalizeSyntaxLanguage("tsx")).toBe("tsx");
  });
});
