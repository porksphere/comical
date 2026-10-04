import {
  MemorySegmentStore,
  pairingGate,
  SeqConflictError,
  SeqGapError,
  SyncHub,
  type PairedDevice,
  type PairingGate,
  type PullRequest,
  type Segment,
  type StoredPairing,
} from "../src/index.ts";

export type Init = { method: string; headers: Record<string, string>; body: string };
export type Fetch = (url: string, init: Init) => Promise<Response>;

export type GatedHub = {
  gate: PairingGate;
  hub: SyncHub;
  /** What a device reaches the gate through, the way the desktop's listener serves it. */
  fetch: Fetch;
  /** Every body that crossed, in either direction. */
  wire: string[];
  /** Every request the gate let through to the hub. */
  forwarded: string[];
  saved: () => StoredPairing[];
  notified: PairedDevice[][];
  clock: { now: number };
};

/** A hub behind a pairing gate. `pairings` is what an earlier run saved. */
export async function gatedHub(pairings: StoredPairing[] = [], clock = { now: 1_000 }): Promise<GatedHub> {
  const hub = await SyncHub.open(new MemorySegmentStore());
  const wire: string[] = [];
  const forwarded: string[] = [];
  const notified: PairedDevice[][] = [];
  let saved = pairings;
  const gate = pairingGate({
    pairings,
    save: (next) => {
      saved = next;
    },
    onDevices: (devices) => notified.push(devices),
    now: () => clock.now,
    forward: async (path, body) => {
      forwarded.push(path);
      try {
        if (path === "/sync/push") {
          await hub.push(JSON.parse(body) as Segment);
          return { status: 204, body: "" };
        }
        return { status: 200, body: JSON.stringify(await hub.pull(JSON.parse(body) as PullRequest)) };
      } catch (err) {
        if (!(err instanceof SeqGapError) && !(err instanceof SeqConflictError)) throw err;
        const error = err instanceof SeqGapError ? "seq-gap" : "seq-conflict";
        return { status: 409, body: JSON.stringify({ error, device: err.device, seq: err.seq, head: err.head }) };
      }
    },
  });
  return {
    gate,
    hub,
    wire,
    forwarded,
    notified,
    clock,
    saved: () => saved,
    fetch: async (url, init) => {
      wire.push(init.body);
      const reply = await gate.handle(new URL(url).pathname, init.body);
      if (reply === null) return new Response("not found", { status: 404 });
      wire.push(reply);
      return new Response(reply, { status: 200 });
    },
  };
}
