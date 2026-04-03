# Changelog

All notable changes to this project will be documented in this file.

## [0.2.23] - 2026-04-03

### Added
- New OpenCode provider support across server + web layers, including adapter plumbing and turn mapping coverage.
- Pretext-powered timeline text layout support in web chat, with a dedicated shared layout adapter and focused unit tests.

### Changed
- Thread timeline height estimation now routes through a reusable text layout module with caching and graceful fallback behavior.
- Provider and model handling updates in chat/session flows to support OpenCode defaults and custom model selection.

### Fixed
- Fixed constrained chat header action spacing when browser/diff panes reduce thread width.
- Fixed missing `@chenglou/pretext` dependency resolution in the main app environment by adding package wiring to web dependencies.

## [0.2.21] - 2026-04-02

### Added
- New local skill: `t3-dev-desktop-start` for reliable desktop dev startup on Windows, including documented recovery for missing `dist-electron` artifacts.
- Browser runtime regression coverage for same-tab resize behavior in the integrated desktop browser pane.
- Feature backlog notes for integrated browser improvements at `.agents/skills/t3-dev-ui-start/FEATURES.md/browser.md`.

### Changed
- Desktop dev startup flow now builds desktop artifacts before launch and improves `dev-electron` wait/restart behavior.
- Integrated browser pane routing/state behavior in chat threads was refined:
  - browser pane open/close routing control from thread header
  - improved panel mode synchronization
  - safer browser panel + diff rail interactions
- Browser pane sizing and bounds synchronization was hardened across web + desktop layers to reduce resize drift/race conditions.
- Workspace scripts and browser-related transport/state handling were updated for more predictable session behavior.

### Fixed
- Fixed missing Electron bootstrap artifact startup failures (`dist-electron/bootstrap.js`) by ensuring build prerequisites in launch flows.
- Fixed incorrect state-dir binding defaults so desktop sessions use the expected persisted thread/project DB location.
- Fixed right-edge layout gap/rounding artifacts when the browser pane is open.
- Removed the browser session restart/kill control from integrated browser header controls.

