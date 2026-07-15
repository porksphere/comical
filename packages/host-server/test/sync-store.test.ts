/**
 * FileSyncStore: the hub's disk. The merge is @comical/sync's and tested there — what's tested here
 * is what this file adds. The concurrency case is the one with teeth: two devices pushing at once
 * both read-merge-write the same account file, so without the lock the second write would clobber
 * the first device's records entirely.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SyncRecord } from "@comical/sync";
import { FileSyncStore } from "../src/sync-store.ts";

const DIR = join(import.meta.dir, ".tmp-sync-store");

const hlc = (physical: number, node: string) => `${String(physical).padStart(15, "0")}:${"0".repeat(6)}:${node}`;

const entry = (id: string, at: number, node: string, title: string): SyncRecord => ({
  table: "entries",
  id,
  env: { kind: "register", hlc: hlc(at, node), value: { title }, deleted: false },
});

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("persistence", () => {
  test("a push survives a restart — a fresh store reads it back off disk", async () => {
    const store = new FileSyncStore(DIR);
    await store.push("acct", [entry("bridge:s1", 1000, "device-a", "Kept")]);

    const reopened = new FileSyncStore(DIR);
    const { records } = await reopened.pull("acct", null);
    expect(records).toHaveLength(1);
    expect(records[0]!.env).toMatchObject({ kind: "register", value: { title: "Kept" } });
  });

  test("each account is its own file, and pulling an unknown account is empty, not an error", async () => {
    const store = new FileSyncStore(DIR);
    await store.push("alice", [entry("bridge:a", 1000, "device-a", "A")]);
    await store.push("bob", [entry("bridge:b", 1000, "device-b", "B")]);

    expect(existsSync(join(DIR, "alice.json"))).toBe(true);
    expect(existsSync(join(DIR, "bob.json"))).toBe(true);

    expect(await store.pull("carol", null)).toEqual({ records: [], cursor: null });
  });

  test("an empty push doesn't create a file", async () => {
    const store = new FileSyncStore(DIR);
    await store.push("acct", []);
    expect(existsSync(join(DIR, "acct.json"))).toBe(false);
  });

  test("a corrupt account file reads as empty rather than throwing", async () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "acct.json"), "{ truncated", "utf8");
    const store = new FileSyncStore(DIR);
    expect(await store.pull("acct", null)).toEqual({ records: [], cursor: null });
  });

  test("no partial file is left behind — the write goes through a tmp and renames", async () => {
    const store = new FileSyncStore(DIR);
    await store.push("acct", [entry("bridge:s1", 1000, "device-a", "X")]);
    expect(existsSync(join(DIR, "acct.json.tmp"))).toBe(false);
    expect(() => JSON.parse(readFileSync(join(DIR, "acct.json"), "utf8"))).not.toThrow();
  });
});

describe("concurrency", () => {
  test("simultaneous pushes from two devices both survive — neither clobbers the other", async () => {
    const store = new FileSyncStore(DIR);

    // Fire them together, without awaiting in between: both read-merge-write the same account.
    await Promise.all([
      store.push("acct", [entry("bridge:from-a", 1000, "device-a", "A")]),
      store.push("acct", [entry("bridge:from-b", 2000, "device-b", "B")]),
    ]);

    const { records } = await store.pull("acct", null);
    expect(records.map((r) => r.id).sort()).toEqual(["bridge:from-a", "bridge:from-b"]);

    // And the survivor is on disk, not just in the cache.
    const onDisk = JSON.parse(readFileSync(join(DIR, "acct.json"), "utf8")) as SyncRecord[];
    expect(onDisk.map((r) => r.id).sort()).toEqual(["bridge:from-a", "bridge:from-b"]);
  });

  test("many concurrent pushes all land", async () => {
    const store = new FileSyncStore(DIR);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.push("acct", [entry(`bridge:s${i}`, 1000 + i, "device-a", `S${i}`)])),
    );
    const { records } = await store.pull("acct", null);
    expect(records).toHaveLength(25);
  });

  test("a failed push doesn't poison the next one on the same account", async () => {
    const store = new FileSyncStore(DIR);
    // A record whose envelope kind collides with an existing one makes the merge throw.
    await store.push("acct", [entry("bridge:s1", 1000, "device-a", "A")]);
    const collide: SyncRecord = {
      table: "entries",
      id: "bridge:s1",
      env: { kind: "set", hlc: hlc(2000, "device-b"), present: true },
    };
    expect(store.push("acct", [collide])).rejects.toThrow(/refusing to merge/);

    await store.push("acct", [entry("bridge:s2", 3000, "device-a", "B")]);
    const { records } = await store.pull("acct", null);
    expect(records.map((r) => r.id).sort()).toEqual(["bridge:s1", "bridge:s2"]);
  });
});

describe("account ids", () => {
  test("an id that could escape the directory is refused", async () => {
    const store = new FileSyncStore(DIR);
    expect(store.pull("../../etc/passwd", null)).rejects.toThrow(/invalid account id/);
    expect(store.push("..", [entry("x", 1, "a", "x")])).rejects.toThrow(/invalid account id/);
  });
});
