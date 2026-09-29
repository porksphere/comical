import { describe, expect, test } from "bun:test";
import { Clock, envelopeChanges, isLive, mergeEnvelope, type Envelope, type Progress, type Register } from "../src/index.ts";

let t = 1_700_000_000_000;
const clock = new Clock("device-a", () => (t += 1000));
const stamp = () => clock.send();

const reg = (value: unknown, deleted = false): Register => ({ kind: "register", hlc: stamp(), value, deleted });
const prog = (p: Partial<Progress> = {}): Progress => ({
  kind: "progress",
  hlc: p.hlc ?? stamp(),
  read: p.read ?? false,
  lastPage: p.lastPage ?? 0,
  pageCount: p.pageCount ?? 100,
  ...(p.reset !== undefined && { reset: p.reset }),
  ...(p.number !== undefined && { number: p.number }),
  ...(p.languageCode !== undefined && { languageCode: p.languageCode }),
});

const fold = (envs: Envelope[]) => envs.reduce((a, b) => mergeEnvelope(a, b));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe("register", () => {
  test("the later stamp wins, in either order", () => {
    const early = reg("old");
    const late = reg("new");
    expect((mergeEnvelope(early, late) as Register).value).toBe("new");
    expect((mergeEnvelope(late, early) as Register).value).toBe("new");
  });

  test("a later delete tombstones; an earlier one does not", () => {
    const earlyDelete = reg(null, true);
    const value = reg("kept");
    const laterDelete = reg(null, true);
    expect(isLive(mergeEnvelope(value, laterDelete))).toBe(false);
    expect(isLive(mergeEnvelope(earlyDelete, value))).toBe(true);
  });

  test("refuses to merge different kinds", () => {
    expect(() => mergeEnvelope(reg(1), prog())).toThrow(/refusing/);
  });
});

describe("progress", () => {
  test("a later write with an earlier page does not rewind", () => {
    const far = prog({ lastPage: 40, read: true });
    const later = prog({ lastPage: 10 });
    for (const m of [mergeEnvelope(far, later), mergeEnvelope(later, far)] as Progress[]) {
      expect(m.lastPage).toBe(40);
      expect(m.read).toBe(true);
      expect(m.hlc).toBe(later.hlc);
    }
  });

  test("a newer reset epoch replaces the older one outright — mark-unread syncs", () => {
    const read = prog({ read: true, lastPage: 99 });
    const r = stamp();
    const unread = prog({ read: false, lastPage: 0, reset: r });
    for (const m of [mergeEnvelope(read, unread), mergeEnvelope(unread, read)] as Progress[]) {
      expect(m.read).toBe(false);
      expect(m.lastPage).toBe(0);
      expect(m.reset).toBe(r);
    }
  });

  test("reading after a reset moves forward again within the new epoch", () => {
    const r = stamp();
    const unread = prog({ reset: r });
    const reread = prog({ reset: r, lastPage: 5 });
    expect((mergeEnvelope(unread, reread) as Progress).lastPage).toBe(5);
  });

  test("the join is commutative and associative", () => {
    const r1 = stamp();
    const r2 = stamp();
    const envs: Envelope[] = [
      prog({ lastPage: 3, number: 1, languageCode: "en" }),
      prog({ lastPage: 9, read: true }),
      prog({ reset: r1, lastPage: 2 }),
      prog({ reset: r2, lastPage: 1, languageCode: "en" }),
      prog({ reset: r2, lastPage: 4, pageCount: 120 }),
    ];
    const results = permutations(envs).map((p) => JSON.stringify(fold(p)));
    expect(new Set(results).size).toBe(1);
    const m = fold(envs) as Progress;
    expect(m.reset).toBe(r2);
    expect(m.lastPage).toBe(4);
    expect(m.pageCount).toBe(120);
  });

  test("merging is idempotent", () => {
    const a = prog({ lastPage: 3 });
    expect(mergeEnvelope(a, a)).toEqual(a);
  });
});

describe("envelopeChanges", () => {
  test("a register that loses changes nothing", () => {
    const late = reg("new");
    expect(envelopeChanges(late, reg("newer"))).toBe(true);
    const early: Register = { ...reg("x"), hlc: "000000000000001:000000:z" };
    expect(envelopeChanges(late, early)).toBe(false);
  });

  test("progress that is already covered changes nothing, even with a newer stamp", () => {
    const local = prog({ lastPage: 40 });
    expect(envelopeChanges(local, prog({ lastPage: 10 }))).toBe(false);
    expect(envelopeChanges(local, prog({ lastPage: 41 }))).toBe(true);
    expect(envelopeChanges(undefined, prog())).toBe(true);
  });
});
