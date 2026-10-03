import { describe, expect, test } from "bun:test";
import { Clock, compare, comparePacked, MAX_DRIFT_MS, pack, unpack, type Hlc } from "../src/index.ts";

const at = (t: number) => () => t;

describe("packing", () => {
  test("round-trips", () => {
    const h: Hlc = { physical: 1_700_000_000_000, counter: 7, node: "device-a" };
    expect(unpack(pack(h))).toEqual(h);
  });

  test("lexical order on packed stamps is the numeric total order", () => {
    const stamps: Hlc[] = [
      { physical: 1, counter: 0, node: "a" },
      { physical: 1, counter: 1, node: "a" },
      { physical: 1, counter: 1, node: "b" },
      { physical: 2, counter: 0, node: "a" },
      { physical: 1_700_000_000_000, counter: 0, node: "a" },
    ];
    for (const a of stamps) {
      for (const b of stamps) expect(Math.sign(comparePacked(pack(a), pack(b)))).toBe(Math.sign(compare(a, b)));
    }
  });
});

describe("Clock", () => {
  test("stamps strictly increase even when the wall clock stalls or goes backwards", () => {
    let t = 1000;
    const clock = new Clock("a", () => t);
    const a = clock.send();
    const b = clock.send();
    t = 500;
    const c = clock.send();
    expect(comparePacked(a, b)).toBe(-1);
    expect(comparePacked(b, c)).toBe(-1);
  });

  test("after observing a remote stamp, local stamps sort after it", () => {
    const clock = new Clock("a", at(1000));
    const remote = new Clock("b", at(5000)).send();
    clock.recv(remote);
    expect(comparePacked(clock.send(), remote)).toBe(1);
  });

  test("a stamp far in the future is not followed", () => {
    const clock = new Clock("a", at(1000));
    clock.recv(new Clock("b", at(1000 + MAX_DRIFT_MS + 1)).send());
    expect(unpack(clock.send()).physical).toBe(1000);
  });

  test("a restored clock never re-issues a stamp from before the restart", () => {
    const before = new Clock("a", at(9000));
    const last = before.send();
    const after = new Clock("a", at(1000), last);
    expect(comparePacked(after.send(), last)).toBe(1);
  });
});
