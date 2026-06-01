# @comical/host-ios

iOS host adapter for the Comical bridge runtime. Runs bridge bundles in JavaScriptCore —
Apple's system-provided JS engine (zero additional footprint) — with native Swift
capabilities (URLSession, FileManager, os.log).

## How it works

```
Bridge CJS bundle → harness.js (JSC) → capability callbacks (Swift) → URLSession / FileManager
```

`harness.js` is a tiny CJS shim that runs inside a `JSContext`. Swift injects native
functions (`_native_network_request`, `_native_storage_*`, `_native_log`) as JSC globals
before evaluating the bridge. The bridge only ever calls `host.network.request(...)` —
it never sees URLSession or any Apple framework.

## Integration

```swift
// 1. Load the bridge bundle (fetch from a registry, bundle in app, etc.)
let bundleCode = try String(contentsOf: bundleURL, encoding: .utf8)

// 2. Create the context (settings = user-supplied backend URL + credentials)
let ctx = try ComicalBridgeContext(
    bridgeBundle: bundleCode,
    settings: ["baseUrl": userSettings.backendURL]
)

// 3. Call bridge methods
let info = ctx.bridgeInfo
let results = try await ctx.call("getSearchResults", args: ["naruto", 1])

// Optional: expose as a local HTTP server for a WKWebView
let server = ComicalServer(context: ctx)
try server.start()
// server.port is now a valid port — pass to WKWebView via custom URL scheme
```

## Running tests

```sh
swift test
```

Requires Xcode / Swift toolchain on macOS. Tests run without a simulator using a
minimal synthetic bridge bundle.

## Architecture note

iOS is the only major platform where Apple permits downloading and executing new logic
only through a JS engine (JavaScriptCore). This is by design and is consistent with
the App Store guidelines — bridge bundles are JS, not native code.
