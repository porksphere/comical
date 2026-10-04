/**
 * The hub over real HTTP: two engines, each through `HttpBackend`, meeting at `createRouter`'s
 * `/sync` mount, plus the on-disk segment store's crash recovery.
 */
import { join } from "node:path";
import { appendFile, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpBackend, recordKey, SeqConflictError, SyncEngine, SyncHub, type Segment, type SyncStore, type TableId } from "@comical/sync";
import { BridgeManager } from "../src/bridge-manager.ts";
import { createRouter } from "../src/router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { FileSegmentStore } from "../src/sync-segment-store.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");
const DATA_DIR = join(import.meta.dir, ".tmp-sync");
const TOKEN = "sync-test-token";
const HLC = "001700000000000:000000:a";

let baseUrl: string;
let stop: () => void;

beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
  const hub = await SyncHub.open(new FileSegmentStore(join(DATA_DIR, "sync")));
  const srv = Bun.serve({ port: 0, fetch: createRouter(manager, { token: TOKEN, sync: hub }).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(async () => {
  stop();
  await rm(DATA_DIR, { recursive: true, force: true });
});

class MapStore implements SyncStore {
  readonly data = new Map<string, unknown>();
  async read(table: TableId, id: string) {
    return this.data.get(recordKey(table, id));
  }
  async write(table: TableId, id: string, value: unknown) {
    if (value === undefined) this.data.delete(recordKey(table, id));
    else this.data.set(recordKey(table, id), value);
  }
}

const backend = (token = TOKEN) => new HttpBackend({ baseUrl, token, fetch: (url, init) => fetch(url, init) });
const seg = (device: string, seq: number, value: unknown): Segment => ({
  device,
  seq,
  records: [{ table: "groups", id: "g", env: { kind: "register", hlc: HLC, value, deleted: false } }],
});

describe("/sync over HTTP", () => {
  test("a change pushed by one device is pulled by another", async () => {
    const a = new MapStore();
    const b = new MapStore();
    const ea = new SyncEngine({ store: a, backend: backend(), device: "http-a", name: () => "A", newDeviceId: () => "http-a2" });
    const eb = new SyncEngine({ store: b, backend: backend(), device: "http-b", name: () => "B", newDeviceId: () => "http-b2" });
    await ea.exclusive(async () => {
      await a.write("collections", "c1", { id: "c1", name: "Faves", order: 0 });
      ea.touch("collections", "c1");
    });
    expect(await ea.sync()).toMatchObject({ pushed: 1 });
    await eb.sync();
    expect(b.data.get(recordKey("collections", "c1"))).toEqual({ id: "c1", name: "Faves", order: 0 });
  });

  test("a reused seq comes back as a SeqConflictError the engine can act on", async () => {
    await backend().push(seg("http-c", 1, "first"));
    await expect(backend().push(seg("http-c", 1, "second"))).rejects.toBeInstanceOf(SeqConflictError);
  });

  test("malformed bodies are 400, and the token is required", async () => {
    const post = (path: string, body: unknown, token = TOKEN) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    expect((await post("/sync/push", { device: "../x", seq: 1, records: [] })).status).toBe(400);
    expect((await post("/sync/pull", { device: "x", name: "X", have: { a: -1 } })).status).toBe(400);
    // Who is pulling is not optional: a hub that lists its devices names them from these.
    expect((await post("/sync/pull", { have: {} })).status).toBe(400);
    expect((await post("/sync/pull", { device: "x", name: "X", have: {} }, "wrong")).status).toBe(401);
    await expect(backend("wrong").pull({ device: "x", name: "X", have: {} })).rejects.toThrow(/401/);
  });

  test("no hub, no routes", async () => {
    const manager = new BridgeManager({ bridgesDir: BRIDGES_DIR, dataDir: DATA_DIR, settings: new SettingsStore(DATA_DIR) });
    const srv = Bun.serve({ port: 0, fetch: createRouter(manager).fetch });
    try {
      const res = await fetch(`http://localhost:${srv.port}/sync/pull`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});

describe("FileSegmentStore", () => {
  test("a half-written last line is dropped and cut from the file", async () => {
    const dir = join(DATA_DIR, "torn");
    const store = new FileSegmentStore(dir);
    await store.load();
    await store.append(seg("d", 1, 1));
    await store.append(seg("d", 2, 2));
    await appendFile(join(dir, "d.jsonl"), '{"device":"d","seq":3,"rec');

    const reopened = await SyncHub.open(new FileSegmentStore(dir));
    expect(reopened.heads()).toEqual({ d: 2 });
    await reopened.push(seg("d", 3, 3));
    const lines = (await readFile(join(dir, "d.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as Segment).seq)).toEqual([1, 2, 3]);
  });
});
