# @comical/host-android

Android host adapter for the Comical bridge runtime. Runs bridge bundles in **QuickJS**
(via `io.github.dokar3:quickjs-kt-android` 1.x) through the shared `@comical/core`, with native
Kotlin capabilities (OkHttp, file storage, Android Log). No Hermes or V8 dependency required.

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

Instrumented tests run on a device/emulator against the **real** `quickjs-kt-android` artifact
(Robolectric can't load QuickJS's native `.so`, so there are no JVM unit tests for the engine):

```sh
# 1. (re)generate the bundled runtime asset
bun run build:native
# 2. boot an emulator/AVD (or connect a device), then:
./gradlew :host-android:connectedDebugAndroidTest
```

Local toolchain: JDK 17, Android SDK (platform 36 — required by quickjs-kt-android 1.x), an AVD,
and hardware acceleration (WHPX on Windows). Build matrix: AGP 8.9.2 / Gradle 8.11.1 / Kotlin 2.3.x.

## comical_harness.js

`src/main/assets/comical_harness.js` is the **generated** bundle of `@comical/host-native`
(`@comical/core` + glue + the async capability adapter), shared in spirit with `host-ios`. It is
gitignored and produced by `bun run build:native` — regenerate it after core/host-native changes.

## Isolation note

`__comical_native_eval` currently evaluates the bridge in the **same** QuickJS context (no app/DOM
globals; core bundled as an IIFE). Full separate-context isolation (a second QuickJS context with the
`eval` intrinsic omitted) needs QuickJS C-API access the quickjs-kt binding doesn't expose — tracked
as a future JNI upgrade.
