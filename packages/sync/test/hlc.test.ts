/**
 * The clock. Two properties matter: a device's own stamps strictly increase (so its writes never
 * tie), and packed stamps sort lexically in the same order they sort numerically — the cursor is a
 * bare string, so `a < b` on the packed form has to mean "a happened before b".
 */
import { describe, expect, test } from "bun:test";
import { Clock, compare, comparePacked, pack, unpack, type Hlc } from "../src/index.ts";

const at = (t: number) => () => t;

describe("packing", () => {
  test("round-trips", () => {
    const h: Hlc = { physical: 1_700_000_000_000, counter: 7, node: "device-a" };
    expect(unpack(pack(h))).toEqual(h);
  });

  test("lexical order on packed stamps reproduces the numeric total order", () => {
    const stamps: Hlc[] = [
      { physical: 1, counter: 0, node: "a" },
      { physical: 1, counter: 1, node: "a" },
      { physical: 1, counter: 1, node: "b" },
      { physical: 2, counter: 0, node: "a" },
      { physical: 1_700_000_000_000, counter: 0, node: "a" },
    ];
    for (const a of stamps) {
      for (const b of stamps) {
        expect(Math.sign(comparePacked(pack(a), pack(b)))).toBe(Math.sign(compare(a, b)));
      }
    }
  });

  test("a big physical time still zero-pads to a sortable width", () => {
    // The padding is what makes the lexical shortcut valid — a wider number must not sort short.
    expect(comparePacked(pack({ physical: 9, counter: 0, node: "a" }), pack({ physical: 100, counter: 0, node: "a" }))).toBe(-1);
  });
});

describe("Clock", () => {
  test("stamps strictly increase even when the wall clock stands still", () => {
    const c = new Clock("device-a", at(1000));
    const stamps = [c.send(), c.send(), c.send()];
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(3);
  });

  test("stamps still increase when the wall clock goes BACKWARDS", () => {
    let t = 5000;
    const c = new Clock("device-a", () => t);
    const first = c.send();
    t = 1000; // NTP correction, timezone nonsense, a user changing the clock
    const second = c.send();
    expect(comparePacked(second, first)).toBe(1);
  });

  test("recv advances past a remote stamp, so the next local write sorts after what we've seen", () => {
    const c = new Clock("device-a", at(1000));
    const remote = pack({ physical: 9_999_999, counter: 3, node: "device-b" });
    c.recv(remote);
    expect(comparePacked(c.send(), remote)).toBe(1);
  });

  test("two devices at the same instant never collide — the node id breaks the tie", () => {
    const a = new Clock("device-a", at(1000));
    const b = new Clock("device-b", at(1000));
    expect(a.send()).not.toBe(b.send());
  });
});
