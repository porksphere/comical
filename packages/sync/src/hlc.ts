/**
 * Hybrid Logical Clock: close to wall-clock time, never backwards on one device, and tie-broken by
 * device id so every device orders the same writes the same way. It decides last-write-wins between
 * devices whose wall clocks disagree. It is NOT a sync position — that is the per-device sequence
 * number (see log.ts); ordering delivery by stamp is what lost an offline device's late push.
 *
 * Packed form is `"<physical:15>:<counter:6>:<node>"`, zero-padded so a lexical compare of packed
 * stamps is the numeric total order.
 */
export type Hlc = { physical: number; counter: number; node: string };

const PHYS = 15;
const CTR = 6;
/**
 * A remote stamp further ahead of our wall clock than this is not followed. One device with its
 * clock set years ahead would otherwise drag every clock with it, and every later write on every
 * device would be stamped by counter alone until the 6-digit counter overflowed its padding.
 */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export function pack(h: Hlc): string {
  return `${String(h.physical).padStart(PHYS, "0")}:${String(h.counter).padStart(CTR, "0")}:${h.node}`;
}

export function unpack(s: string): Hlc {
  const i = s.indexOf(":");
  const j = s.indexOf(":", i + 1);
  return { physical: Number(s.slice(0, i)), counter: Number(s.slice(i + 1, j)), node: s.slice(j + 1) };
}

export function compare(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

export function comparePacked(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Clock {
  private last: Hlc;

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
    /** The last stamp issued before a restart, so a slow wall clock can't re-issue it. */
    restoredLast?: string,
  ) {
    const r = restoredLast ? unpack(restoredLast) : undefined;
    this.last = { physical: r?.physical ?? 0, counter: r?.counter ?? 0, node };
  }

  /** Strictly greater than every stamp this clock has issued or observed. */
  send(): string {
    const wall = this.now();
    this.last =
      wall > this.last.physical
        ? { physical: wall, counter: 0, node: this.node }
        : { physical: this.last.physical, counter: this.last.counter + 1, node: this.node };
    return pack(this.last);
  }

  recv(remotePacked: string): void {
    const remote = unpack(remotePacked);
    const wall = this.now();
    if (remote.physical > wall + MAX_DRIFT_MS) return;
    const lp = this.last.physical;
    const rp = remote.physical;
    if (wall > lp && wall > rp) this.last = { physical: wall, counter: 0, node: this.node };
    else if (lp === rp) this.last = { physical: lp, counter: Math.max(this.last.counter, remote.counter) + 1, node: this.node };
    else if (lp > rp) this.last = { physical: lp, counter: this.last.counter + 1, node: this.node };
    else this.last = { physical: rp, counter: remote.counter + 1, node: this.node };
  }

  current(): string {
    return pack(this.last);
  }
}
