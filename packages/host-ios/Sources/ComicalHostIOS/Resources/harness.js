/**
 * JSC harness: evaluated once in the JSContext by ComicalBridgeContext.
 *
 * Bridges are CJS bundles. JSC has no `module`/`require` system, so we provide a minimal
 * CJS shim. The native Swift layer injects the host capability functions as JSC globals
 * before calling `comical_load(code)`. The harness wires them into a HostCapabilities object
 * and calls the bridge factory, storing the result in `comical_bridge`.
 *
 * Swift calls bridge methods via `comical_call(method, argsJSON)` which dispatches to the
 * correct bridge method and resolves a promise. Swift's JSContext evaluates this
 * asynchronously via the JSContext's built-in promise handling.
 */

"use strict";

// ── CJS shim ──────────────────────────────────────────────────────────────────

function comical_load(code) {
  const module = { exports: {} };
  const fn = new Function(
    "module", "exports",
    "console", "URL", "URLSearchParams",
    "TextEncoder", "TextDecoder", "atob", "btoa",
    "setTimeout", "clearTimeout", "queueMicrotask",
    // Shadow dangerous globals
    "fetch", "XMLHttpRequest", "WebSocket",
    code
  );
  fn(
    module, module.exports,
    comical_console, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob, btoa,
    setTimeout, clearTimeout, queueMicrotask,
    undefined, undefined, undefined
  );
  return module.exports;
}

// ── Host capability object (injected by Swift) ────────────────────────────────

const comical_console = {
  log:   (...a) => _native_log("info",  a.map(String).join(" ")),
  info:  (...a) => _native_log("info",  a.map(String).join(" ")),
  debug: (...a) => _native_log("debug", a.map(String).join(" ")),
  warn:  (...a) => _native_log("warn",  a.map(String).join(" ")),
  error: (...a) => _native_log("error", a.map(String).join(" ")),
};

// The host object passed to the bridge factory.
// _native_* functions are injected by Swift before comical_load is called.
function comical_make_host(settings) {
  return {
    network: {
      request: (req) => new Promise((resolve, reject) => {
        _native_network_request(JSON.stringify(req), (err, resJSON) => {
          if (err) reject(new Error(err));
          else resolve(JSON.parse(resJSON));
        });
      })
    },
    storage: {
      get:    (k)    => new Promise((res, rej) => _native_storage_get(k,    (e, v) => e ? rej(e) : res(v ?? undefined))),
      set:    (k, v) => new Promise((res, rej) => _native_storage_set(k, v, (e)    => e ? rej(e) : res())),
      delete: (k)    => new Promise((res, rej) => _native_storage_delete(k, (e)    => e ? rej(e) : res())),
      keys:   ()     => new Promise((res, rej) => _native_storage_keys(     (e, v) => e ? rej(e) : res(JSON.parse(v ?? "[]")))),
    },
    log: comical_console,
    settings: settings || {},
  };
}

// ── Bridge lifecycle ──────────────────────────────────────────────────────────

let comical_bridge = null;

function comical_init(code, settingsJSON) {
  const exports = comical_load(code);
  const factory = exports.default;
  if (typeof factory !== "function") throw new Error("bridge bundle must default-export a factory");
  const settings = settingsJSON ? JSON.parse(settingsJSON) : {};
  comical_bridge = factory(comical_make_host(settings));
  return comical_bridge.info ? JSON.stringify(comical_bridge.info) : null;
}

async function comical_call(method, argsJSON) {
  if (!comical_bridge) throw new Error("bridge not initialised — call comical_init first");
  const args = argsJSON ? JSON.parse(argsJSON) : [];
  const fn = comical_bridge[method];
  if (typeof fn !== "function") throw new Error(`bridge has no method: ${method}`);
  const result = await fn.apply(comical_bridge, args);
  return JSON.stringify(result);
}
