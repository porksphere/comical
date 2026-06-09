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
