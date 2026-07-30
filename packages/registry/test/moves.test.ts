/**
 * Registry moves — `movedTo` (old host forwards) and `movedFrom` (new host claims succession).
 *
 * The thing under test is a *trust* model, not a redirect: following a move silently repoints every
 * installed bridge's update authority, so these tests care as much about what is refused (unsigned
 * claims, key changes, id-disjoint targets, cycles, runaway chains) as about what is followed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import {
  ManifestStore,
  MoveError,
  RegistryManager,
  generateKeyPair,
  sha256Hex,
  signSha256,
} from "../src/index.ts";

const BUNDLE_PATH = join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js");
const DATA_DIR = join(import.meta.dir, ".tmp-moves");

let srv: ReturnType<typeof Bun.serve>;
let origin: string;
let bundleBytes: Uint8Array<ArrayBuffer>;
let bundleHash: string;
/** Mutable path → index JSON map, so a test can "move" a registry mid-flight. */
const served = new Map<string, unknown>();

let keyA: { publicKey: string; privateKey: string };
let keyB: { publicKey: string; privateKey: string };

/** URL of the index served at `/<name>/index.json`. */
const at = (name: string) => `${origin}/${name}/index.json`;

interface IndexOpts {
  bridges?: Array<{ id: string; version?: string }>;
  trackers?: Array<{ id: string; version?: string }>;
  key?: { publicKey: string; privateKey: string };
  movedTo?: string;
  movedFrom?: string[];
}

/** Publish an index at `/<name>/index.json`, signing entries when a key is given. */
async function publish(name: string, opts: IndexOpts): Promise<string> {
  const sign = opts.key ? await signSha256(bundleHash, opts.key.privateKey) : undefined;
  const index: Record<string, unknown> = {
    registryVersion: "1",
    updated: new Date().toISOString(),
    bridges: (opts.bridges ?? []).map((b) => ({
      id: b.id,
      name: b.id,
      version: b.version ?? "0.1.0",
      contractVersion: "2.0.0",
      languages: ["en"],
      nsfw: false,
      capabilities: [],
      url: `${origin}/bridge.js`,
      sha256: bundleHash,
      ...(sign ? { signature: sign } : {}),
    })),
  };
  if (opts.trackers?.length) {
    index.trackers = opts.trackers.map((t) => ({
      id: t.id,
      name: t.id,
      version: t.version ?? "0.1.0",
      contractVersion: "2.0.0",
      capabilities: [],
      url: `${origin}/bridge.js`,
      sha256: bundleHash,
      ...(sign ? { signature: sign } : {}),
    }));
  }
  if (opts.key) index.publicKey = opts.key.publicKey;
  if (opts.movedTo) index.movedTo = opts.movedTo;
  if (opts.movedFrom) index.movedFrom = opts.movedFrom;
  served.set(`/${name}/index.json`, index);
  return at(name);
}

/**
 * A manager over `dir`'s manifest. `RegistryManager` caches indexes in-memory for its lifetime, so a
 * test that republishes an index must make a *new* manager (sharing the manifest) to see the change —
 * which is also what a real client does across restarts.
 */
function mgrFor(dir: string, manifest = new ManifestStore(join(DATA_DIR, dir))) {
  return { manifest, mgr: new RegistryManager({ cacheDir: join(DATA_DIR, dir, "cache"), manifest }) };
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  bundleBytes = new Uint8Array(readFileSync(BUNDLE_PATH) as Buffer);
  bundleHash = await sha256Hex(bundleBytes);
  keyA = await generateKeyPair();
  keyB = await generateKeyPair();

  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/bridge.js") return new Response(bundleBytes);
      const index = served.get(path);
      if (!index) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } });
    },
  });
  origin = `http://localhost:${srv.port}`;
});

