import { describe, expect, it } from "vitest";

import {
  hasUrlScheme,
  isSearchResultsUrlForQuery,
  looksLikeNavigableUrlInput,
  looksLikeSearchQuery,
  resolveBrowserNavigationUrl,
  shouldApplyHighlightedBrowserSuggestionOnEnter,
  toNavigableUrl,
} from "./IntegratedBrowserPane.logic";

describe("IntegratedBrowserPane navigation helpers", () => {
  it("normalizes direct URLs to https when no scheme is present", () => {
    expect(looksLikeSearchQuery("github.com")).toBe(false);
    expect(hasUrlScheme("github.com")).toBe(false);
    expect(toNavigableUrl("github.com")).toBe("https://github.com");
    expect(resolveBrowserNavigationUrl("github.com")).toBe("https://github.com");
  });

  it("routes multi-word input to a search URL", () => {
    expect(looksLikeSearchQuery("openai codex")).toBe(true);
    expect(resolveBrowserNavigationUrl("openai codex")).toBe(
      "https://www.google.com/search?q=openai%20codex",
    );
  });

  it("recognizes explicit URL-like input as navigable", () => {
    expect(looksLikeNavigableUrlInput("https://www.google.com/")).toBe(true);
    expect(looksLikeNavigableUrlInput("openai.com")).toBe(true);
    expect(looksLikeNavigableUrlInput("chatgpt")).toBe(false);
  });

  it("detects search-result URLs that only search for the currently typed URL", () => {
    expect(
      isSearchResultsUrlForQuery(
        "https://www.google.com/search?q=https%3A%2F%2Fwww.google.com%2F",
        "https://www.google.com/",
      ),
    ).toBe(true);
    expect(
      isSearchResultsUrlForQuery(
        "https://www.google.com/search?q=openai%20codex",
        "https://www.google.com/",
      ),
    ).toBe(false);
  });

  it("only applies the highlighted suggestion after an explicit suggestion selection", () => {
    expect(
      shouldApplyHighlightedBrowserSuggestionOnEnter({
        menuOpen: true,
        highlightedIndex: 0,
        suggestionCount: 2,
        hasManualSuggestionSelection: false,
      }),
    ).toBe(false);

    expect(
      shouldApplyHighlightedBrowserSuggestionOnEnter({
        menuOpen: true,
        highlightedIndex: 1,
        suggestionCount: 2,
        hasManualSuggestionSelection: true,
      }),
    ).toBe(true);
  });
});
