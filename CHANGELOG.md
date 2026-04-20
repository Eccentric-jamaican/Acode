# Changelog

All notable changes to this project will be documented in this file.

## [0.2.35] - 2026-04-19

### Added
- Added injected OpenCode runtime client support so alternate runtime wiring can drive command, provider, session, and event APIs without going through the HTTP bridge.

### Changed
- Expanded the release candidate with the latest session orchestration, checkpoint sidebar, archive, subagent, and desktop progress updates merged after `v0.2.34`.
- Refined diff and timeline handling around the OpenCode integration path, including safer event subscription flow when an injected runtime client is present.
- Limited the `/fast` slash command to Codex sessions so OpenCode only surfaces built-in commands it actually supports.
- Tightened callback typing across chat markdown, workspace file rail, and split chat panel components to keep generated route typing predictable.

### Fixed
- Fixed OpenCode runtime event streaming for injected clients so the adapter uses the SDK-compatible subscription shape instead of the HTTP runtime code path.
- Fixed release-prep type regressions in file reveal and proposed-plan component props that were leaking into generated route output.

## [0.2.29] - 2026-04-08

### Fixed
- Fixed a crash in long-thread diff/chat rendering when syntax highlighter received unsupported language ids (for example `env`) by normalizing aliases and falling back to safe text highlighting.
- Hardened diff panel rendering to normalize explicit file diff language overrides before handing them to the highlighter pipeline.

## [0.2.28] - 2026-04-08

### Added
- Added a dedicated thread handoff dialog for worktree naming in chat view, aligned with dpcode UX behavior.

### Changed
- Updated worktree handoff flow to prompt for and normalize a user-specified worktree branch name before creation.
- Improved handoff dialog state handling so thread switches reset stale dialog state.

### Fixed
- Fixed remaining chat footer clipping/overflow behavior in split and single chat layouts.

## [0.2.27] - 2026-04-08

### Added
- Full Claude Code provider SDK integration on server and contracts layers, including adapter wiring, session/runtime handling, and provider registry coverage.
- Thread handoff and split-chat state modules in web, including multi-provider handoff helpers and composer/footer compact control components.
- New OpenCode Go model option: `opencode-go/glm-5.1`.
- Projection thread handoff migration (`019_ProjectionThreadsHandoff`) and related persistence/service updates.

### Changed
- Sidebar and split-view UX/behavior parity sweep to align worktree/handoff flows and thread rendering with the reference implementation.
- Provider and orchestration wiring updates across server layers (`serverLayers`, provider health/registry/session directory, projection pipeline/queries).
- Chat composer layout and controls refactor for cleaner compact behavior and reduced duplication.

### Fixed
- Fixed `ProviderModelOptions` initialization/runtime regression in desktop dev startup path.
- Fixed model picker icon clipping in compact composer mode.
- Fixed sidebar top spacing alignment and chat footer/toolbar bottom clipping issues.

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

