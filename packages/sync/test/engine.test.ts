import { describe, expect, test } from "bun:test";
import {
  MemoryBackend,
  recordKey,
  SyncEngine,
  type ProgressValue,
  type SyncBackend,
  type SyncStateSnapshot,
  type SyncStore,
  type TableId,
  type VersionVector,
} from "../src/index.ts";

class MemoryStore implements SyncStore {
  readonly data = new Map<string, unknown>();
  async read(table: TableId, id: string) {
    return this.data.get(recordKey(table, id));
  }
  async write(table: TableId, id: string, value: unknown) {
    if (value === undefined) this.data.delete(recordKey(table, id));
    else this.data.set(recordKey(table, id), value);
  }
}

let ids = 0;
let wall = 1_700_000_000_000;

/** One device: a store, an engine, and writes that go through both the way a host's would. */
function device(backend: SyncBackend, name: string, opts: { state?: SyncStateSnapshot; now?: () => number } = {}) {
  const store = new MemoryStore();
  let saved: SyncStateSnapshot | undefined;
  const engine = new SyncEngine({
    store,
    backend,
    device: name,
    ...(opts.state && { state: opts.state }),
    newDeviceId: () => `${name}-${++ids}`,
    persist: async (s) => {
      saved = structuredClone(s);
    },
    now: opts.now ?? (() => (wall += 10)),
  });
  const put = (table: TableId, id: string, value: unknown) =>
    engine.exclusive(async () => {
      await store.write(table, id, value);
      engine.touch(table, id);
    });
  const progress = (id: string, value: ProgressValue, rewind = false) =>
    engine.exclusive(async () => {
      await store.write("progress", id, value);
      engine.touch("progress", id, { rewind });
    });
  const get = (table: TableId, id: string) => store.data.get(recordKey(table, id));
  return { store, engine, put, progress, get, saved: () => saved };
}