afterAll(() => {
  srv.stop(true);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ── movedTo ───────────────────────────────────────────────────────────────────

describe("movedTo — signed move with key continuity", () => {
  test("follows automatically and repoints the registry and its installs", async () => {
    const oldUrl = await publish("kc-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("kc");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    // The operator moves: old index becomes a forwarding stub, new one is signed with the same key.
    const newUrl = await publish("kc-new", { bridges: [{ id: "example", version: "0.2.0" }], key: keyA });
    await publish("kc-old", { bridges: [], key: keyA, movedTo: newUrl });

    const { mgr: mgr2 } = mgrFor("kc", manifest);
    await mgr2.browse(oldUrl);

    const saved = await manifest.allRegistries();
    expect(saved.map((r) => r.url)).toEqual([newUrl]);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(newUrl);
    // The move carries update authority with it: the new version is now visible.
    expect(await mgr2.checkUpdates()).toEqual([
      { id: "example", installedVersion: "0.1.0", availableVersion: "0.2.0" },
    ]);
  });

  test("the install record itself is untouched apart from registryUrl", async () => {
    // Everything the user owns — settings, credentials, library entries — is keyed by bridge id, so
    // a move is only safe as long as the id, version and cached bundle survive it verbatim.
    const oldUrl = await publish("keep-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("keep");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");
    const before = { ...(await manifest.getInstalled("example"))! };

    const newUrl = await publish("keep-new", { bridges: [{ id: "example" }], key: keyA });
    await publish("keep-old", { bridges: [], key: keyA, movedTo: newUrl });
    await mgrFor("keep", manifest).mgr.browse(oldUrl);

    const after = await manifest.getInstalled("example");
    expect(after).toEqual({ ...before, registryUrl: newUrl });
  });
});

describe("movedTo — unverifiable claims are held, not followed", () => {
  test("an unsigned registry's move is parked as pendingMove", async () => {
    const oldUrl = await publish("un-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("un");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    const newUrl = await publish("un-new", { bridges: [{ id: "example", version: "0.2.0" }] });
    await publish("un-old", { bridges: [], movedTo: newUrl });

    const { mgr: mgr2 } = mgrFor("un", manifest);
    await mgr2.browse(oldUrl);

    expect((await manifest.getRegistry(oldUrl))?.pendingMove).toBe(newUrl);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
    // The stub index must not be evaluated for updates — it would report nothing available at best,
    // and (on clients that use absence as a signal) mark the bridge discontinued at worst.
    expect(await mgr2.checkUpdates()).toEqual([]);
  });

  test("confirmMove applies the held move", async () => {
    const oldUrl = await publish("cf-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("cf");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");
    const newUrl = await publish("cf-new", { bridges: [{ id: "example", version: "0.3.0" }] });
    await publish("cf-old", { bridges: [], movedTo: newUrl });
    await mgrFor("cf", manifest).mgr.browse(oldUrl);

    const { mgr: mgr3 } = mgrFor("cf", manifest);
    expect(await mgr3.confirmMove(oldUrl)).toBe(newUrl);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([newUrl]);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(newUrl);
    expect((await manifest.getRegistry(newUrl))?.pendingMove).toBeUndefined();
  });

  test("dismissMove clears the claim without following it", async () => {
    const oldUrl = await publish("dm-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("dm");
    await mgr.add(oldUrl);
    const newUrl = await publish("dm-new", { bridges: [{ id: "example" }] });
    await publish("dm-old", { bridges: [], movedTo: newUrl });
    await mgrFor("dm", manifest).mgr.browse(oldUrl);
    expect((await manifest.getRegistry(oldUrl))?.pendingMove).toBe(newUrl);

    await mgr.dismissMove(oldUrl);
    expect((await manifest.getRegistry(oldUrl))?.pendingMove).toBeUndefined();
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([oldUrl]);
  });

  test("confirmMove without a held claim throws rather than following an arbitrary URL", async () => {
    const url = await publish("nc", { bridges: [{ id: "example" }] });
    const { mgr } = mgrFor("nc");
    await mgr.add(url);
    await expect(mgr.confirmMove(url)).rejects.toBeInstanceOf(MoveError);
  });

  test("a signed registry that forwards with an UNSIGNED stub is held, not followed", async () => {
    // The trap for an operator publishing a forwarding index by hand: the registry was signed, but
    // the stub left behind at the old URL drops the key. Continuity is checked against the stub
    // itself, so there is now nothing to check it against — and a planned migration silently
    // degrades into a manual confirm on every client. Pinned here so it stays a deliberate choice.
    const oldUrl = await publish("dk-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("dk");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    const newUrl = await publish("dk-new", { bridges: [{ id: "example", version: "0.2.0" }], key: keyA });
    await publish("dk-old", { bridges: [], movedTo: newUrl }); // same operator, key omitted

    await mgrFor("dk", manifest).mgr.browse(oldUrl);
    expect((await manifest.getRegistry(oldUrl))?.pendingMove).toBe(newUrl);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
  });

  test("a move signed by a DIFFERENT key is held, not followed", async () => {
    const oldUrl = await publish("km-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("km");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    // Same repo, new key — indistinguishable from a takeover, so it needs the user.
    const newUrl = await publish("km-new", { bridges: [{ id: "example" }], key: keyB });
    await publish("km-old", { bridges: [], key: keyB, movedTo: newUrl });

    await mgrFor("km", manifest).mgr.browse(oldUrl);
    expect((await manifest.getRegistry(oldUrl))?.pendingMove).toBe(newUrl);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
  });
});

describe("movedTo — add() trusts the host the user just chose", () => {
  test("adding a moved registry lands on the canonical URL, not the forwarding note", async () => {
    const newUrl = await publish("ad-new", { bridges: [{ id: "example" }] });
    const oldUrl = await publish("ad-old", { bridges: [], movedTo: newUrl });
    const { manifest, mgr } = mgrFor("ad");

    const added = await mgr.add(oldUrl);
    expect(added.url).toBe(newUrl);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([newUrl]);
  });
});

describe("movedTo — malformed chains terminate", () => {
  test("a self-referencing movedTo does not loop", async () => {
    const url = at("self");
    await publish("self", { bridges: [{ id: "example" }], key: keyA, movedTo: url });
    const { manifest, mgr } = mgrFor("self");
    await mgr.add(url);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([url]);
    expect((await mgr.browse(url)).length).toBe(1);
  });

  test("an A→B→A cycle settles instead of ping-ponging", async () => {
    const aUrl = at("cyc-a");
    const bUrl = at("cyc-b");
    await publish("cyc-a", { bridges: [{ id: "example" }], key: keyA, movedTo: bUrl });
    await publish("cyc-b", { bridges: [{ id: "example" }], key: keyA, movedTo: aUrl });
    const { manifest, mgr } = mgrFor("cyc");
    await mgr.add(aUrl);
    // One hop lands on B, whose pointer back to A is already `seen` — so it stops there.
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([bUrl]);
  });

  test("a long chain stops at the hop cap instead of walking forever", async () => {
    // a → b → c → d → e, all with key continuity. The cap is 3 hops.
    for (const [from, to] of [["ch-a", "ch-b"], ["ch-b", "ch-c"], ["ch-c", "ch-d"], ["ch-d", "ch-e"]] as const) {
      await publish(from, { bridges: [{ id: "example" }], key: keyA, movedTo: at(to) });
    }
    await publish("ch-e", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("ch");
    await mgr.add(at("ch-a"));
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([at("ch-d")]);
  });
});

describe("assertSameRegistry", () => {
  test("refuses a move to an index that shares none of the installed ids", async () => {
    const oldUrl = await publish("dj-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("dj");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");
    const newUrl = await publish("dj-new", { bridges: [{ id: "somebody-else" }] });
    await publish("dj-old", { bridges: [], movedTo: newUrl });
    await mgrFor("dj", manifest).mgr.browse(oldUrl);

    await expect(mgrFor("dj", manifest).mgr.confirmMove(oldUrl)).rejects.toBeInstanceOf(MoveError);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
  });

  test("allows a partial overlap — a publisher may drop a bridge across the move", async () => {
    const oldUrl = await publish("po-old", { bridges: [{ id: "example" }, { id: "second" }], key: keyA });
    const { manifest, mgr } = mgrFor("po");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");
    await mgr.install(oldUrl, "second");

    const newUrl = await publish("po-new", { bridges: [{ id: "example" }], key: keyA });
    await publish("po-old", { bridges: [], key: keyA, movedTo: newUrl });
    await mgrFor("po", manifest).mgr.browse(oldUrl);

    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(newUrl);
    expect((await manifest.getInstalled("second"))?.registryUrl).toBe(newUrl);
  });

  test("a registry with nothing installed has nothing at stake and moves freely", async () => {
    const oldUrl = await publish("ne-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("ne");
    await mgr.add(oldUrl);
    const newUrl = await publish("ne-new", { bridges: [{ id: "totally-different" }], key: keyA });
    await publish("ne-old", { bridges: [], key: keyA, movedTo: newUrl });
    await mgrFor("ne", manifest).mgr.browse(oldUrl);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([newUrl]);
  });
});

// ── movedFrom ─────────────────────────────────────────────────────────────────

describe("movedFrom — adopting a predecessor on add()", () => {
  test("adopts automatically when the new index carries the pinned key", async () => {
    const oldUrl = await publish("mf-old", { bridges: [{ id: "example" }], key: keyA });
    const { manifest, mgr } = mgrFor("mf");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    // The old host is gone; the user re-adds the registry at its new home by hand.
    const newUrl = await publish("mf-new", { bridges: [{ id: "example", version: "0.2.0" }], key: keyA, movedFrom: [oldUrl] });
    const added = await mgrFor("mf", manifest).mgr.add(newUrl);

    expect(added.url).toBe(newUrl);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([newUrl]);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(newUrl);
    expect((await manifest.getRegistry(newUrl))?.pendingAdoption).toBeUndefined();
  });

  test("an unsigned successor's claim is offered, not taken", async () => {
    const oldUrl = await publish("pa-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("pa");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    const newUrl = await publish("pa-new", { bridges: [{ id: "example" }], movedFrom: [oldUrl] });
    const added = await mgrFor("pa", manifest).mgr.add(newUrl);

    expect(added.pendingAdoption).toEqual([oldUrl]);
    // Both registries still exist and the install still belongs to the old one.
    expect((await manifest.allRegistries()).map((r) => r.url).sort()).toEqual([newUrl, oldUrl].sort());
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
  });

  test("confirmAdoption rebinds the predecessor's installs", async () => {
    const oldUrl = await publish("ca-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("ca");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");
    const newUrl = await publish("ca-new", { bridges: [{ id: "example" }], movedFrom: [oldUrl] });
    const { mgr: mgr2 } = mgrFor("ca", manifest);
    await mgr2.add(newUrl);

    await mgr2.confirmAdoption(newUrl, oldUrl);
    expect((await manifest.allRegistries()).map((r) => r.url)).toEqual([newUrl]);
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(newUrl);
    expect((await manifest.getRegistry(newUrl))?.pendingAdoption).toBeUndefined();
  });

  test("confirmAdoption refuses a URL the registry never claimed", async () => {
    const otherUrl = await publish("cx-other", { bridges: [{ id: "example" }] });
    const newUrl = await publish("cx-new", { bridges: [{ id: "example" }] });
    const { mgr } = mgrFor("cx");
    await mgr.add(otherUrl);
    await mgr.add(newUrl);
    await expect(mgr.confirmAdoption(newUrl, otherUrl)).rejects.toBeInstanceOf(MoveError);
  });

  test("a claim on a registry the user doesn't have is ignored", async () => {
    const newUrl = await publish("ig-new", {
      bridges: [{ id: "example" }],
      movedFrom: [`${origin}/never-added/index.json`],
    });
    const { manifest, mgr } = mgrFor("ig");
    await mgr.add(newUrl);
    expect((await manifest.getRegistry(newUrl))?.pendingAdoption).toBeUndefined();
  });

  test("a claim sharing no installed ids is not even offered", async () => {
    const oldUrl = await publish("nx-old", { bridges: [{ id: "example" }] });
    const { manifest, mgr } = mgrFor("nx");
    await mgr.add(oldUrl);
    await mgr.install(oldUrl, "example");

    // A publisher of unrelated bridges claiming succession would otherwise get a prompt that looks
    // legitimate — and one careless tap hands it update authority over `example`.
    const newUrl = await publish("nx-new", { bridges: [{ id: "unrelated" }], movedFrom: [oldUrl] });
    await mgrFor("nx", manifest).mgr.add(newUrl);
    expect((await manifest.getRegistry(newUrl))?.pendingAdoption).toBeUndefined();
    expect((await manifest.getInstalled("example"))?.registryUrl).toBe(oldUrl);
  });
});

// ── rebindRegistry (manifest-level) ───────────────────────────────────────────

describe("ManifestStore.rebindRegistry", () => {
  const seed = async (manifest: ManifestStore, url: string) => {
    await manifest.addRegistry({ url, name: "old", requireSignature: false, publicKeyFingerprint: "abc" });
    await manifest.addInstalled({
      id: "b1", version: "1.0.0", contractVersion: "2.0.0", registryUrl: url,
      bundlePath: "/tmp/b1.js", sha256: "f".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
    });
    await manifest.addInstalledTracker({
      id: "t1", version: "1.0.0", contractVersion: "2.0.0", registryUrl: url,
      bundlePath: "/tmp/t1.js", sha256: "e".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
    });
  };

  test("sweeps bridges AND trackers, and carries the pinned key forward", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "rb-sweep"));
    await seed(manifest, at("rb-a"));
    await manifest.rebindRegistry(at("rb-a"), at("rb-b"));

    const saved = await manifest.allRegistries();
    expect(saved.map((r) => r.url)).toEqual([at("rb-b")]);
    expect(saved[0]!.publicKeyFingerprint).toBe("abc");
    expect((await manifest.getInstalled("b1"))?.registryUrl).toBe(at("rb-b"));
    expect((await manifest.getInstalledTracker("t1"))?.registryUrl).toBe(at("rb-b"));
  });

  test("leaves locally-built (registryUrl: null) records alone", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "rb-local"));
    await seed(manifest, at("rb-a"));
    await manifest.addInstalled({
      id: "local", version: "1.0.0", contractVersion: "2.0.0", registryUrl: null,
      bundlePath: "/tmp/local.js", sha256: "d".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
    });
    await manifest.rebindRegistry(at("rb-a"), at("rb-b"));
    expect((await manifest.getInstalled("local"))?.registryUrl).toBeNull();
  });

  test("is idempotent and a no-op for an unknown or unchanged URL", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "rb-idem"));
    await seed(manifest, at("rb-a"));
    await manifest.rebindRegistry(at("rb-a"), at("rb-b"));
    const after = JSON.stringify(await manifest.read());

    await manifest.rebindRegistry(at("rb-a"), at("rb-b")); // replay: old url no longer exists
    await manifest.rebindRegistry(at("rb-b"), at("rb-b")); // self-move
    expect(JSON.stringify(await manifest.read())).toBe(after);
  });

  test("collapses onto a row that already exists at the target URL", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "rb-collapse"));
    await seed(manifest, at("rb-a"));
    await manifest.addRegistry({ url: at("rb-b"), name: "new", requireSignature: false });
    await manifest.rebindRegistry(at("rb-a"), at("rb-b"));

    const saved = await manifest.allRegistries();
    expect(saved.length).toBe(1);
    expect(saved[0]!.url).toBe(at("rb-b"));
    expect(await manifest.bridgesFromRegistry(at("rb-b"))).toEqual(["b1"]);
  });

  test("clears any pending move/adoption flags on the row it moves", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "rb-flags"));
    await seed(manifest, at("rb-a"));
    await manifest.setPendingMove(at("rb-a"), at("rb-b"));
    await manifest.setPendingAdoption(at("rb-a"), [at("rb-z")]);
    await manifest.rebindRegistry(at("rb-a"), at("rb-b"));

    const moved = await manifest.getRegistry(at("rb-b"));
    expect(moved?.pendingMove).toBeUndefined();
    expect(moved?.pendingAdoption).toBeUndefined();
  });
});
