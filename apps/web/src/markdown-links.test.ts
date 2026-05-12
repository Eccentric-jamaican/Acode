import { describe, expect, it } from "vitest";

import {
  normalizeMarkdownFileLinkLabel,
  parseMarkdownFileLinkLiteral,
  resolveMarkdownFileLinkTarget,
} from "./markdown-links";

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("parseMarkdownFileLinkLiteral", () => {
  it("parses inline-code markdown file links with Windows absolute targets", () => {
    expect(
      parseMarkdownFileLinkLiteral(
        "[apps/server/src/server.ts](C:\\Users\\Addis\\source\\repos\\t3code\\apps\\server\\src\\server.ts)",
      ),
    ).toEqual({
      label: "apps/server/src/server.ts",
      href: "C:\\Users\\Addis\\source\\repos\\t3code\\apps\\server\\src\\server.ts",
    });
  });
});

describe("normalizeMarkdownFileLinkLabel", () => {
  it("collapses path-like labels to the basename", () => {
    expect(
      normalizeMarkdownFileLinkLabel(
        "apps/server/src/server.ts",
        "C:\\Users\\Addis\\source\\repos\\t3code\\apps\\server\\src\\server.ts",
      ),
    ).toBe("server.ts");
  });
});
