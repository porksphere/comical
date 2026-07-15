/**
 * The hub's boundary. Everything here is what the server refuses to let into its store — the
 * malformed-HLC cases matter most, since a stamp that doesn't zero-pad would sort wrong forever and
 * silently strand a device behind a cursor it can never pass.
 */
import { describe, expect, test } from "bun:test";
import { isValidAccountId, parseCursor, parseSyncRecords, RecordSet, type SyncRecord } from "../src/index.ts";

const HLC = "001700000000000:000000:device-a";
const LATER = "001700000000001:000000:device-a";

const record = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  table: "entries",
  id: "bridge:series-1",
  env: { kind: "register", hlc: HLC, value: { title: "x" }, deleted: false },
  ...over,
});

describe("parseSyncRecords", () => {
  test("accepts a well-formed batch", () => {
    const result = parseSyncRecords([record()]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records[0]!.id).toBe("bridge:series-1");
  });

  test("rejects a table that is not on the sync allow-list", () => {
    const result = parseSyncRecords([record({ table: "secrets" as SyncRecord["table"] })]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/unknown sync table/);
  });

  test("rejects a malformed HLC — an unpadded stamp would break the cursor's lexical order", () => {
    const bad = parseSyncRecords([record({ env: { kind: "register", hlc: "17:0:a", value: 1, deleted: false } })]);
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/malformed HLC/);
  });

  test("rejects an envelope whose kind is unknown, and a non-array body", () => {
    expect(parseSyncRecords([record({ env: { kind: "nonsense" } as never })])).toMatchObject({ ok: false });
    expect(parseSyncRecords({ not: "an array" })).toMatchObject({ ok: false });
  });

  test("rejects a negative page — read position is an index, not a signal", () => {
    const bad = parseSyncRecords([
      record({ table: "progress", env: { kind: "progress", hlc: HLC, read: false, lastPage: -1, pageCount: 10 } }),
    ]);
    expect(bad).toMatchObject({ ok: false });
  });
});

describe("parseCursor", () => {
  test("an absent cursor means 'from the beginning'", () => {
    expect(parseCursor(null)).toEqual({ ok: true, cursor: null });
    expect(parseCursor("")).toEqual({ ok: true, cursor: null });
  });

  test("accepts a packed stamp and rejects junk", () => {
    expect(parseCursor(HLC)).toEqual({ ok: true, cursor: HLC });
    expect(parseCursor("../../etc/passwd")).toMatchObject({ ok: false });
  });
});

describe("isValidAccountId", () => {
  test("accepts a derived id, rejects anything that could escape a filename", () => {
    expect(isValidAccountId("a1B2-_x")).toBe(true);
    expect(isValidAccountId("../etc/passwd")).toBe(false);
    expect(isValidAccountId("has space")).toBe(false);
    expect(isValidAccountId("")).toBe(false);
    expect(isValidAccountId(null)).toBe(false);
    expect(isValidAccountId("x".repeat(129))).toBe(false);
  });
});

describe("RecordSet", () => {
  test("merges by (table, id) and serves everything past a cursor", () => {
    const set = new RecordSet();
    set.merge([record()]);
    set.merge([record({ id: "bridge:series-2", env: { kind: "register", hlc: LATER, value: 2, deleted: false } })]);

    expect(set.size).toBe(2);
    expect(set.since(null).records).toHaveLength(2);
    expect(set.since(null).cursor).toBe(LATER);

    const delta = set.since(HLC);
    expect(delta.records.map((r) => r.id)).toEqual(["bridge:series-2"]);
  });

  test("the same table id in different tables is a different record", () => {
    const set = new RecordSet();
    set.merge([record({ table: "entries", id: "same" })]);
    set.merge([record({ table: "lists", id: "same" })]);
    expect(set.size).toBe(2);
  });

  test("re-pushing is idempotent, and progress merges monotonically inside the set", () => {
    const set = new RecordSet();
    const far: SyncRecord = {
      table: "progress",
      id: "bridge:series-1",
      env: { kind: "progress", hlc: HLC, read: false, lastPage: 40, pageCount: 50 },
    };
    const staleButLater: SyncRecord = {
      table: "progress",
      id: "bridge:series-1",
      env: { kind: "progress", hlc: LATER, read: false, lastPage: 10, pageCount: 50 },
    };

    set.merge([far, far, staleButLater]);
    expect(set.size).toBe(1);
    const [merged] = set.all();
    expect(merged!.env).toMatchObject({ kind: "progress", lastPage: 40 });
  });

  test("a cursor never moves backwards, even when nothing is newer", () => {
    const set = new RecordSet([record()]);
    expect(set.since(LATER)).toEqual({ records: [], cursor: LATER });
  });
});
