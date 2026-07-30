/**
 * Android (QuickJS) capability adapter. Kotlin registers the native functions as async functions
 * that return the value directly (a Promise resolving to JSON), rather than taking a callback:
 *   await _native_network_request(reqJSON)                   → resJSON
 *   await _native_storage_get(key)                           → value | null
 *   await _native_storage_set/delete(key[, value])           → (ignored)
 *   await _native_storage_keys()                              → keysJSON
 *   await _native_storage_secure_get/set/delete/keys(...)     → same shapes, Keystore-backed
 *   _native_log(level, msg)
 * This wraps them into core's HostCapabilities.
 */
import type {
  HostCapabilities,
  HttpRequest,
  HttpResponse,
  KeyValueStore,
  ResolvedSettings,
} from "@comical/contract";
import { makeNativeLog } from "./native-log.ts";

interface AsyncNatives {
  _native_log: (level: string, msg: string) => void;
  _native_network_request: (reqJSON: string) => Promise<string>;
  _native_storage_get: (key: string) => Promise<string | null | undefined>;
  _native_storage_set: (key: string, value: string) => Promise<unknown>;
  _native_storage_delete: (key: string) => Promise<unknown>;
  _native_storage_keys: () => Promise<string>;
  _native_storage_secure_get: (key: string) => Promise<string | null | undefined>;
  _native_storage_secure_set: (key: string, value: string) => Promise<unknown>;
  _native_storage_secure_delete: (key: string) => Promise<unknown>;
  _native_storage_secure_keys: () => Promise<string>;
}

function makeAsyncStore(
  get: (key: string) => Promise<string | null | undefined>,
  set: (key: string, value: string) => Promise<unknown>,
  del: (key: string) => Promise<unknown>,
  keys: () => Promise<string>,
): KeyValueStore {
  return {
    get: async (key) => (await get(key)) ?? undefined,
    set: async (key, value) => {
      await set(key, value);
    },
    delete: async (key) => {
      await del(key);
    },
    keys: async () => JSON.parse(await keys()) as string[],
  };
}

export function makeAsyncHost(settings: ResolvedSettings): HostCapabilities {
  const N = globalThis as unknown as AsyncNatives;
  const plain = makeAsyncStore(
    N._native_storage_get,
    N._native_storage_set,
    N._native_storage_delete,
    N._native_storage_keys,
  );
  return {
    network: {
      request: async (req: HttpRequest): Promise<HttpResponse> =>
        JSON.parse(await N._native_network_request(JSON.stringify(req))) as HttpResponse,
    },
    storage: {
      ...plain,
      secure: makeAsyncStore(
        N._native_storage_secure_get,
        N._native_storage_secure_set,
        N._native_storage_secure_delete,
        N._native_storage_secure_keys,
      ),
    },
    log: makeNativeLog(N._native_log),
    settings,
  };
}
