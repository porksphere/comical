# @comical/host-android

Android host adapter for the Comical bridge runtime. Runs bridge bundles in **QuickJS**
(~1 MB embed via `quickjs-android`) with native Kotlin capabilities (OkHttp, DataStore,
Android Log). No Hermes or V8 dependency required.

## Why QuickJS

| Engine   | APK size added |
|----------|---------------|
| QuickJS  | ~1 MB         |
| Hermes   | ~3–4.5 MB     |
| V8 (J2V8)| ~30 MB        |

QuickJS supports ES2020 and runs the engine-agnostic CJS bridge bundles without modification.

## How it works

```
Bridge CJS bundle → comical_harness.js (QuickJS) → capability callbacks (Kotlin) → OkHttp / DataStore
```

`comical_harness.js` (in `src/main/assets/`) is a CJS shim that runs inside QuickJs.
Kotlin injects native functions (`_native_network_request`, `_native_storage_*`,
`_native_log`) as QuickJS globals before evaluating the bridge.

## Integration

```kotlin
// 1. Load the bridge bundle (from assets, downloaded from a registry, etc.)
val bundleCode = assets.open("bridges/example.js").bufferedReader().readText()

// 2. Create the context
val ctx = ComicalBridgeContext(
    androidContext = this,
    bundleCode = bundleCode,
    settings = mapOf("baseUrl" to userPrefs.backendUrl)
)

// 3. Call bridge methods (suspend functions — call from a coroutine)
val info = ctx.bridgeInfo
val results = ctx.call("getSearchResults", listOf("naruto", 1))

// Optional: local HTTP server for a WebView
val server = ComicalServer(ctx)
server.start()
// server.port → pass to WebViewClient

// 4. Clean up
ctx.close()
```

## Running tests

```sh
./gradlew :host-android:test
```

Uses Robolectric — runs on JVM without a device or emulator.

## harness.js

The `src/main/assets/comical_harness.js` file is shared with `host-ios` and generated
from the same source. Regenerate after core changes:

```sh
cp packages/host-ios/Sources/ComicalHostIOS/Resources/harness.js \
   packages/host-android/src/main/assets/comical_harness.js
```
