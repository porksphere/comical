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
- **Bun stays at the edges.** `Bun.*` APIs (`Bun.serve`, `Bun.build`, `Bun.file`, `Bun.spawn`) are
  allowed only in `scripts/`, `sandbox/`, `packages/host-server/src/server.ts`, `packages/cli`, and
  `packages/testkit`. Every other package must run under plain Node (Electron's main process runs
  `host-server`'s `createHost()` on Node; Hermes runs `host-rn`). Use `node:*` imports, and keep the
  socket out of the assembly (`createHost()` returns the router; `createServer()` is the only thing
  that listens).
- **Node-free barrels stay Node-free.** The root exports of `contract`, `core`, `registry`,
  `host-rn`, and `host-server/router` must not reach `node:fs`/`node:path`. Node-bound code goes
  under a subpath (`@comical/registry/node`, `@comical/host-server/host`) and
  `packages/host-rn/test/bridges-entry.test.ts` walks the import graph to enforce it for `host-rn`.

## Native hosts (`host-ios`, `host-android`, `host-native`)

The Swift and Kotlin contexts are the native half of the harness protocol `host-native` defines
(`comical_init` / `comical_call` globals in, `_native_*` capability callbacks out). They are consumed
**by source** from `comical-app`'s submodule, never as a Swift Package / Gradle artifact — see
"Native hosts" in `README.md`. A change to a native capability is not done until every step below
is:

1. `@comical/contract` (the typed shape, zod-validated), then `@comical/core` if the gate changes.
2. `packages/host-native/src/entry-jsc.ts` **and** `entry-quickjs.ts` (the JS side of the protocol).
3. `ComicalBridgeContext.swift` **and** `ComicalBridgeContext.kt` (plus the tracker contexts if the
   capability applies to trackers) — both, or the platforms drift.
4. `bun run build:native` (the harness is a gitignored asset; it is NOT rebuilt by `bun test` or by
   the app's Metro). The `swift test` / instrumented tests run from `.github/workflows/native.yml`
   (weekly + on native-path pushes), not from the per-push CI.
5. The app needs a **fresh dev-client build** — the harness is baked into the APK/IPA, and
   `comical-app`'s Expo module repeats `host-android`'s Gradle deps (its CI diffs the two lists; a
   version bump here must be mirrored there).

## Testing

**Comprehensive tests are required for every change to these packages/areas:**

| Area | Test location |
|------|--------------|
| `packages/core` | `packages/core/test/` |
| `packages/runtime` | `packages/runtime/test/` |
| `packages/library` | `packages/library/test/` |
| `packages/host-server` — router, bridge-manager, tracker-manager, library-store | `packages/host-server/test/` |
| `packages/host-rn` — RN embedding layer (provider, transport, capability map, bundle source) | `packages/host-rn/test/` |
| `bridges/*` | `bridges/*/test/` |

- Write or update tests **before** marking a task done.
- **Run `bun run build` first on a fresh checkout.** `bridges/*/dist/` is gitignored build output, so
  a clone has no bridge bundles and every test that loads one fails — 51 of them, which looks
  exactly like a broken branch and has been misreported as one. Built: 1052 pass, 0 fail.
- Run `bun test` (full suite) or `bun test packages/host-server` (scoped) to confirm all tests pass.
- `bun run check:readme` (also in CI) fails when `README.md`'s package reference and `packages/*`
  disagree — update the table when adding or removing a package.
- New public APIs must have at least one happy-path and one error/edge-case test.

### host-server integration test pattern

All `packages/host-server` tests are HTTP integration tests: spin up a real `Bun.serve` on port 0, hit it with `fetch`, assert on HTTP status + JSON body. This pattern exercises the full request/response stack without mocking Hono internals. (For the assembled stack, `createHost()` from `src/host.ts` gives you the same router with no socket — `host.fetch("/path")` — see `test/host.test.ts`.)

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

The browser UI is the **`comical-app` repo's react-native-web build** — a cross-platform client
(iOS/Android natively, plus web) that is not part of this monorepo. It reaches this repo's
host-server over HTTP (or runs the reused router in-process via `@comical/host-rn`). Run the full
dev stack with `bun run dev` from the workspace root. (The old standalone `comical-web` browser
client is deprecated/archived.)

`comical-app` does **not** consume this checkout — it pins this repo as a git submodule at
`external/comical`. A commit here reaches the app only once that pointer moves, so a change in
`core` / `contract` / `runtime` / `library` / `registry` / `host-rn` isn't finished until it's
pushed here **and** the submodule bump is committed in `comical-app`. (Server-only changes —
`host-server`, CLI, sandbox — don't need it.) See the workspace `CLAUDE.md` for the exact steps.
