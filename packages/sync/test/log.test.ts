import { describe, expect, test } from "bun:test";
import { ChangeLog, parsePullRequest, parseSegment, parseVersionVector, SeqConflictError, SeqGapError, type Segment } from "../src/index.ts";

const HLC = "001700000000000:000000:a";
const seg = (device: string, seq: number, n = 1, value: unknown = seq): Segment => ({
  device,
  seq,
  records: Array.from({ length: n }, (_, i) => ({
    table: "groups" as const,
    id: `${device}-${seq}-${i}`,
    env: { kind: "register" as const, hlc: HLC, value, deleted: false },
  })),
});

describe("ChangeLog", () => {
  test("pull returns exactly what is past each device's position", () => {
    const log = new ChangeLog([seg("a", 1), seg("a", 2), seg("b", 1)]);
    const { segments, more } = log.pull({ a: 1 });
    expect(segments.map((s) => `${s.device}${s.seq}`)).toEqual(["a2", "b1"]);
    expect(more).toBe(false);
    expect(log.heads()).toEqual({ a: 2, b: 1 });
  });

  test("a re-push of a held segment is a no-op", () => {
    const log = new ChangeLog([seg("a", 1)]);
    expect(log.append(seg("a", 1))).toBe(false);
    expect(log.head("a")).toBe(1);
  });

  test("the same seq with different content is a conflict", () => {
    const log = new ChangeLog([seg("a", 1)]);
    expect(() => log.append(seg("a", 1, 1, "other"))).toThrow(SeqConflictError);
  });

  test("a gap is refused", () => {
    const log = new ChangeLog([seg("a", 1)]);
    expect(() => log.append(seg("a", 3))).toThrow(SeqGapError);
  });

  test("the limit pages by records but always admits one segment", () => {
    const log = new ChangeLog([seg("a", 1, 5), seg("a", 2, 5), seg("a", 3, 5)]);
    const first = log.pull({}, 7);
    expect(first.segments.map((s) => s.seq)).toEqual([1]);
    expect(first.more).toBe(true);
    expect(log.pull({}, 2).segments.map((s) => s.seq)).toEqual([1]);
    expect(log.pull({ a: 1 }, 10)).toEqual({ segments: [seg("a", 2, 5), seg("a", 3, 5)], more: false });
  });
});

describe("wire validation", () => {
  test("accepts a well-formed segment", () => {
    expect(parseSegment(seg("dev_1", 1)).ok).toBe(true);
  });

  test("rejects unknown tables, unsafe device ids and unpadded stamps", () => {
    const bad = (patch: (s: Segment) => unknown) => parseSegment(patch(structuredClone(seg("a", 1))));
    expect(bad((s) => ({ ...s, records: [{ ...s.records[0], table: "bridgeSettings" }] })).ok).toBe(false);
    expect(bad((s) => ({ ...s, device: "../etc" })).ok).toBe(false);
    expect(bad((s) => ({ ...s, records: [{ ...s.records[0], env: { ...s.records[0]!.env, hlc: "5:0:a" } }] })).ok).toBe(false);
    expect(bad((s) => ({ ...s, seq: 0 })).ok).toBe(false);
  });

  test("version vectors", () => {
    expect(parseVersionVector({ a: 3 })).toEqual({ ok: true, value: { a: 3 } });
    expect(parseVersionVector({ a: -1 }).ok).toBe(false);
  });

  test("a pull says who is asking, by a safe id and a readable name", () => {
    expect(parsePullRequest({ device: "app-1", name: "  A phone ", have: { a: 3 }, limit: 10 })).toEqual({
      ok: true,
      value: { device: "app-1", name: "A phone", have: { a: 3 }, limit: 10 },
    });
    expect(parsePullRequest({ have: {} }).ok).toBe(false);
    expect(parsePullRequest({ device: "app-1", have: {} }).ok).toBe(false);
    expect(parsePullRequest({ device: "app-1", name: "   ", have: {} }).ok).toBe(false);
    expect(parsePullRequest({ device: "app-1", name: "x".repeat(65), have: {} }).ok).toBe(false);
    expect(parsePullRequest({ device: "../x", name: "A phone", have: {} }).ok).toBe(false);
  });
});