describe("SyncEngine", () => {
  test("changes reach every other device", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("collections", "c1", { id: "c1", name: "Faves", order: 0 });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.get("collections", "c1")).toEqual({ id: "c1", name: "Faves", order: 0 });
  });

  test("an offline device's late push reaches readers that already moved past its stamps", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    const c = device(hub, "c");

    await b.put("groups", "late", { from: "b" }); // stamped now, pushed much later
    await a.put("groups", "early", { from: "a" });
    await a.engine.sync();
    await c.engine.sync();
    for (let i = 0; i < 5; i++) {
      await a.put("groups", `more-${i}`, i);
      await a.engine.sync();
      await c.engine.sync();
    }

    await b.engine.sync();
    await c.engine.sync();
    expect(c.get("groups", "late")).toEqual({ from: "b" });
  });

  test("concurrent edits to one record converge on the later write everywhere", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("collections", "c1", { name: "from a" });
    await b.put("collections", "c1", { name: "from b" });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("collections", "c1")).toEqual({ name: "from b" });
    expect(b.get("collections", "c1")).toEqual({ name: "from b" });
  });

  test("a delete propagates, and an older write can't resurrect it", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await b.put("collectionItems", "series:x", { v: 1 });
    await a.put("collectionItems", "series:x", { v: 2 });
    await a.put("collectionItems", "series:x", undefined);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("collectionItems", "series:x")).toBeUndefined();
    expect(b.get("collectionItems", "series:x")).toBeUndefined();
  });

  test("progress never rewinds from a later but shorter read", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.progress("p", { read: false, lastPage: 40, pageCount: 50 });
    await b.progress("p", { read: false, lastPage: 10, pageCount: 50 });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("progress", "p")).toEqual({ read: false, lastPage: 40, pageCount: 50 });
    expect(b.get("progress", "p")).toEqual({ read: false, lastPage: 40, pageCount: 50 });
  });

  test("marking a chapter unread syncs, and reading it again afterwards does too", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.progress("p", { read: true, lastPage: 49, pageCount: 50 });
    await a.engine.sync();
    await b.engine.sync();

    await b.progress("p", { read: false, lastPage: 0, pageCount: 50 }, true);
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("progress", "p")).toEqual({ read: false, lastPage: 0, pageCount: 50 });

    await a.progress("p", { read: false, lastPage: 7, pageCount: 50 });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.get("progress", "p")).toEqual({ read: false, lastPage: 7, pageCount: 50 });
  });

  test("sets carry membership and metadata", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("registries", "https://example.test/index.json", { name: "Example" });
    await a.engine.sync();
    await b.engine.sync();
    expect(b.get("registries", "https://example.test/index.json")).toEqual({ name: "Example" });
    await b.put("registries", "https://example.test/index.json", undefined);
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("registries", "https://example.test/index.json")).toBeUndefined();
  });

  test("repeated writes to one record between syncs send one record", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    for (let i = 0; i < 10; i++) await a.put("groups", "g", i);
    expect(await a.engine.sync()).toMatchObject({ pushed: 1 });
    expect(hub.log.all()[0]!.records[0]!.env).toMatchObject({ value: 9 });
  });

  test("a sync with nothing new moves nothing", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("groups", "g", 1);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.engine.sync()).toEqual({ pushed: 0, pulled: 0, applied: 0 });
  });

  test("large backlogs split into segments and pull in pages", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    for (let i = 0; i < 25; i++) await a.put("groups", `g${i}`, i);
    const big = new SyncEngine({
      store: a.store,
      backend: hub,
      state: a.engine.snapshot(),
      newDeviceId: () => "x",
      segmentSize: 10,
    });
    await big.sync();
    expect(hub.log.all().map((s) => s.records.length)).toEqual([10, 10, 5]);

    const b = device(hub, "b");
    const paged = new SyncEngine({ store: b.store, backend: hub, device: "b", newDeviceId: () => "y", pullLimit: 10 });
    expect(await paged.sync()).toMatchObject({ pulled: 25, applied: 25 });
    expect(paged.snapshot().vector).toEqual({ a: 3 });
  });

  test("a push that landed but was never acknowledged is re-sent, not duplicated", async () => {
    const hub = new MemoryBackend();
    let dropAck = true;
    const flaky: SyncBackend = {
      async push(seg) {
        await hub.push(seg);
        if (dropAck) throw new Error("connection reset");
      },
      pull: (have, limit) => hub.pull(have, limit),
    };
    const a = device(flaky, "a");
    await a.put("groups", "g", 1);
    await expect(a.engine.sync()).rejects.toThrow("connection reset");

    // Restarted from what it persisted, the device still holds the segment as pending.
    const restarted = device(flaky, "a", { state: a.saved()! });
    restarted.store.data.set(recordKey("groups", "g"), 1);
    dropAck = false;
    await restarted.engine.sync();
    expect(hub.log.heads()).toEqual({ a: 1 });
    expect(restarted.engine.hasUnsent()).toBe(false);
  });

  test("a device restored from a backup carries on under a new id and pulls what it lost", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await a.put("groups", "g1", 1);
    await a.engine.sync();
    const backup = structuredClone(a.engine.snapshot());
    const backupData = new Map(a.store.data);

    await a.put("groups", "g2", 2);
    await a.engine.sync();

    const restored = device(hub, "a", { state: backup });
    for (const [k, v] of backupData) restored.store.data.set(k, v);
    await restored.put("groups", "g3", 3);
    await restored.engine.sync();

    expect(restored.engine.deviceId).not.toBe("a");
    expect(restored.get("groups", "g2")).toBe(2);
    const b = device(hub, "b");
    await b.engine.sync();
    expect([b.get("groups", "g1"), b.get("groups", "g2"), b.get("groups", "g3")]).toEqual([1, 2, 3]);
  });

  test("concurrent sync calls share one round", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await a.put("groups", "g", 1);
    const [x, y] = await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(x).toBe(y);
    expect(hub.log.heads()).toEqual({ a: 1 });
  });

  test("a local write while a pull is applying is not stamped over by the remote value", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("groups", "g", "from a");
    await a.engine.sync();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowPull: SyncBackend = {
      push: (s) => hub.push(s),
      async pull(have: VersionVector, limit?: number) {
        const r = await hub.pull(have, limit);
        await gate;
        return r;
      },
    };
    const slow = new SyncEngine({ store: b.store, backend: slowPull, device: "b", newDeviceId: () => "z" });
    const round = slow.sync();
    const local = slow.exclusive(async () => {
      await b.store.write("groups", "g", "from b");
      slow.touch("groups", "g");
    });
    release();
    await Promise.all([round, local]);
    await slow.sync();
    await a.engine.sync();
    expect(b.get("groups", "g")).toBe("from b");
    expect(a.get("groups", "g")).toBe("from b");
  });

  test("a delete in the history first pulled doesn't remove a copy that was already here", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    // `kept`'s creation and deletion reach the hub as two segments; `brief` only ever as a delete.
    await a.put("collections", "kept", { id: "kept", name: "From a" });
    await a.engine.sync();
    await a.put("collections", "kept", undefined);
    await a.put("collections", "brief", undefined);
    await a.engine.sync();

    // Held before sync was ever on, so unstamped.
    await b.store.write("collections", "kept", { id: "kept", name: "From b" });
    await b.store.write("collections", "brief", { id: "brief", name: "Only b" });
    await b.engine.sync();
    expect(b.get("collections", "kept")).toBeDefined();
    expect(b.get("collections", "brief")).toEqual({ id: "brief", name: "Only b" });

    // And they go back out as new writes, rather than staying a silent disagreement.
    await b.engine.sync();
    await a.engine.sync();
    expect(a.get("collections", "kept")).toEqual(b.get("collections", "kept"));
    expect(a.get("collections", "brief")).toEqual({ id: "brief", name: "Only b" });
  });

  test("once that pull is done, a delete of the same record applies", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    const b = device(hub, "b");
    await a.put("collections", "c1", { id: "c1", name: "From a" });
    await a.engine.sync();
    await b.store.write("collections", "c1", { id: "c1", name: "From b" });
    await b.engine.sync();
    expect(b.get("collections", "c1")).toEqual({ id: "c1", name: "From a" });
    expect(b.saved()?.held).toBeUndefined();

    await a.put("collections", "c1", undefined);
    await a.engine.sync();
    await b.engine.sync();
    expect(b.get("collections", "c1")).toBeUndefined();
  });

  test("a first pull cut short keeps protecting the copy when it resumes", async () => {
    const hub = new MemoryBackend();
    const a = device(hub, "a");
    await a.put("collections", "c1", { id: "c1", name: "From a" });
    await a.engine.sync();
    await a.put("collections", "c1", undefined);
    await a.engine.sync();

    const store = new MemoryStore();
    await store.write("collections", "c1", { id: "c1", name: "From b" });
    let saved: SyncStateSnapshot | undefined;
    const persist = async (s: SyncStateSnapshot) => void (saved = structuredClone(s));
    // One segment a page, and the connection drops after the first.
    let pulls = 0;
    const dropping: SyncBackend = {
      push: (s) => hub.push(s),
      async pull(have: VersionVector) {
        if (pulls++ === 1) throw new Error("offline");
        return hub.pull(have, 1);
      },
    };
    const first = new SyncEngine({ store, backend: dropping, device: "b", newDeviceId: () => "z", persist });
    await expect(first.sync()).rejects.toThrow("offline");
    expect(saved?.held).toEqual([recordKey("collections", "c1")]);

    // The app restarts: a new engine over the saved state.
    const resumed = new SyncEngine({ store, backend: hub, state: saved!, newDeviceId: () => "z", persist });
    await resumed.sync();
    expect(await store.read("collections", "c1")).toEqual({ id: "c1", name: "From a" });
    expect(saved?.held).toBeUndefined();
    await resumed.sync();
    await a.engine.sync();
    expect(a.get("collections", "c1")).toEqual({ id: "c1", name: "From a" });
  });

  test("a device id is required on first run", () => {
    expect(() => new SyncEngine({ store: new MemoryStore(), backend: new MemoryBackend(), newDeviceId: () => "x" })).toThrow(
      /device id/,
    );
  });
});
