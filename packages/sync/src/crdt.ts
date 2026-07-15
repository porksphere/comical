/**
 * The three merge primitives, over HLC-stamped envelopes. `mergeEnvelope` is a pure, commutative,
 * associative, idempotent join: any two replicas that have seen the same set of writes converge to
 * the same state regardless of the order or timing of delivery. That property is what lets the sync
 * backend be dumb (and, later, untrusted) — every device computes the same winner independently, and
 * the hub computes it too, from this same function.
 *
 * Primitives:
 *   - register — LWW value with tombstone (library entries, lists, groups, history, prefs, settings)
 *   - set      — LWW-element membership (registries, installed bridges, list membership)
 *   - progress — MONOTONIC join; furthest-read wins. NOT last-write-wins: a later write with a
 *                smaller page must never roll read position back (a general LWW CRDT gets this
 *                wrong — see comical-app's sync-eval/FINDINGS.md).
 */
import { comparePacked } from "./hlc.ts";

export type Register = { readonly kind: "register"; readonly hlc: string; readonly value: unknown; readonly deleted: boolean };
export type SetElement = {
  readonly kind: "set";
  readonly hlc: string;
  readonly present: boolean;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
};
/**
 * Read state for one chapter, mirroring `@comical/library`'s `ChapterProgress`. The read-position
 * fields form a semilattice (furthest wins); `languageCode` is stable per chapter, carried as LWW.
 */
export type Progress = {
  readonly kind: "progress";
  readonly hlc: string; // sync watermark / metadata tie-break — NOT used to decide the position merge
  readonly read: boolean; // OR — once read on any device, stays read
  readonly lastPage: number; // max — furthest resume page (0-based)
  readonly pageCount: number; // max
  readonly number?: number | undefined; // decimal chapter number (stable); keep the known value
  readonly languageCode?: string | undefined; // stable per chapter; LWW by hlc
};
export type Envelope = Register | SetElement | Progress;

/** Deterministic join of two envelopes of the same kind. */
export function mergeEnvelope(a: Envelope, b: Envelope): Envelope {
  if (a.kind !== b.kind) {
    throw new Error(`sync: refusing to merge ${a.kind} with ${b.kind} (record identity collision)`);
  }
  switch (a.kind) {
    case "register":
      return comparePacked(a.hlc, (b as Register).hlc) >= 0 ? a : b;
    case "set":
      return comparePacked(a.hlc, (b as SetElement).hlc) >= 0 ? a : b;
    case "progress": {
      const p = b as Progress;
      const aLater = comparePacked(a.hlc, p.hlc) >= 0;
      return {
        kind: "progress",
        // keep the later stamp purely so the sync cursor keeps advancing…
        hlc: aLater ? a.hlc : p.hlc,
        // …but merge the read POSITION monotonically, independent of which write was later.
        read: a.read || p.read,
        lastPage: Math.max(a.lastPage, p.lastPage),
        pageCount: Math.max(a.pageCount, p.pageCount),
        number: a.number ?? p.number, // stable per chapter; keep whichever knows it
        languageCode: (aLater ? a.languageCode : p.languageCode) ?? a.languageCode ?? p.languageCode,
      };
    }
  }
}

/** Whether a register/set element is currently live (present and not tombstoned). */
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
