# Comical — Claude instructions

## Testing

**Comprehensive tests are required for every change to `packages/core`, `packages/runtime`, and any tracker code (`packages/library`, `packages/host-server/src/tracker-manager.ts`, `bridges/*`).**

- Write or update tests before marking a task done.
- Run `bun test` (or a scoped filter) to confirm all tests pass.
- New public APIs must have at least one happy-path and one error/edge-case test.

## Demo browser dev workflow

When the user is iterating on the demo browser app, spin up **two background terminals** — one for each process:

| Terminal | Command | Default port |
|----------|---------|-------------|
| Server   | `bun run demo:server` | 3100 |
| Client   | `bun run demo:dev`   | 3300 |

- **Both processes watch for changes automatically** — no manual restart needed for source edits.
  - Server restarts automatically when `packages/host-server/**` or `demo/demo-server.ts` change (via `bun --watch`).
  - Client rebuilds automatically when any `demo/*.ts` or `demo/index.html` changes, and the browser live-reloads.
  - Bridge/tracker changes: after rebuilding the bridge or tracker (`bun run build` in that package), the server detects the new `.js` and restarts automatically.
- **Port conflicts**: before starting, check if ports 3100/3300 are already in use. If the occupying process is the comical server or client from a previous session, kill it. If it is an unrelated process, warn the user before killing.

```powershell
# Kill by port (PowerShell)
$pid = (Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue).OwningProcess
if ($pid) { Stop-Process -Id $pid -Force }
```

## Playwright capture on request (remote sessions)

There is an **on-demand** Playwright lane for the browser demo, separate from `bun test`. It exists so a video + screenshots of the demo can be pushed back during remote/headless sessions.

- **Off by default.** Only run a capture when the user explicitly asks — e.g. *"send me the test recording"*, *"record the test"*, *"screenshot the e2e"*. Never run it automatically or on every test pass.
- **Run it:** `bun run e2e:capture` (all specs) or `bun run e2e:capture "<title substring>"` (passed to Playwright `-g`). The capture script boots both demo servers itself (reusing them if already running).
- **Deliver it:** the script prints a `CAPTURE_DIR=<path>` line and the collected artifact paths (`recording.mp4` + `NN-*.png` step screenshots). Push those files to the user with the `SendUserFile` tool, `status: "proactive"` so they ping the user's device. Do not paste local paths as if they were links — the user is remote and can't open them.
- **Video format:** the script transcodes Playwright's VP8/webm to H.264 mp4 via ffmpeg (the Claude app won't play webm). If ffmpeg isn't on PATH it falls back to delivering the raw `.webm`.
- Artifacts are collected even when the test **fails** (a failed run's recording is what you want to see), so check the printed pass/fail line and tell the user the outcome.
- Specs live in `e2e/`. Config: `playwright.config.ts`. Captures are git-ignored under `e2e/.captures/`.
