/**
 * iOS (JSC) capability adapter. Swift injects callback-style native functions:
 *   _native_network_request(reqJSON, (err, resJSON) => …)
 *   _native_storage_get/set/delete/keys(key?, value?, (err, valueJSON?) => …)
 *   _native_log(level, msg)
 * This wraps them into core's HostCapabilities (promise-based).
 */
import type {
  HostCapabilities,
  HttpRequest,
  HttpResponse,
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
      get: (key) =>
        new Promise<string | undefined>((resolve, reject) =>
          N._native_storage_get(key, (err, v) =>
            err ? reject(new Error(err)) : resolve(v ?? undefined),
          ),
        ),
      set: (key, value) =>
        new Promise<void>((resolve, reject) =>
          N._native_storage_set(key, value, (err) => (err ? reject(new Error(err)) : resolve())),
        ),
      delete: (key) =>
        new Promise<void>((resolve, reject) =>
          N._native_storage_delete(key, (err) => (err ? reject(new Error(err)) : resolve())),
        ),
      keys: () =>
        new Promise<string[]>((resolve, reject) =>
          N._native_storage_keys((err, v) =>
            err ? reject(new Error(err)) : resolve(JSON.parse(v ?? "[]") as string[]),
          ),
        ),
    },
    log: makeNativeLog(N._native_log),
    settings,
  };
}
