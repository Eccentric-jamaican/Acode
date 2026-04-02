---
name: t3-dev-desktop-start
description: Start the T3 desktop Electron app in dev mode on Windows with a compatibility fallback for missing desktop build artifacts. Use when asked to launch the desktop app, verify local desktop UI changes, or recover from a run where `dev:desktop` is waiting and no Electron window appears.
---

Use the repo skill launcher script first:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/t3-dev-desktop-start/scripts/start-dev-desktop.ps1
```

What this does:

- runs `bun run --filter @t3tools/desktop build` first so `dist-electron` artifacts exist
- pins `T3CODE_STATE_DIR` to `~/.t3-mine/userdata` by default (falls back to `~/.t3/userdata`) so desktop binds to the persistent project/thread DB rather than ephemeral dev state
- starts `bun run dev:desktop` in a detached process using `cmd.exe /c ...` for Windows compatibility
- tails logs in `.codex-logs/dev-desktop.out.log` and `.codex-logs/dev-desktop.err.log`
- detects the known blocker and auto-recovers by running:
  - `bun run --filter @t3tools/desktop build`

Known blocker to document:

- Symptom: `dev:electron` logs `waiting for renderer and build outputs` and no Electron window opens.
- Root cause: `apps/desktop/dist-electron/bootstrap.js` (and related files) are missing, so `wait-on` in `apps/desktop/scripts/dev-electron.mjs` never resolves.
- Fix: produce the desktop artifacts once with `bun run --filter @t3tools/desktop build`; Electron launches immediately after the files exist.

Manual fallback (if script is not used):

```powershell
bun run dev:desktop
bun run --filter @t3tools/desktop build
```

After startup, expect:

- web UI on `http://localhost:5733/` (or the current `webPort` from `[dev-runner]`)
- Electron child processes visible in Task Manager / `Get-Process electron`
