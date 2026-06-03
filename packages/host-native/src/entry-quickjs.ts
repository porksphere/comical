/**
 * Android / QuickJS build entrypoint. Bundled to host-android/.../assets/comical_harness.js and
 * evaluated once in the app's QuickJS context, where Kotlin has injected the async _native_*
 * functions and __comical_native_eval.
 */
import { makeAsyncHost } from "./adapter-async.ts";
import { installComicalHarness } from "./runtime.ts";

installComicalHarness(makeAsyncHost);
