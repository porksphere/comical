/**
 * Proves the record/replay linchpin: a cassette captured at the network boundary replays
 * deterministically, driving the real bridge offline with no backend present.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { HostCapabilities, NetworkCapability } from "@comical/contract";
import { loadBridge } from "@comical/core";
import {
  type CassetteEntry,
  FixtureBackend,
  recordingNetwork,
  replayNetwork,
  silentLog,
} from "../src/index.ts";

const BUNDLE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js"),
  "utf8",
);

function host(network: NetworkCapability): HostCapabilities {
  const store = new Map<string, string>();
  return {
    network,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    log: silentLog,
    settings: { baseUrl: "http://fixture.local" },
  };
}

describe("record / replay", () => {
  test("a cassette recorded at the network boundary replays deterministically", async () => {
    const backend = new FixtureBackend();
    const entries: CassetteEntry[] = [];

    // Record: drive the bridge against the in-process backend through a recording network.
    const recording = recordingNetwork({ request: async (req) => backend.handle(req) }, entries);
    const recorded = loadBridge({ code: BUNDLE, capabilities: host(recording), expectedId: "example" });
    await recorded.getSearchResults!("sherlock", 1);
    await recorded.getSeriesDetails("sherlock");
    expect(entries.length).toBe(2);

    // Replay: same calls, no backend — answered purely from the cassette.
    const replayed = loadBridge({
      code: BUNDLE,
      capabilities: host(replayNetwork({ entries })),
      expectedId: "example",
    });
    const results = await replayed.getSearchResults!("sherlock", 1);
    expect(results.items[0]!.id).toBe("sherlock");
    const details = await replayed.getSeriesDetails("sherlock");
    expect(details.title).toContain("Sherlock");
  });

  test("replay throws for a request not in the cassette", async () => {
    const replayed = loadBridge({
      code: BUNDLE,
      capabilities: host(replayNetwork({ entries: [] })),
      expectedId: "example",
    });
    await expect(replayed.getSearchResults!("anything", 1)).rejects.toThrow(/no cassette entry/);
  });
});
