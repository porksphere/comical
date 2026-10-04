import { describe, expect, test } from "bun:test";
import {
  envelopePairing,
  HttpBackend,
  newPairingCode,
  pair,
  PAIRING_CODE_TTL_MS,
  sealedChannel,
  SyncHttpError,
  SyncPairingError,
  SyncSealError,
  SyncUnlinkedError,
  type Pairing,
  type PullRequest,
} from "../src/index.ts";
import { gatedHub, type GatedHub } from "./pairing-fixtures.ts";

const HUB_URL = "http://hub.test";
const DAY = 24 * 60 * 60_000;
const pull = (name: string): PullRequest => ({ device: "phone", name, have: {} });

const enrol = (hub: GatedHub, code: string, name = "A phone") => pair({ baseUrl: HUB_URL, fetch: hub.fetch, code, name });
const backend = (hub: GatedHub, pairing: Pairing) => new HttpBackend({ baseUrl: HUB_URL, fetch: hub.fetch, pairing });

describe("newPairingCode", () => {
  test("is twelve characters that can't be misread, and never the same twice", () => {
    const codes = Array.from({ length: 200 }, newPairingCode);
    for (const code of codes) expect(code).toMatch(/^[abcdefghjkmnpqrstuvwxyz2-9]{12}$/);
    expect(new Set(codes).size).toBe(200);
  });
});

