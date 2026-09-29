import { describe, expect, test } from "bun:test";
import { MemorySegmentStore, SeqConflictError, SeqGapError, SyncHub, type Segment } from "../src/index.ts";

const HLC = "001700000000000:000000:a";
const seg = (device: string, seq: number, value: unknown = seq): Segment => ({
  device,
  seq,
  records: [{ table: "groups", id: `${device}-${seq}`, env: { kind: "register", hlc: HLC, value, deleted: false } }],
});

describe("SyncHub", () => {
  test("what it accepted survives a reopen", async () => {
    const store = new MemorySegmentStore();
    const hub = await SyncHub.open(store);
    await hub.push(seg("a", 1));
    await hub.push(seg("a", 2));
    await hub.push(seg("b", 1));
    const reopened = await SyncHub.open(store);
    expect(reopened.heads()).toEqual({ a: 2, b: 1 });
    expect((await reopened.pull({ a: 1 })).segments.map((s) => `${s.device}${s.seq}`)).toEqual(["a2", "b1"]);
  });

  test("a re-push is stored once; a reused seq and a gap are refused", async () => {
    const store = new MemorySegmentStore();
    const hub = await SyncHub.open(store);
    await hub.push(seg("a", 1));
    await hub.push(seg("a", 1));
    expect(store.segments).toHaveLength(1);
    await expect(hub.push(seg("a", 1, "other"))).rejects.toBeInstanceOf(SeqConflictError);
    await expect(hub.push(seg("a", 3))).rejects.toBeInstanceOf(SeqGapError);
  });

  test("a segment the store failed to keep is never served", async () => {
    const store = new MemorySegmentStore();
    const hub = await SyncHub.open({
      load: () => store.load(),
      append: async () => {
        throw new Error("disk full");
      },
    });
    await expect(hub.push(seg("a", 1))).rejects.toThrow("disk full");
    expect(hub.heads()).toEqual({});
  });

  test("concurrent pushes of the same seq store it once", async () => {
    const store = new MemorySegmentStore();
    const hub = await SyncHub.open(store);
    await Promise.all([hub.push(seg("a", 1)), hub.push(seg("a", 1))]);
    expect(store.segments).toHaveLength(1);
  });
});
