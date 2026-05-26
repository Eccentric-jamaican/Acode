# Changelog

All notable changes to this project will be documented in this file.

## [0.2.60] - 2026-05-26

### Added
- Added in-app browser-style back/forward navigation controls (`AppNavigationControls`) for navigation history in the web UI.
- Added OpenCode MCP management in the adapter with `mcp.status`, `mcp.add`, `mcp.connect`, and `tool.ids` SDK bridge methods, enabling dynamic MCP server lifecycle for T3 Computer Use.
- Added automatic T3 Computer MCP server provisioning in OpenCode sessions: the adapter checks at session start whether `t3_computer` is connected and connects it if missing.
- Added rate-limit / account summary display to the thread context panel, surfacing provider account tier, usage windows, and remaining capacity.
- Added `external` flag to OpenCode runtime client detection for distinguishing local vs. remote server runtimes.
- Added a `ComboboxPopup` and `ComboboxTrigger` component to the combobox UI kit for richer select/dropdown interactions.

### Changed
- Replaced the sidebar toggle icon from a raster PNG (`sidebar-toggle.png`) to a Lucide `PanelLeftIcon` SVG for sharper rendering and consistency.
- Refactored `ChatView` thread context panel to accept enriched props: `accountSummary`, `envLocked`, `handoffBusy`, `isServerThread`, and various action callbacks.
- Extracted T3 Computer and Imagegen MCP config builders into separate exported functions (`buildOpenCodeT3ComputerMcpConfig`, `buildOpenCodeT3ImagegenMcpConfig`).
- Improved OpenCode runtime module resolution to search multiple candidate paths for built `.mjs` and source `.ts` files.

### Fixed
- Fixed OpenCode adapter MCP server persistence when `t3_computer` is not loaded at session start — the adapter now adds and connects the MCP server automatically rather than relying on pre-existing configuration.
- Fixed sidebar icon blurriness on high-DPI displays by switching from a raster image to an SVG icon.

### Added
- Added Codex session prewarming so the app-server transport boots in the background before the first turn, reducing perceived session-start latency when navigating into threads.
- Added PDF annotation support: users can now select regions on PDF previews, capture them as annotated screenshots, and attach the annotation directly to the composer prompt for context-aware follow-up questions.
- Added local server URL artifact detection that scans assistant output, work-log detail, and tool results for localhost URLs and surfaces them as clickable links in the work log and timeline.
- Added browser preview artifact support for `.html`/`.htm` files the model produces, with a `file://` URL builder and an in-app browser preview button.
- Added an expand/collapse toggle to the integrated browser pane for more flexible screen usage.
- Added a `getPathForFile` bridge method on the desktop preload so file-path resolution is available to the web layer.
- Added Windows shortcut metadata helpers (`resolveWindowsShellIconPath`, `ensureWindowsShortcutMetadata`) for desktop shortcut and notification integration.
- Added optional model `capabilities` to the `ProviderModelDescriptor` schema so OpenCode runtime model lists can surface capability hints.
- Added a `threadIds` option to the orchestration snapshot query, enabling batch snapshot fetches.
- Added a Windows Electron binary resolution fallback in the desktop launcher script for more robust dev startup.

### Changed
- Overhauled the PDF preview (`PdfCanvasPreview`) with fit-width/fit-page/custom zoom controls, pinch-to-zoom on touch devices, debounced render-scale updates for smoother resizing, annotation selection mode with visual markers, and a resize observer for reliable viewport tracking.
- Refactored the Codex adapter session startup to decouple overlay management from transport initialization, and adopted prewarmed transports when available instead of always creating a fresh app-server process.
- Refactored the desktop browser runtime view management to use a centralized `attachedViews` set with synchronous bounds reapplication and cleaner view-detach helpers.
- Removed the expensive `readIntegratedBrowserViewportBounds` JavaScript bridge call from the desktop browser runtime, relying on web-side positioning instead.
- Improved the DiffPanel to integrate PDF annotation flows, allowing annotations captured on diff PDF previews to attach to the active thread composer.
- Changed the server 404 response `Cache-Control` to `no-store` to prevent stale error pages.
- Normalized Windows `.ico` file plane values during desktop artifact builds to fix icon corruption in some packaged builds.

### Fixed
- Fixed workspace restore state for legacy sessions by repairing the projection snapshot query to handle missing or malformed persisted state.
