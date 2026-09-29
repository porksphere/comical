/**
 * The merge every device (and the hub) runs. `mergeEnvelope` is a join — commutative, associative,
 * idempotent — so devices that have seen the same changes agree, whatever order they arrived in.
 *
 *   - register — last-write-wins value with tombstone
 *   - set      — last-write-wins membership, with metadata riding on the element
 *   - progress — read position only moves FORWARD within a reset epoch. Not last-write-wins: a later
 *                write carrying an earlier page must not rewind you. `reset` is the way back: marking
 *                a chapter unread stamps a new epoch, and the newer epoch replaces the older one
 *                outright. Without it OR-ing `read` would make "mark unread" impossible to sync.
 */
import { comparePacked } from "./hlc.ts";

export type Register = { readonly kind: "register"; readonly hlc: string; readonly value: unknown; readonly deleted: boolean };
export type SetElement = {
  readonly kind: "set";
  readonly hlc: string;
  readonly present: boolean;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
};
export type Progress = {
  readonly kind: "progress";
  readonly hlc: string;
  /** Stamp of the last deliberate rewind; absent = never rewound. */
  readonly reset?: string | undefined;
  readonly read: boolean;
  readonly lastPage: number;
  readonly pageCount: number;
  readonly number?: number | undefined;
  readonly languageCode?: string | undefined;
};
export type Envelope = Register | SetElement | Progress;

export function mergeEnvelope(a: Envelope, b: Envelope): Envelope {
  if (a.kind !== b.kind) {
    throw new Error(`sync: refusing to merge ${a.kind} with ${b.kind} (record identity collision)`);
  }
  switch (a.kind) {
    case "register":
    case "set":
      return comparePacked(a.hlc, b.hlc) >= 0 ? a : b;
    case "progress":
      return mergeProgress(a, b as Progress);
  }
}

function mergeProgress(a: Progress, b: Progress): Progress {
  const hlc = comparePacked(a.hlc, b.hlc) >= 0 ? a.hlc : b.hlc;
  const ra = a.reset ?? "";
  const rb = b.reset ?? "";
  if (ra !== rb) {
    const winner = ra > rb ? a : b;
    const loser = winner === a ? b : a;
    return {
      ...winner,
      hlc,
      number: winner.number ?? loser.number,
      languageCode: winner.languageCode ?? loser.languageCode,
    };
  }
  return {
    kind: "progress",
    hlc,
    reset: a.reset,
    read: a.read || b.read,
    lastPage: Math.max(a.lastPage, b.lastPage),
    pageCount: Math.max(a.pageCount, b.pageCount),
    // Stable per chapter, so either side's value is the value; the order just makes it deterministic.
    number: a.number ?? b.number,
    languageCode: (a.languageCode ?? "") >= (b.languageCode ?? "") ? (a.languageCode ?? b.languageCode) : b.languageCode,
  };
}

export function isLive(env: Envelope): boolean {
  switch (env.kind) {
    case "register":
      return !env.deleted;
    case "set":
      return env.present;
    case "progress":
      return true;
  }
}

/** Whether merging `incoming` into `local` would change anything a store holds. */
export function envelopeChanges(local: Envelope | undefined, incoming: Envelope): boolean {
  if (!local) return true;
  const merged = mergeEnvelope(local, incoming);
  if (merged === local) return false;
  if (merged.kind !== "progress" || local.kind !== "progress") return true;
  return (
    merged.reset !== local.reset ||
    merged.read !== local.read ||
    merged.lastPage !== local.lastPage ||
    merged.pageCount !== local.pageCount ||
    merged.number !== local.number ||
    merged.languageCode !== local.languageCode
  );
}
