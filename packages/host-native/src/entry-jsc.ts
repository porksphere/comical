/**
 * iOS / JavaScriptCore build entrypoint. Bundled to host-ios/.../Resources/harness.js and
 * evaluated once in the app's JSContext, where Swift has injected the callback-style _native_*
 * functions and __comical_native_eval.
 */
import { makeCallbackHost } from "./adapter-callback.ts";
import { installComicalHarness } from "./runtime.ts";

installComicalHarness(makeCallbackHost);