describe("pairing", () => {
  test("a device with the code is paired, listed, and holds a key the hub saved", async () => {
    const hub = await gatedHub();
    const { code, expiresAt } = hub.gate.openCode();
    expect(expiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS);

    const pairing = await enrol(hub, code, "  Pixel  ");
    expect(hub.gate.devices()).toEqual([{ id: pairing.id, name: "Pixel", pairedAt: 1_000, lastSeenAt: null }]);
    expect(hub.saved()).toEqual([{ id: pairing.id, name: "Pixel", key: pairing.key, pairedAt: 1_000, lastSeenAt: null }]);
    expect(hub.notified).toEqual([hub.gate.devices()]);
    await expect(backend(hub, pairing).pull(pull("Pixel"))).resolves.toEqual({ segments: [], more: false });
  });

  test("a code pairs one device: the next needs its own, and gets its own key", async () => {
    const hub = await gatedHub();
    const { code } = hub.gate.openCode();
    const first = await enrol(hub, code);
    await expect(enrol(hub, code, "Second")).rejects.toBeInstanceOf(SyncPairingError);

    const second = await enrol(hub, hub.gate.openCode().code, "Second");
    expect(second.id).not.toBe(first.id);
    expect(second.key).not.toBe(first.key);
    expect(hub.gate.devices()).toHaveLength(2);
  });

  test("a code that expired, was replaced or was closed pairs nothing", async () => {
    const hub = await gatedHub();
    const expired = hub.gate.openCode();
    hub.clock.now = expired.expiresAt;
    await expect(enrol(hub, expired.code)).rejects.toBeInstanceOf(SyncPairingError);

    const replaced = hub.gate.openCode();
    const current = hub.gate.openCode();
    await expect(enrol(hub, replaced.code)).rejects.toBeInstanceOf(SyncPairingError);

    hub.gate.closeCode();
    await expect(enrol(hub, current.code)).rejects.toBeInstanceOf(SyncPairingError);
    expect(hub.gate.devices()).toEqual([]);
    expect(hub.saved()).toEqual([]);
  });

  test("with no code open, or the wrong one, nothing is paired and the open code still works", async () => {
    const hub = await gatedHub();
    await expect(enrol(hub, "abcdefghjkmn")).rejects.toBeInstanceOf(SyncPairingError);
    const { code } = hub.gate.openCode();
    await expect(enrol(hub, "zzzzzzzzzzzz")).rejects.toBeInstanceOf(SyncPairingError);
    await expect(enrol(hub, code)).resolves.toMatchObject({ id: expect.any(String) });
  });

  test("a request that isn't a pairing request is refused without using the code up", async () => {
    const hub = await gatedHub();
    const { code } = hub.gate.openCode();
    const channel = sealedChannel(code);
    // The last is all zeroes, a point X25519 has no shared secret for.
    const bad = [{ name: "A phone" }, { name: "", key: "AAAA" }, { name: "A phone", key: "AAAA" }, "nonsense", { name: "A phone", key: `${"A".repeat(43)}=` }];
    for (const body of bad) {
      const { nonce, envelope } = channel.sealRequest("/sync/pair", JSON.stringify(body));
      const reply = channel.openResponse(nonce, (await hub.gate.handle("/sync/pair", envelope))!);
      expect(reply?.status).toBe(400);
    }
    expect(hub.gate.devices()).toEqual([]);

    await expect(enrol(hub, code)).resolves.toMatchObject({ id: expect.any(String) });
  });

  test("a hub that refuses the pairing is reported, not taken for a wrong code", async () => {
    const code = "abcdefghjkmn";
    const channel = sealedChannel(code);
    const refusing = async (_url: string, init: { body: string }) => {
      const request = channel.openRequest("/sync/pair", init.body)!;
      return new Response(channel.sealResponse(request.nonce, 400, JSON.stringify({ error: "no" })));
    };
    const failure = await pair({ baseUrl: HUB_URL, fetch: refusing, code, name: "A phone" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncHttpError);
    expect((failure as SyncHttpError).status).toBe(400);
  });

  test("the key never crosses, and the code opens nothing sent after pairing", async () => {
    const hub = await gatedHub();
    const { code } = hub.gate.openCode();
    const pairing = await enrol(hub, code);
    await backend(hub, pairing).pull(pull("A phone"));

    for (const body of hub.wire) expect(body).not.toContain(pairing.key);
    const [request, reply, sync] = hub.wire;
    const channel = sealedChannel(code);
    const opened = channel.openRequest("/sync/pair", request!)!;
    expect(opened.body).not.toContain(pairing.key);
    expect(channel.openResponse(opened.nonce, reply!)?.body).not.toContain(pairing.key);
    expect(envelopePairing(sync!)).toBe(pairing.id);
    expect(channel.openRequest("/sync/pull", sync!)).toBeNull();
  });

  test("each pull brings the device's name and last sync up to date, most recent first", async () => {
    const hub = await gatedHub();
    const a = await enrol(hub, hub.gate.openCode().code, "Phone A");
    hub.clock.now = 2_000;
    const b = await enrol(hub, hub.gate.openCode().code, "Phone B");
    expect(hub.gate.devices().map((d) => d.name)).toEqual(["Phone B", "Phone A"]);

    hub.clock.now = 3_000;
    await backend(hub, a).pull(pull("Phone A, renamed"));
    expect(hub.gate.devices()).toEqual([
      { id: a.id, name: "Phone A, renamed", pairedAt: 1_000, lastSeenAt: 3_000 },
      { id: b.id, name: "Phone B", pairedAt: 2_000, lastSeenAt: null },
    ]);
    expect(hub.notified.at(-1)).toEqual(hub.gate.devices());
    expect("key" in hub.gate.devices()[0]!).toBe(false);
  });

  test("pairings saved by one run are honoured by the next", async () => {
    const hub = await gatedHub();
    const pairing = await enrol(hub, hub.gate.openCode().code);
    const restarted = await gatedHub(hub.saved());
    expect(restarted.gate.devices()).toEqual(hub.gate.devices());
    await expect(backend(restarted, pairing).pull(pull("A phone"))).resolves.toEqual({ segments: [], more: false });
  });

  test("unlinking one device leaves the others syncing", async () => {
    const hub = await gatedHub();
    const gone = await enrol(hub, hub.gate.openCode().code, "Gone");
    const kept = await enrol(hub, hub.gate.openCode().code, "Kept");

    expect(hub.gate.unlink(gone.id)).toBe(true);
    expect(hub.gate.devices().map((d) => d.name)).toEqual(["Kept"]);
    expect(hub.notified.at(-1)!.map((d) => d.name)).toEqual(["Kept"]);
    await expect(backend(hub, gone).pull(pull("Gone"))).rejects.toBeInstanceOf(SyncUnlinkedError);
    await expect(backend(hub, kept).pull(pull("Kept"))).resolves.toEqual({ segments: [], more: false });

    expect(hub.gate.unlink(gone.id)).toBe(false);
    expect(hub.gate.unlink("nobody")).toBe(false);
  });

  test("an unlinked device is still told so after a restart, until its pairing is finally dropped", async () => {
    const hub = await gatedHub();
    const gone = await enrol(hub, hub.gate.openCode().code, "Gone");
    const kept = await enrol(hub, hub.gate.openCode().code, "Kept");
    hub.gate.unlink(gone.id);

    const clock = { now: 1_000 + 29 * DAY };
    const restarted = await gatedHub(hub.saved(), clock);
    expect(restarted.gate.devices().map((d) => d.name)).toEqual(["Kept"]);
    await expect(backend(restarted, gone).pull(pull("Gone"))).rejects.toBeInstanceOf(SyncUnlinkedError);

    // Dropped the next time anything is saved past thirty days.
    clock.now = 1_000 + 31 * DAY;
    await backend(restarted, kept).pull(pull("Kept"));
    expect(restarted.saved().map((p) => p.name)).toEqual(["Kept"]);
    await expect(backend(restarted, gone).pull(pull("Gone"))).rejects.toBeInstanceOf(SyncSealError);
  });

  test("a paired device reaches push and pull and nothing else", async () => {
    const hub = await gatedHub();
    const pairing = await enrol(hub, hub.gate.openCode().code);
    const channel = sealedChannel(pairing.key, pairing.id);
    const { nonce, envelope } = channel.sealRequest("/bridges", "{}");
    const reply = channel.openResponse(nonce, (await hub.gate.handle("/bridges", envelope))!);
    expect(reply?.status).toBe(404);
    expect(hub.forwarded).toEqual([]);

    // Sealed for one route, sent to another.
    const forPull = channel.sealRequest("/sync/pull", JSON.stringify(pull("A phone")));
    expect(await hub.gate.handle("/sync/push", forPull.envelope)).toBeNull();
    expect(await hub.gate.handle("/sync/pull", "not an envelope")).toBeNull();
  });
});
