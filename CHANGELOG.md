# Changelog

All notable changes to this project will be documented in this file.

## [0.2.55] - 2026-05-16

### Fixed
- Fixed packaged desktop releases failing to find the bundled Windows T3 Computer Use helper by teaching runtime helper discovery to check the staged `apps/server/dist/computer-use` path used in release artifacts.

## [0.2.54] - 2026-05-16

### Fixed
- Fixed workspace `prepare` scripts to skip the Effect language-service patch in CI while still allowing normal dependency install hooks like `node-pty` to run, unblocking Linux test and release preflight jobs.

## [0.2.53] - 2026-05-16

### Fixed
- Fixed GitHub Actions CI and release installs to skip workspace `prepare` scripts, preventing `effect-language-service patch` crashes from blocking desktop release preflight and finalize steps.

## [0.2.52] - 2026-05-16

### Fixed
- Fixed OpenCode binary-path resolution so persisted empty settings still fall back to the default `opencode` command when PATH discovery fails, preventing release preflight and local startup regressions.

## [0.2.51] - 2026-05-16

### Added
- Added persistent on-disk caching for Windows desktop app icons used by T3 Computer Use, along with server and client-side icon prewarming for the desktop app mention menu.
- Added focused coverage for desktop state-path resolution, Codex overlay cleanup behavior, OpenCode idle-history completion recovery, browser navigation helper behavior, and computer-use icon cache persistence.

### Changed
- Improved desktop app mention routing so explicit `@App` requests are matched more reliably by name, mention token, launch ID, app ID, and window title.
- Strengthened desktop-app prompt injection so explicit app-targeted turns instruct providers to use `t3_computer` rather than answering from reasoning alone.
- Preserved selected desktop app targets across follow-up turns in the composer so multi-step UI tasks can continue without re-tagging the app every turn.
- Moved Electron dev `userData` and `sessionData` under the T3 state directory with dev-instance isolation to reduce Chromium cache conflicts across local runs.
- Simplified the integrated browser omnibox so it behaves like a plain address bar without a suggestion popup.

### Fixed
- Fixed OpenCode assistant responses disappearing when the runtime only reported an idle/ready session state by backfilling assistant completions from session history.
- Fixed Codex and OpenCode desktop-app targeting regressions so `t3_computer` is available and selected app mentions resolve more consistently in provider turns.
- Fixed Windows T3 Computer Use helper refresh/install failures when `bridge.exe` was locked by another live process by reusing the installed helper instead of taking computer use offline.
- Fixed Codex full-access startup failures caused by transient Windows permission errors while pruning stale per-thread `CODEX_HOME` overlays.
- Fixed integrated browser URL handling so URL-like input no longer generated a misleading “search this URL” suggestion before the omnibox suggestion popup was removed.

## [0.2.44] - 2026-05-03

### Added
- Added a minimal Codex-style branch details rail with progress, artifacts, sources, and inline git actions.
- Added first-class generated image artifact handling so Codex image output can render inline and remain visible across later turns.
- Added provider-neutral progress collection for task/todo/plan-style events from supported agent providers.

### Changed
- Updated Codex defaults to GPT-5.5 with medium reasoning.
- Refined generated image previews with quieter Codex-like styling, aspect-ratio-aware sizing, and human-readable artifact labels.
- Moved branch change counts into the branch details rail and kept the rail hidden while the review/sidebar panel is open.
- Improved Markdown file links with file-type icons for easier scanning.

### Fixed
- Fixed generated image history being overwritten when a later image was produced in the same thread.
- Fixed generated image artifacts opening with raw generated ids instead of friendly names where a better label is available.
- Fixed stale release tests for the updated Codex model and reasoning defaults.

## [0.2.43] - 2026-05-03

### Added
- Added local skill prompt materialization for Claude and OpenCode turns so selected T3 skill mentions can be expanded into provider prompts.
- Added a T3 imagegen MCP server wrapper that lets compatible providers call the local Codex image generation fallback.
- Added server coverage for skill prompt materialization and expanded OpenCode adapter behavior tests.

### Changed
- Improved composer slash command handling and selected command cleanup for provider skill flows.
- Updated Claude and OpenCode adapter wiring for provider-local skill discovery and image generation support.

### Fixed
- Hardened PDF worker compatibility for environments missing newer math helpers.
- Refined review/timeline rendering behavior around generated artifacts and provider-driven prompt materialization.

## [0.2.42] - 2026-05-02

### Added
- Added first-class Markdown artifact cards for assistant-created or edited `.md`, `.mdx`, `.markdown`, `.mdown`, and `.mkd` files.

### Changed
- Reduced long-thread memory pressure by mounting fewer inactive tail rows and lowering timeline virtualizer overscan once conversations grow large.
- Reduced chat markdown highlighter memory use and skipped expensive syntax highlighting for streaming or very large code blocks.

### Fixed
- Hardened long-thread timeline rendering with row layout containment to reduce jumbled or overlapping text on lower-memory machines.

## [0.2.41] - 2026-05-02

### Added
- Added Codex plugin and skill discovery from the local Codex plugin directories, including a new Plugins page and cleaner composer/thread chips for selected slash commands, plugins, skills, inspections, and shortcuts.
- Added integrated T3 browser-use support that can open the in-app browser on demand, show a visible cursor while the model is acting, and avoid colliding with OpenAI's Browser Use plugin naming.
- Added browser-use settings for browsing data, approvals, history access, blocked domains, and allowed domains, plus persistent browser session storage so cookies can survive across projects and threads.
- Added a large-repo-ready file tree powered by the peer tree implementation, with git decorations, file opening, context menu actions, and create/rename/delete mutation wiring.
- Added Review panel support for unstaged, staged, branch, and last-turn scopes, including git action controls for staging and reverting changes.
- Added local line comments in the Review panel so review notes can be attached to lines and passed through the composer without cluttering the chat thread.
- Added binary file previews from the file tree for PDFs, images, SVGs, WebP, Office documents, spreadsheets, and presentations.
- Added side-by-side PDF previews for binary PDF changes in the Review panel using git object reads for before/after content.

### Changed
- Reworked the diff/file viewer into a calmer Review experience with compact file chips, cleaner headers, unified and split diff modes, word/whitespace toggles, and less visual noise.
- Improved Office/PDF document viewing with document tabs, expanded viewing mode, floating follow-up composer support, lightweight live refresh while sessions are running, and cleaner document layout.
- Improved browser integration reliability, including panel auto-open when browser use starts and faster visible cursor updates during model-controlled browsing.
- Improved file tree performance for large repositories with git-backed indexing, cache invalidation, and safer binary/text metadata handling.
- Refined chat/sidebar organization with a dedicated chat section and less noisy home-directory presentation.

### Fixed
- Fixed model discovery so Codex app-server model lists can surface newer Codex models without hardcoding availability in T3.
- Fixed file tree population issues by removing the expensive fallback path and repairing the peer tree implementation.
- Fixed file clicks from the file tree so selected files open in the viewer panel with the correct workspace context.
- Fixed Review scope behavior for branch and last-turn changes and hardened the git action paths with focused server tests.
- Fixed PDF preview rendering in Electron by adding PDF.js worker compatibility shims and using annotation rendering that preserves filled form values.
- Fixed PDF preview sizing so pages no longer render as squashed thumbnails in the file viewer.
- Fixed the Review panel PDF comparison chrome by removing redundant side labels and keeping the focus on the actual documents.

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

