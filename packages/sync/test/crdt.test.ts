/**
 * The merge primitives. `mergeEnvelope` must be a semilattice join — commutative, associative,
 * idempotent — or replicas that saw the same writes in a different order end up in different
 * states. The progress cases carry the load-bearing guarantee: read position never rolls back.
 */
import { describe, expect, test } from "bun:test";
import { Clock, isLive, mergeEnvelope, type Envelope, type Progress, type Register, type SetElement } from "../src/index.ts";

const clock = new Clock("device-a", (() => {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
})());
const stamp = () => clock.send();

const reg = (value: unknown, hlc = stamp(), deleted = false): Register => ({ kind: "register", hlc, value, deleted });
const elem = (present: boolean, hlc = stamp()): SetElement => ({ kind: "set", hlc, present });
const prog = (p: Partial<Progress> & { hlc?: string }): Progress => ({
  kind: "progress",
  hlc: p.hlc ?? stamp(),
  read: p.read ?? false,
  lastPage: p.lastPage ?? 0,
  pageCount: p.pageCount ?? 100,
  ...(p.number !== undefined ? { number: p.number } : {}),
  ...(p.languageCode !== undefined ? { languageCode: p.languageCode } : {}),
});

describe("register — last-write-wins with tombstones", () => {
  test("the later stamp wins", () => {
    const early = reg("old");
    const late = reg("new");
    expect((mergeEnvelope(early, late) as Register).value).toBe("new");
    expect((mergeEnvelope(late, early) as Register).value).toBe("new");
  });

  test("a later delete tombstones the value; an earlier delete does not", () => {
    const value = reg("kept");
    const laterDelete = reg(null, stamp(), true);
    expect(isLive(mergeEnvelope(value, laterDelete))).toBe(false);

    const earlyDelete = reg(null, "000000000000001:000000:device-z", true);
    expect(isLive(mergeEnvelope(earlyDelete, reg("resurrected")))).toBe(true);
  });
});

describe("set — LWW-element membership", () => {
  test("the later stamp decides presence", () => {
    const added = elem(true);
    const removed = elem(false);
    expect(isLive(mergeEnvelope(added, removed))).toBe(false);
    expect(isLive(mergeEnvelope(removed, added))).toBe(false); // same pair, same winner
  });
});

describe("progress — monotonic, NOT last-write-wins", () => {
  test("a LATER write with a SMALLER page does not roll read position back", () => {
    const far = prog({ lastPage: 40, pageCount: 50 });
    const staleButLater = prog({ lastPage: 10, pageCount: 50 }); // later HLC, earlier position

    for (const merged of [mergeEnvelope(far, staleButLater), mergeEnvelope(staleButLater, far)]) {
      expect((merged as Progress).lastPage).toBe(40);
    }
  });

  test("read is a logical OR — once read anywhere, it stays read", () => {
    const read = prog({ read: true, lastPage: 50 });
    const laterUnread = prog({ read: false, lastPage: 50 });
    expect((mergeEnvelope(read, laterUnread) as Progress).read).toBe(true);
  });

  test("pageCount takes the max, and a known chapter number survives an unknown one", () => {
    const known = prog({ pageCount: 80, number: 12.5 });
    const unknown = prog({ pageCount: 20 });
    const merged = mergeEnvelope(known, unknown) as Progress;
    expect(merged.pageCount).toBe(80);
    expect(merged.number).toBe(12.5);
  });

  test("languageCode is LWW by stamp", () => {
    const first = prog({ languageCode: "en" });
    const second = prog({ languageCode: "ja" });
    expect((mergeEnvelope(first, second) as Progress).languageCode).toBe("ja");
  });
});

describe("join laws", () => {
  const samples: Envelope[] = [
    reg("a"),
    reg("b"),
    prog({ lastPage: 5, read: false }),
    prog({ lastPage: 3, read: true }),
    prog({ lastPage: 9, pageCount: 200 }),
  ];

  const pairs = (of: Envelope[]) => of.flatMap((a) => of.map((b) => [a, b] as const)).filter(([a, b]) => a.kind === b.kind);

  test("commutative", () => {
    for (const [a, b] of pairs(samples)) {
      expect(mergeEnvelope(a, b)).toEqual(mergeEnvelope(b, a));
    }
  });

  test("idempotent", () => {
    for (const e of samples) expect(mergeEnvelope(e, e)).toEqual(e);
  });

  test("associative", () => {
    const progs = samples.filter((e) => e.kind === "progress");
    for (const a of progs) {
      for (const b of progs) {
        for (const c of progs) {
          expect(mergeEnvelope(mergeEnvelope(a, b), c)).toEqual(mergeEnvelope(a, mergeEnvelope(b, c)));
        }
      }
    }
  });
});

test("merging different kinds at the same address is a bug, not a silent coercion", () => {
  expect(() => mergeEnvelope(reg("x"), elem(true))).toThrow(/refusing to merge/);
});
