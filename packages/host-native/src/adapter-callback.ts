/**
 * iOS (JSC) capability adapter. Swift injects callback-style native functions:
 *   _native_network_request(reqJSON, (err, resJSON) => …)
 *   _native_storage_get/set/delete/keys(key?, value?, (err, valueJSON?) => …)
 *   _native_storage_secure_get/set/delete/keys(...)   — same shapes, Keychain-backed
 *   _native_log(level, msg)
 *   _native_get_default_user_agent()                  → string (sync, optional)
 * This wraps them into core's HostCapabilities (promise-based).
 */
import type {
  HostCapabilities,
  HttpRequest,
  HttpResponse,
  KeyValueStore,
  ResolvedSettings,
} from "@comical/contract";
import { makeNativeLog } from "./native-log.ts";

type Callback = (err: string | null | undefined, result?: string) => void;

interface CallbackNatives {
  _native_log: (level: string, msg: string) => void;
  _native_network_request: (reqJSON: string, cb: Callback) => void;
  _native_storage_get: (key: string, cb: Callback) => void;
  _native_storage_set: (key: string, value: string, cb: Callback) => void;
  _native_storage_delete: (key: string, cb: Callback) => void;
  _native_storage_keys: (cb: Callback) => void;
  _native_storage_secure_get: (key: string, cb: Callback) => void;
  _native_storage_secure_set: (key: string, value: string, cb: Callback) => void;
  _native_storage_secure_delete: (key: string, cb: Callback) => void;
  _native_storage_secure_keys: (cb: Callback) => void;
  /** Sync, not callback-based — a native harness built before this capability existed just omits it. */
  _native_get_default_user_agent?: () => string;
}

function makeCallbackStore(
  get: (key: string, cb: Callback) => void,
  set: (key: string, value: string, cb: Callback) => void,
  del: (key: string, cb: Callback) => void,
  keys: (cb: Callback) => void,
): KeyValueStore {
  return {
    get: (key) =>
      new Promise<string | undefined>((resolve, reject) =>
        get(key, (err, v) => (err ? reject(new Error(err)) : resolve(v ?? undefined))),
      ),
    set: (key, value) =>
      new Promise<void>((resolve, reject) =>
        set(key, value, (err) => (err ? reject(new Error(err)) : resolve())),
      ),
    delete: (key) =>
      new Promise<void>((resolve, reject) =>
        del(key, (err) => (err ? reject(new Error(err)) : resolve())),
      ),
    keys: () =>
      new Promise<string[]>((resolve, reject) =>
        keys((err, v) => (err ? reject(new Error(err)) : resolve(JSON.parse(v ?? "[]") as string[]))),
      ),
  };
}

export function makeCallbackHost(settings: ResolvedSettings): HostCapabilities {
  const N = globalThis as unknown as CallbackNatives;
  return {
    network: {
      request: (req: HttpRequest) =>
        new Promise<HttpResponse>((resolve, reject) => {
          N._native_network_request(JSON.stringify(req), (err, res) =>
            err ? reject(new Error(err)) : resolve(JSON.parse(res ?? "{}") as HttpResponse),
          );
        }),
    },
    storage: {
      ...makeCallbackStore(
        N._native_storage_get,
        N._native_storage_set,
        N._native_storage_delete,
        N._native_storage_keys,
      ),
      secure: makeCallbackStore(
        N._native_storage_secure_get,
        N._native_storage_secure_set,
        N._native_storage_secure_delete,
        N._native_storage_secure_keys,
      ),
    },
    log: makeNativeLog(N._native_log),
    settings,
    ...(N._native_get_default_user_agent && {
      getDefaultUserAgent: () => N._native_get_default_user_agent!(),
    }),
  };
}
