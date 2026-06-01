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
}

export function mockHost(opts: MockHostOptions): HostCapabilities {
  const store = new Map<string, string>();
  const settings: ResolvedSettings = opts.settings ?? {};
  return {
    network: { request: async (req) => opts.handle(req) },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    log: opts.log ?? silentLog,
    settings,
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
