/**
 * Record/replay at the `network.request` capability boundary — the engine-agnostic linchpin
 * of the test framework. A cassette captured under one engine replays identically under any.
 *
 * Recorded requests are sanitized: auth/cookie headers and any configured backend URL are
 * redacted so committed fixtures never contain secrets.
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";

export interface CassetteEntry {
  request: { method: string; url: string; body?: string };
  response: HttpResponse;
}

export interface Cassette {
  entries: CassetteEntry[];
}

const REDACTED = "<redacted>";
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

function matchKey(req: { method?: string; url: string }): string {
  return `${(req.method ?? "GET").toUpperCase()} ${req.url}`;
}

/** Wrap a real network capability, appending each exchange to `sink` (sanitized). */
export function recordingNetwork(raw: NetworkCapability, sink: CassetteEntry[]): NetworkCapability {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const response = await raw.request(req);
      const entry: CassetteEntry = {
        request: { method: (req.method ?? "GET").toUpperCase(), url: req.url },
        response: { ...response, headers: redactHeaders(response.headers) },
      };
      if (req.body !== undefined) entry.request.body = req.body;
      sink.push(entry);
      return response;
    },
  };
}

/** A network capability that answers only from a cassette; unknown requests throw. */
export function replayNetwork(cassette: Cassette): NetworkCapability {
  const byKey = new Map<string, HttpResponse>();
  for (const entry of cassette.entries) byKey.set(matchKey(entry.request), entry.response);
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const hit = byKey.get(matchKey(req));
      if (!hit) {
        throw new Error(`no cassette entry for ${matchKey(req)} (re-record the fixture?)`);
      }
      return hit;
    },
  };
}
