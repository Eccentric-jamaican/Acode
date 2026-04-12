const SIDEBAR_SEARCH_PALETTE_TOGGLE_EVENT = "t3:sidebar-search-palette-toggle";

export function emitToggleSidebarSearchPalette(): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_PALETTE_TOGGLE_EVENT));
}

export function onToggleSidebarSearchPalette(handler: () => void): () => void {
  const listener = () => {
    handler();
  };
  window.addEventListener(SIDEBAR_SEARCH_PALETTE_TOGGLE_EVENT, listener);
  return () => {
    window.removeEventListener(SIDEBAR_SEARCH_PALETTE_TOGGLE_EVENT, listener);
  };
}
