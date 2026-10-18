# Embedding the Comical runtime

How to run bridges from your own code — on a Bun/Node process, inside Electron, in a Swift or
Kotlin app, or in a React Native app — and what you get without taking the library, downloads,
and sync modules.

## The layers, and which ones are yours to skip

| Layer | Packages | Runs on | Needed for bridges? |
|-------|----------|---------|---------------------|
| Contract | `@comical/contract` | anywhere | yes |
| Core | `@comical/core` (+ `@comical/registry` root, `@comical/host-native`) | anywhere | yes |
| Hosts | `@comical/host-bun`, `@comical/host-server`, `@comical/host-rn`, `host-ios`, `host-android` | one each | pick one |
| Products | `@comical/library`, `@comical/runtime`, `@comical/downloads`, `@comical/sync` | anywhere | **no** — optional, all of them |

Dependencies only point downward. Nothing in the contract, core, or a host requires a product
package to be *used*; `host-server`'s router and `host-rn`'s transport mount `/library*`,
`/downloads*`, and `/sync*` only when handed the corresponding service, and 404 otherwise.

**Node-free surfaces** (safe for Hermes, a browser bundle, Electron's renderer): `@comical/contract`,
`@comical/core` and its subpaths, `@comical/registry` (root; the file-backed manager is under
`@comical/registry/node`), `@comical/host-server/router` + `/bridge-provider` +
`/registry-provider` + `/tracker-provider`, and all of `@comical/host-rn`. The barrels of
`@comical/host-server` and `@comical/host-bun` pull `node:fs`.

## Bun or Node: load a bundle and call it

```ts
import { loadBridge } from "@comical/core/loader";
import { createBunHost } from "@comical/host-bun"; // Bun fetch + file storage; or implement HostCapabilities yourself

const code = await Bun.file("./bridges/example/dist/bridge.js").text();
const bridge = await loadBridge({
  id: "example",
  bundleCode: code,
  host: createBunHost({ bridgeId: "example", dataDir: "./.data", settings: { baseUrl: "https://…" } }),
  // evaluator defaults to NodeVmEvaluator (a `node:vm` context per bridge)
});
const results = await bridge.getSearchResults?.("naruto", 1);
```

`loadBridge` validates the bundle against the contract, gates every network call through the
rate-limiter + response cache, and only exposes the methods the bridge implements. That is the whole
bridge runtime; everything else is convenience.

## Node, no socket: the assembled host

`createHost()` is `host-server`'s full stack — bridge discovery + registry installs + settings +
optional modules — behind a Hono router, with **no listener**. Electron's main process uses it; so
can a test or a CLI.

```ts
import { createHost } from "@comical/host-server/host";

const host = createHost({
  dataDir: "/var/lib/comical",      // settings, bridge-cache, and (if enabled) library/downloads
  bridgesDir: "./bridges",          // optional: unpacked local bundles
  hostUrl: "http://localhost:3100", // what bridges see; also the OAuth redirect base
  // library: true, downloads: true, sync: true  ← opt in; leave out for bridges only
});
const bridges = await host.fetch("/bridges").then((r) => r.json());
host.close();
```

`createServer()` is `createHost()` + `Bun.serve`, nothing more. Under plain Node, hand
`host.router.fetch` to whatever listener you like (`@hono/node-server`, Electron's protocol handler).

## Swift and Kotlin: the native contexts

`host-ios` and `host-android` are **source directories, not packages** — copy or `sourceSets` them
into your app, plus the harness `bun run build:native` generates
(`host-ios/…/Resources/harness.js`, `host-android/src/main/assets/comical_harness.js`). Then:

```swift
let ctx = try ComicalBridgeContext(bridgeBundle: code, settings: ["baseUrl": url])
let results = try await ctx.call("getSearchResults", args: ["naruto", 1])
```

```kotlin
val ctx = ComicalBridgeContext(androidContext = this, bundleCode = code, settings = mapOf("baseUrl" to url))
val results = ctx.call("getSearchResults", listOf("naruto", 1))
```

The context evaluates the harness (core + the capability adapter) in JSC / QuickJS, injects the
native `network`/`storage`/`log` callbacks, then evaluates the bundle. `ComicalTrackerContext` is the
same shape for tracker bundles. Each package's README has the integration notes and how its tests
run.

## React Native: `@comical/host-rn`

Your app owns three things: a native module that implements the `NativeBridgeRuntime` JSON contract
(`initBridge` / `callBridge` / `disposeBridge`, wrapping the contexts above), the transport setter
your data layer reads from, and AsyncStorage-backed stores for installed bridges, saved registries,
and per-bridge settings. `host-rn` builds the rest: the proxy `BridgeProvider`, registry
install/update, bundle verification + caching, and the reused `host-server` router driven
in-process.

Bridges only — nothing from the product packages is bundled:

```ts
import { installEmbeddedBridges, setNativeBridgeRuntime, installWebCryptoShim } from "@comical/host-rn/bridges";
import { createRouter } from "@comical/host-server/router";
import { downloadBundle, fetchIndex } from "@comical/registry/fetcher";

installWebCryptoShim(); // Hermes has no crypto.subtle; bundle verification needs SHA-256 + Ed25519
setNativeBridgeRuntime(requireNativeModule("ComicalRuntime"));
installEmbeddedBridges({
  createRouter, fetcher: { fetchIndex, downloadBundle },
  installed, registries, settings, installedTrackers, // your stores
  setTransport: (t) => api.setTransport(t),
});
```

The full entry (`@comical/host-rn`, `installEmbeddedTransport` / `configureEmbeddedRuntime`) adds
`libraryStore`, `downloadsStore` + `downloadsEngine`, and `covers` for the on-device library and
download engine. `comical-app` (`apps/mobile/src/data/embedded/`) is the reference consumer.

## What the bridge layer promises

- **The contract is additive.** New optional methods, fields, and discriminated-union variants;
  validated at the boundary. `CONTRACT_VERSION` is what a bundle declares compatibility against.
- **Hosts implement only `HostCapabilities` + a `BundleEvaluator`.** Presentation is data in the
  contract (`Page.thumbnail`, `SeriesList` layouts), never host-side rendering.
- **No package is published to npm yet.** Consume by git submodule, as `comical-app` does
  (`external/comical`, Metro `extraNodeModules` / tsconfig `paths` onto `packages/*/src`). All
  packages are plain TypeScript source with `exports` maps; there is no build step to run.
