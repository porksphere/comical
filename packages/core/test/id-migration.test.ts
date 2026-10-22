import { describe, expect, test } from "bun:test";
import type { HostCapabilities } from "@comical/contract";
import { BridgeContractError, BridgeValidationError, loadBridge } from "../src/index.ts";

function mockHost(): HostCapabilities {
  return {
    network: { request: async () => ({ url: "", status: 200, statusText: "OK", headers: {}, body: "" }) },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      secure: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
  };
}

const info = (migratesIds: boolean) =>
  JSON.stringify({
    id: "mig",
    name: "Mig",
    version: "2.0.0",
    contractVersion: "2.1.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["search"],
    ...(migratesIds ? { migratesIds } : {}),
  });

const BRIDGE = (body: string, migratesIds = true) =>
  `module.exports = { default: (host) => ({ info: ${info(migratesIds)}, getSeriesDetails: async (id) => ({ id, title: "T" }), ${body} }) };`;

describe("loader migrateIds", () => {
  test("exposes migrateIds, its answer validated and defaulted", async () => {
    const b = await loadBridge({
      code: BRIDGE(`migrateIds: async (req) => ({
        series: req.series.map((s) => ({ id: s.id, newId: "n-" + s.id, chapters: s.chapterIds.map((c) => ({ id: c, newId: "n-" + c })) })),
      })`),
      capabilities: mockHost(),
    });
    expect(await b.migrateIds!({ fromVersion: "1.0.0", series: [{ id: "a", chapterIds: ["c"] }] })).toEqual({
      series: [{ id: "a", newId: "n-a", chapters: [{ id: "c", newId: "n-c" }] }],
    });

    const empty = await loadBridge({ code: BRIDGE(`migrateIds: async () => ({ failed: ["a"] })`), capabilities: mockHost() });
    expect(await empty.migrateIds!({ fromVersion: null, series: [{ id: "a", chapterIds: [] }] })).toEqual({ series: [], failed: ["a"] });
  });

  test("rejects an answer with an empty new id", async () => {
    const b = await loadBridge({ code: BRIDGE(`migrateIds: async () => ({ series: [{ id: "a", newId: "" }] })`), capabilities: mockHost() });
    await expect(b.migrateIds!({ fromVersion: null, series: [{ id: "a", chapterIds: [] }] })).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("rejects a malformed request before the bridge sees it", async () => {
    const b = await loadBridge({ code: BRIDGE(`migrateIds: async () => ({ series: [] })`), capabilities: mockHost() });
    await expect(b.migrateIds!({ fromVersion: "", series: [] })).rejects.toBeInstanceOf(BridgeValidationError);
    await expect(b.migrateIds!({ fromVersion: null, series: [{ id: "", chapterIds: [] }] })).rejects.toBeInstanceOf(BridgeValidationError);
  });

  test("refuses a bridge that declares migratesIds without migrateIds", async () => {
    await expect(loadBridge({ code: BRIDGE(""), capabilities: mockHost() })).rejects.toBeInstanceOf(BridgeContractError);
  });

  test("a bridge that doesn't declare it has no migrateIds", async () => {
    const b = await loadBridge({ code: BRIDGE(`migrateIds: async () => ({ series: [] })`, false), capabilities: mockHost() });
    expect(b.migrateIds).toBeUndefined();
  });
});
