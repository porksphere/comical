# Comical — Claude instructions

## Design principles (read before changing the contract or adding a feature)

Cross-platform portability is a **fundamental, non-negotiable** design goal: the same core
(`@comical/core` + `@comical/contract`) runs unchanged on desktop, web, iOS, and Android. Treat
these as hard constraints, not preferences. See the "Design goals" section of `README.md` for the
full rationale.

- **Core stays platform-agnostic.** `@comical/core` and `@comical/contract` must not import `fs`,
  `process`, sockets, `fetch`, or the DOM. Platform access is reached only through
  `HostCapabilities`. If a change needs a platform API in the core, it belongs in a host adapter.
- **Keep host integration minimal.** A host implements only `HostCapabilities` (network/storage/log)
  plus a `BundleEvaluator`. Never add a responsibility a host must re-implement per platform — that
  burden multiplies across every current and future client. Lighter host = more correct.
- **Presentation is data, never rendered UI.** When a feature would otherwise need bespoke
  per-client/per-platform rendering logic, express it as a typed, zod-validated value in the contract
  so each client renders it with native primitives. Example: `Page.thumbnail` is a discriminated
  union (`image` URL | `sprite` slice-metadata) — web renders inline SVG, Android uses
  `BitmapRegionDecoder`, iOS uses `CGImage(cropping:)`, and the host does no image work. Do **not**
  reach for a server-side transform (e.g. cropping/transcoding in `host-server`) when the contract can
  carry metadata that lets every client do it natively.
- **Contract changes are additive and validated.** Prefer new optional fields / discriminated-union
  variants over breaking shapes; validate at the boundary (`pageThumbnailSchema`-style). The contract
  is the one stable seam every platform depends on.

## Testing

**Comprehensive tests are required for every change to these packages/areas:**

| Area | Test location |
|------|--------------|
| `packages/core` | `packages/core/test/` |
| `packages/runtime` | `packages/runtime/test/` |
| `packages/library` | `packages/library/test/` |
| `packages/host-server` — router, bridge-manager, tracker-manager, library-store | `packages/host-server/test/` |
| `bridges/*` | `bridges/*/test/` |

- Write or update tests **before** marking a task done.
- Run `bun test` (full suite) or `bun test packages/host-server` (scoped) to confirm all tests pass.
- New public APIs must have at least one happy-path and one error/edge-case test.

### host-server integration test pattern

All `packages/host-server` tests are HTTP integration tests: spin up a real `Bun.serve` on port 0, hit it with `fetch`, assert on HTTP status + JSON body. This pattern exercises the full request/response stack without mocking Hono internals.

**Server setup:**
```ts
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { FixtureBackend } from "@comical/testkit"; // for content endpoint tests

const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
const srv = Bun.serve({ port: 0, fetch: createRouter(manager, opts).fetch });
const baseUrl = `http://localhost:${srv.port}`;
// Remember to srv.stop(true) in afterAll.
```

**Optional capabilities (trackers, registry)** — use a minimal plain-object mock cast to the expected type:
```ts
const mockMgr = {
  list: async () => [...],
  get: async (id) => { if (id !== "known-id") throw new Error("not found: " + id); return mockObj; },
  // ...only the methods the router actually calls
} as unknown as TrackerManager; // or RegistryManager

createRouter(manager, { trackers: mockMgr })
```

**Absence tests** — create a second server without the optional manager and assert the route returns 404:
```ts
const noTrackerSrv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
expect((await fetch(`http://localhost:${noTrackerSrv.port}/trackers`)).status).toBe(404);
```

## Browser UI

The browser UI is a **separate deployable app in the `comical-web` repo** — it is not part of this
monorepo. Its dev workflow and the on-demand Playwright capture lane live there (see
`comical-web/CLAUDE.md`). Run it with `bash dev.sh` from the workspace root.
