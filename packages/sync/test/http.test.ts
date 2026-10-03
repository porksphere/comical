import { describe, expect, test } from "bun:test";
import {
  HttpBackend,
  MemorySegmentStore,
  sealedChannel,
  SeqGapError,
  SyncHub,
  SyncSealError,
  type PullRequest,
  type Segment,
} from "../src/index.ts";

const pull = (have: Record<string, number> = {}): PullRequest => ({ device: "phone", name: "A phone", have });
const SECRET = "abcdefghjkmn";
const HLC = "001700000000000:000000:a";
const seg = (device: string, seq: number): Segment => ({
  device,
  seq,
  records: [{ table: "groups", id: `${device}-${seq}`, env: { kind: "register", hlc: HLC, value: seq, deleted: false } }],
});

type Init = { method: string; headers: Record<string, string>; body: string };

/** A hub behind the sealed channel, the way the desktop listener wraps the router. */
async function sealedHub(secret: string): Promise<{ fetch: (url: string, init: Init) => Promise<Response>; seen: string[] }> {
  const hub = await SyncHub.open(new MemorySegmentStore());
  const channel = sealedChannel(secret);
  const seen: string[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push(init.body);
      const path = new URL(url).pathname;
      const request = channel.openRequest(path, init.body);
      if (!request) return new Response("not found", { status: 404 });
      let status = 200;
      let body = "";
      try {
        if (path === "/sync/push") {
          await hub.push(JSON.parse(request.body) as Segment);
          status = 204;
        } else {
          body = JSON.stringify(await hub.pull(JSON.parse(request.body) as PullRequest));
        }
      } catch (err) {
        if (!(err instanceof SeqGapError)) throw err;
        status = 409;
        body = JSON.stringify({ error: "seq-gap", device: err.device, seq: err.seq, head: err.head });
      }
      return new Response(channel.sealResponse(request.nonce, status, body), { status: 200 });
    },
  };
}

describe("HttpBackend over the sealed channel", () => {
  test("pushes and pulls through a hub holding the secret, and nothing readable crosses", async () => {
    const hub = await sealedHub(SECRET);
    const backend = new HttpBackend({ baseUrl: "http://hub.test/", fetch: hub.fetch, secret: SECRET });
    await backend.push(seg("phone", 1));
    const pulled = await backend.pull(pull());
    expect(pulled.segments.map((s) => `${s.device}${s.seq}`)).toEqual(["phone1"]);
    for (const body of hub.seen) {
      expect(body).not.toContain("phone");
      expect(body).not.toContain("groups");
    }
  });

  test("a hub's refusal arrives as the typed error", async () => {
    const hub = await sealedHub(SECRET);
    const backend = new HttpBackend({ baseUrl: "http://hub.test", fetch: hub.fetch, secret: SECRET });
    await expect(backend.push(seg("phone", 3))).rejects.toBeInstanceOf(SeqGapError);
  });

  test("whatever answers without the secret is not the hub", async () => {
    const strangers: Array<(url: string, init: Init) => Promise<Response>> = [
      async () => new Response("not found", { status: 404 }),
      async () => new Response("<html>router</html>", { status: 200 }),
      async () => new Response(JSON.stringify({ segments: [], more: false }), { status: 200 }),
      // A refusal in the clear must not send the device re-pairing.
      async () => new Response(JSON.stringify({ error: "seq-gap", device: "phone", seq: 1, head: 0 }), { status: 409 }),
      (await sealedHub("zzzzzzzzzzzz")).fetch,
    ];
    for (const fetch of strangers) {
      const backend = new HttpBackend({ baseUrl: "http://hub.test", fetch, secret: SECRET });
      await expect(backend.pull(pull())).rejects.toBeInstanceOf(SyncSealError);
      await expect(backend.push(seg("phone", 1))).rejects.toBeInstanceOf(SyncSealError);
    }
  });

  test("without a secret it speaks plain JSON, for a hub on a trusted link", async () => {
    const hub = await SyncHub.open(new MemorySegmentStore());
    const backend = new HttpBackend({
      baseUrl: "http://localhost",
      fetch: async (url, init) => {
        if (new URL(url).pathname === "/sync/push") {
          await hub.push(JSON.parse(init.body) as Segment);
          return new Response(null, { status: 204 });
        }
        return Response.json(await hub.pull(pull()));
      },
    });
    await backend.push(seg("web", 1));
    expect((await backend.pull(pull())).segments).toHaveLength(1);
  });
});
