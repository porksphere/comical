/** Host capabilities for tests: network routed to an in-process handler, in-memory storage. */
import type {
  HostCapabilities,
  HttpRequest,
  HttpResponse,
  LogCapability,
  ResolvedSettings,
} from "@comical/contract";
import type { FixtureBackend } from "./fixture-backend.ts";

export const silentLog: LogCapability = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface MockHostOptions {
  handle: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
  settings?: Record<string, string | boolean>;
  log?: LogCapability;
  /** Omit to simulate a host that reports no platform UA (bridge falls back to its own default). */
  userAgent?: string;
}

export function mockHost(opts: MockHostOptions): HostCapabilities {
  const store = new Map<string, string>();
  // A separate map (not aliased) so conformance tests catch a bridge that reads secure-written
  // values back from the plain store or vice versa — real Keychain/Keystore-backed hosts isolate
  // the two, and this mock should catch bugs those hosts would surface too.
  const secureStore = new Map<string, string>();
  const settings: ResolvedSettings = opts.settings ?? {};
  return {
    network: { request: async (req) => opts.handle(req) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
      secure: {
        get: async (k) => secureStore.get(k),
        set: async (k, v) => void secureStore.set(k, v),
        delete: async (k) => void secureStore.delete(k),
        keys: async () => [...secureStore.keys()],
      },
    },
    log: opts.log ?? silentLog,
    settings,
    ...(opts.userAgent !== undefined && { getDefaultUserAgent: () => opts.userAgent as string }),
  };
}

/** A host backed by a fixture backend, with `baseUrl` wired into bridge settings. */
export function fixtureHost(
  backend: FixtureBackend,
  settings: Record<string, string | boolean> = {},
): HostCapabilities {
  return mockHost({
    handle: (req) => backend.handle(req),
    settings: { baseUrl: "http://fixture.local", ...settings },
  });
}
