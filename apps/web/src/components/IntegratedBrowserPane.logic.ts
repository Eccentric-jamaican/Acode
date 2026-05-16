export function looksLikeSearchQuery(value: string): boolean {
  return /\s/.test(value.trim());
}

export function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}

export function looksLikeNavigableUrlInput(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || looksLikeSearchQuery(trimmed)) {
    return false;
  }
  return hasUrlScheme(trimmed) || trimmed.includes(".");
}

export function toNavigableUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (hasUrlScheme(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function resolveBrowserNavigationUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (looksLikeSearchQuery(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return toNavigableUrl(trimmed);
}

export function isSearchResultsUrlForQuery(candidateUrl: string, query: string): boolean {
  const trimmedQuery = query.trim();
  if (!looksLikeNavigableUrlInput(trimmedQuery)) {
    return false;
  }
  try {
    const parsed = new URL(candidateUrl);
    const host = parsed.hostname.toLowerCase();
    const isSearchUrl =
      (host.includes("google.") && parsed.pathname === "/search") ||
      (host.includes("bing.com") && parsed.pathname === "/search") ||
      (host.includes("duckduckgo.com") && parsed.pathname === "/");
    if (!isSearchUrl) {
      return false;
    }
    const q = parsed.searchParams.get("q")?.trim();
    if (!q) {
      return false;
    }
    return q === trimmedQuery || q === toNavigableUrl(trimmedQuery);
  } catch {
    return false;
  }
}

export function shouldApplyHighlightedBrowserSuggestionOnEnter(input: {
  menuOpen: boolean;
  highlightedIndex: number;
  suggestionCount: number;
  hasManualSuggestionSelection: boolean;
}): boolean {
  return (
    input.menuOpen &&
    input.hasManualSuggestionSelection &&
    input.highlightedIndex >= 0 &&
    input.highlightedIndex < input.suggestionCount
  );
}
