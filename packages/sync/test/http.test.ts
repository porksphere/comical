import { describe, expect, test } from "bun:test";
import {
  HttpBackend,
  MemorySegmentStore,
  pair,
  SeqGapError,
  SyncHub,
  SyncSealError,
  SyncUnlinkedError,
  type PullRequest,
  type Segment,
} from "../src/index.ts";
import { gatedHub, type Fetch, type GatedHub } from "./pairing-fixtures.ts";

const pull = (have: Record<string, number> = {}): PullRequest => ({ device: "phone", name: "A phone", have });
const HLC = "001700000000000:000000:a";
const seg = (device: string, seq: number): Segment => ({
  device,
  seq,
  records: [{ table: "groups", id: `${device}-${seq}`, env: { kind: "register", hlc: HLC, value: seq, deleted: false } }],
});
const HUB_URL = "http://hub.test";

async function paired(hub: GatedHub, name = "A phone"): Promise<HttpBackend> {
  const pairing = await pair({ baseUrl: HUB_URL, fetch: hub.fetch, code: hub.gate.openCode().code, name });
  return new HttpBackend({ baseUrl: `${HUB_URL}/`, fetch: hub.fetch, pairing });
}

describe("HttpBackend over the sealed channel", () => {
  test("pushes and pulls through the hub it paired with, and nothing readable crosses", async () => {
    const hub = await gatedHub();
    const backend = await paired(hub);
    await backend.push(seg("phone", 1));
    const pulled = await backend.pull(pull());
    expect(pulled.segments.map((s) => `${s.device}${s.seq}`)).toEqual(["phone1"]);
    for (const body of hub.wire) {
      expect(body).not.toContain("phone");
      expect(body).not.toContain("groups");
    }
  });

  test("a hub's refusal arrives as the typed error", async () => {
    const hub = await gatedHub();
    const backend = await paired(hub);
    await expect(backend.push(seg("phone", 3))).rejects.toBeInstanceOf(SeqGapError);
  });

  test("whatever answers without this device's key is not the hub", async () => {
    const hub = await gatedHub();
    const pairing = await pair({ baseUrl: HUB_URL, fetch: hub.fetch, code: hub.gate.openCode().code, name: "A phone" });
    const other = await gatedHub();
    await paired(other);
    const strangers: Fetch[] = [
      async () => new Response("not found", { status: 404 }),
      async () => new Response("<html>router</html>", { status: 200 }),
      async () => new Response(JSON.stringify({ segments: [], more: false }), { status: 200 }),
      // Neither a refusal nor an unlinking in the clear is the hub's word.
      async () => new Response(JSON.stringify({ error: "seq-gap", device: "phone", seq: 1, head: 0 }), { status: 409 }),
      async () => new Response(JSON.stringify({ error: "unlinked" }), { status: 410 }),
      // Another hub, with a device of its own.
      other.fetch,
    ];
    for (const fetch of strangers) {
      const backend = new HttpBackend({ baseUrl: HUB_URL, fetch, pairing });
      await expect(backend.pull(pull())).rejects.toBeInstanceOf(SyncSealError);
      await expect(backend.push(seg("phone", 1))).rejects.toBeInstanceOf(SyncSealError);
    }
    // Another device of the same hub can't pass for this one by borrowing its id.
    const second = await pair({ baseUrl: HUB_URL, fetch: hub.fetch, code: hub.gate.openCode().code, name: "Second" });
    const borrowed = new HttpBackend({ baseUrl: HUB_URL, fetch: hub.fetch, pairing: { id: pairing.id, key: second.key } });
    await expect(borrowed.pull(pull())).rejects.toBeInstanceOf(SyncSealError);
  });

  test("a device the hub unlinked is told so, and nothing of its reaches the hub", async () => {
    const hub = await gatedHub();
    const backend = await paired(hub);
    await backend.push(seg("phone", 1));
    const [device] = hub.gate.devices();
    expect(hub.gate.unlink(device!.id)).toBe(true);

    const before = hub.forwarded.length;
    await expect(backend.pull(pull())).rejects.toBeInstanceOf(SyncUnlinkedError);
    await expect(backend.push(seg("phone", 2))).rejects.toBeInstanceOf(SyncUnlinkedError);
    expect(hub.forwarded).toHaveLength(before);
    // Already what it asked for.
    await expect(backend.unpair()).resolves.toBeUndefined();
  });

  test("unpair has the hub forget the device, whose key then opens nothing", async () => {
    const hub = await gatedHub();
    const backend = await paired(hub);
    const staying = await paired(hub, "Staying");
    await backend.unpair();
    expect(hub.gate.devices().map((d) => d.name)).toEqual(["Staying"]);
    expect(hub.saved()).toHaveLength(1);
    await expect(backend.pull(pull())).rejects.toBeInstanceOf(SyncSealError);
    await expect(staying.pull(pull())).resolves.toEqual({ segments: [], more: false });
  });

  test("without a pairing it speaks plain JSON, for a hub on a trusted link, and has nothing to unpair", async () => {
    const hub = await SyncHub.open(new MemorySegmentStore());
    const paths: string[] = [];
    const backend = new HttpBackend({
      baseUrl: "http://localhost",
      fetch: async (url, init) => {
        paths.push(new URL(url).pathname);
        if (new URL(url).pathname === "/sync/push") {
          await hub.push(JSON.parse(init.body) as Segment);
          return new Response(null, { status: 204 });
        }
        return Response.json(await hub.pull(pull()));
      },
    });
    await backend.push(seg("web", 1));
    expect((await backend.pull(pull())).segments).toHaveLength(1);
    await backend.unpair();
    expect(paths).toEqual(["/sync/push", "/sync/pull"]);
  });
});
