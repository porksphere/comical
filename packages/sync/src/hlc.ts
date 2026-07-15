/**
 * Hybrid Logical Clock — the ordering primitive the whole sync core is built on. It stays close to
 * wall-clock time for readability, never goes backwards on a given device, and breaks ties
 * deterministically by device id so any two replicas that have seen the same writes agree on their
 * order. Devices have no shared server and their wall clocks drift, so a plain timestamp is unusable
 * here — see comical-app's docs/CROSS-DEVICE-SYNC.md.
 *
 * Packed form is `"<physical:15>:<counter:6>:<node>"`: zero-padded so a plain lexical string compare
 * on packed stamps reproduces the numeric total order, which lets the sync cursor be a bare string.
 */
export type Hlc = { physical: number; counter: number; node: string };

const PHYS = 15;
const CTR = 6;

export function pack(h: Hlc): string {
  return `${String(h.physical).padStart(PHYS, "0")}:${String(h.counter).padStart(CTR, "0")}:${h.node}`;
}

export function unpack(s: string): Hlc {
  const i = s.indexOf(":");
  const j = s.indexOf(":", i + 1);
  return { physical: Number(s.slice(0, i)), counter: Number(s.slice(i + 1, j)), node: s.slice(j + 1) };
}

/** Total order: physical, then counter, then node id. Returns -1 | 0 | 1. */
export function compare(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

/** Lexical compare of packed stamps — equivalent to `compare(unpack(a), unpack(b))`, no parse. */
export function comparePacked(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A per-device logical clock. `now` (a wall-clock-ms source) is injected so tests drive it
 * deterministically; in the app it's `Date.now`.
 */
export class Clock {
  private last: Hlc;

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
  ) {
    this.last = { physical: 0, counter: 0, node };
  }

  /** Stamp a local write. Monotonic: strictly greater than every stamp this clock has issued. */
  send(): string {
    const wall = this.now();
    this.last =
      wall > this.last.physical
        ? { physical: wall, counter: 0, node: this.node }
        : { physical: this.last.physical, counter: this.last.counter + 1, node: this.node };
    return pack(this.last);
  }

  /** Advance on observing a remote stamp, so subsequent local writes sort after what we've seen. */
  recv(remotePacked: string): void {
    const remote = unpack(remotePacked);
    const wall = this.now();
    const lp = this.last.physical;
    const rp = remote.physical;
    if (wall > lp && wall > rp) this.last = { physical: wall, counter: 0, node: this.node };
    else if (lp === rp) this.last = { physical: lp, counter: Math.max(this.last.counter, remote.counter) + 1, node: this.node };
    else if (lp > rp) this.last = { physical: lp, counter: this.last.counter + 1, node: this.node };
    else this.last = { physical: rp, counter: remote.counter + 1, node: this.node };
  }
}
