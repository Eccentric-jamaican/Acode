# AGENTS.md

## Task Completion Requirements

- Both `bun lint` and `bun typecheck` must pass before considering tasks completed.
- **Never run `bun test` directly** — always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. **Performance first.**
2. **Reliability first.**
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Tech Stack

- **Package manager**: Bun 1.3.3
- **Monorepo**: Turbo + Bun workspaces
- **Language**: TypeScript 5.7+ (ES2023, ESM, strict mode)
- **Framework**: Effect (functional programming library)
- **Lint**: oxlint + oxfmt
- **Test**: Vitest (browser tests use Playwright)
- **Node**: ^22.13 || ^23.4 || >=24.10

## Package Roles

| Package | Role |
|---------|------|
| `apps/server` | Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions. |
| `apps/web` | React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket. |
| `apps/desktop` | Electron desktop app. Wraps the web UI in a native window with auto-updater. |
| `apps/marketing` | Astro-based marketing site. |
| `packages/contracts` | Shared Effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. **Schema-only — no runtime logic.** |
| `packages/shared` | Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — **no barrel index.** |

## Developer Commands

```bash
# Full dev stack (recommended for browser testing)
bun run dev -- --no-browser

# Dev variants
bun run dev:server    # Server only
bun run dev:web       # Web UI only
bun run dev:desktop   # Desktop app (requires build first)

# Quality checks (run in order)
bun run lint          # oxlint
bun run typecheck     # tsc --noEmit across packages
bun run test          # Vitest unit tests

# Build
bun run build                    # Full build
bun run build:contracts          # Contracts package only
bun run build:desktop            # Desktop artifacts

# Browser tests (CI-required)
cd apps/web && bunx playwright install --with-deps chromium
bun run --cwd apps/web test:browser
```

### Dev Instance Isolation

When ports are busy or stale, use isolated dev instances:

```powershell
$env:T3CODE_DEV_INSTANCE = "chrome-mcp"
bun run dev -- --no-browser
```

Or use `T3CODE_PORT_OFFSET=<n>` for fixed port offsets.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

Key files:

- Session startup/resume and turn lifecycle: `apps/server/src/codexAppServerManager.ts`
- Provider dispatch and thread event logging: `apps/server/src/providerManager.ts`
- WebSocket server routes NativeApi methods: `apps/server/src/wsServer.ts`
- Web app consumes events on channel: `orchestration.domainEvent`

Docs: https://developers.openai.com/codex/sdk/#app-server

## Configuration

### CLI ↔ Env Option Map

| CLI flag | Env var | Notes |
|----------|---------|-------|
| `--mode <web\|desktop>` | `T3CODE_MODE` | Runtime mode |
| `--port <number>` | `T3CODE_PORT` | HTTP/WebSocket port |
| `--host <address>` | `T3CODE_HOST` | Bind interface/address |
| `--state-dir <path>` | `T3CODE_STATE_DIR` | State directory (default: `~/.t3/dev`) |
| `--dev-url <url>` | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target |
| `--no-browser` | `T3CODE_NO_BROWSER` | Disable auto-open browser |
| `--auth-token <token>` | `T3CODE_AUTH_TOKEN` | WebSocket auth token |

See `REMOTE.md` for remote access setup (Tailscale, auth tokens, etc.).

## Code Conventions

- **No barrel exports** in `packages/shared` — use explicit subpath imports
- **Contracts are schema-only** — no runtime logic in `packages/contracts`
- **Effect framework** — functional composition, explicit error handling
- **Strict TypeScript** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`

## Local Skills

| Skill | Purpose | File |
|-------|---------|------|
| `t3-dev-ui-start` | Start web UI + backend for browser testing | `.agents/skills/t3-dev-ui-start/SKILL.md` |
| `t3-dev-desktop-start` | Start Electron desktop app on Windows | `.agents/skills/t3-dev-desktop-start/SKILL.md` |
| `btca-cli` | Query external git repositories | `.agents/skills/btca-cli/SKILL.md` |

## Reference Repos

- Open-source Codex: https://github.com/openai/codex
- CodexMonitor (Tauri reference impl): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Key Files

- `scripts/dev-runner.ts` — Unified dev orchestrator
- `turbo.json` — Task pipeline and env vars
- `package.json` — Bun catalog dependencies, workspace config
- `.oxlintrc.json` — Lint rules
- `KEYBINDINGS.md` — User keybinding configuration
