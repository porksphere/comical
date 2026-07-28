/**
 * Contract compatibility at the registry layer.
 *
 * The loaders already refuse a bundle whose `contractVersion` this build can't honour
 * (`BridgeContractError`), but that check happens at *evaluation* — by which point the bundle has
 * been downloaded, checksum-verified, written to the cache and recorded in the manifest as an
 * install. Worse, `checkUpdates` would advertise such a version as an update, so accepting the badge
 * traded a working bridge for one that no longer loads. These tests pin the registry-side guard:
 * refuse before the download, and never offer an update that can't be loaded.
 *
 * `CONTRACT_VERSION` is "1.0.0" today, so "2.0.0" here means "needs a newer app than this build".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ContractIncompatibleError } from "../src/compat.ts";
import { ManifestStore } from "../src/manifest.ts";
import { RegistryManager } from "../src/manager.ts";
import { sha256Hex } from "../src/verify.ts";

const BUNDLE_PATH = join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js");
const DATA_DIR = join(import.meta.dir, ".tmp-compat");

describe("RegistryManager contract compatibility", () => {
  let srv: ReturnType<typeof Bun.serve>;
  let registryUrl: string;
  let indexJson = "";
  let bundleBytes: Uint8Array<ArrayBuffer>;
  /** Bundle fetches seen by the fixture server — the "did it download it anyway?" probe. */
  let downloads = 0;

  beforeAll(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    bundleBytes = new Uint8Array(readFileSync(BUNDLE_PATH) as Buffer);
    const hash = await sha256Hex(bundleBytes);

    srv = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/index.json") {
          return new Response(indexJson, { headers: { "content-type": "application/json" } });
        }
        if (path === "/bundle.js") {
          downloads++;
          return new Response(bundleBytes);
        }
        return new Response("not found", { status: 404 });
      },
    });
    registryUrl = `http://localhost:${srv.port}/index.json`;
    const bundleUrl = `http://localhost:${srv.port}/bundle.js`;

    // One registry carrying a loadable and an unloadable entry of each kind, all at the same
    // version, so the only thing separating them in every assertion below is `contractVersion`.
    indexJson = JSON.stringify({
      registryVersion: "1",
      updated: new Date().toISOString(),
      bridges: [
        entry("ok", "1.0.0", bundleUrl, hash, { languages: ["en"], nsfw: false }),
        entry("future", "2.0.0", bundleUrl, hash, { languages: ["en"], nsfw: false }),
      ],
      trackers: [
        entry("ok-trk", "1.0.0", bundleUrl, hash),
        entry("future-trk", "2.0.0", bundleUrl, hash),
      ],
    });
  });

  afterAll(() => {
    srv.stop(true);
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  /** A manager over a fresh manifest — the index cache is per-manager, so tests can't bleed. */
  function manager(name: string): { mgr: RegistryManager; manifest: ManifestStore } {
    const manifest = new ManifestStore(join(DATA_DIR, name));
    return { mgr: new RegistryManager({ cacheDir: join(DATA_DIR, `${name}-cache`), manifest }), manifest };
  }

  // ── Install ────────────────────────────────────────────────────────────────

  test("refuses to install a bridge targeting a contract this build can't load", async () => {
    const { mgr, manifest } = manager("install-bridge");
    await mgr.add(registryUrl);
    const before = downloads;

    await expect(mgr.install(registryUrl, "future")).rejects.toBeInstanceOf(ContractIncompatibleError);

    // The point of checking early: no bytes fetched, nothing cached, no manifest record left behind
    // for the loader to trip over later.
    expect(downloads).toBe(before);
    expect(await manifest.getInstalled("future")).toBeUndefined();
    // …and the guard is specific to the incompatible entry, not the registry.
    await expect(mgr.install(registryUrl, "ok")).resolves.toMatchObject({ id: "ok" });
  });

  test("refuses to install an incompatible tracker, on the same terms", async () => {
    const { mgr, manifest } = manager("install-tracker");
    await mgr.add(registryUrl);
    const before = downloads;

    await expect(mgr.installTracker(registryUrl, "future-trk")).rejects.toBeInstanceOf(ContractIncompatibleError);

    expect(downloads).toBe(before);
    expect(await manifest.getInstalledTracker("future-trk")).toBeUndefined();
    await expect(mgr.installTracker(registryUrl, "ok-trk")).resolves.toMatchObject({ id: "ok-trk" });
  });

  // ── Update detection ───────────────────────────────────────────────────────

  test("checkUpdates never offers a newer bridge version this build can't load", async () => {
    const { mgr, manifest } = manager("updates-bridge");
    await mgr.add(registryUrl);
    // Both installed one patch behind what the registry now offers; only one of the two upgrades is
    // loadable, and taking the other would break a working install.
    await manifest.addInstalled(installed("ok", registryUrl));
    await manifest.addInstalled(installed("future", registryUrl));

    const updates = await mgr.checkUpdates();
    expect(updates.map((u) => u.id)).toEqual(["ok"]);
    expect(updates[0]).toMatchObject({ installedVersion: "0.0.9", availableVersion: "1.0.0" });
  });

  test("checkTrackerUpdates suppresses the same way", async () => {
    const { mgr, manifest } = manager("updates-tracker");
    await mgr.add(registryUrl);
    await manifest.addInstalledTracker(installed("ok-trk", registryUrl));
    await manifest.addInstalledTracker(installed("future-trk", registryUrl));

    expect((await mgr.checkTrackerUpdates()).map((u) => u.id)).toEqual(["ok-trk"]);
  });

  // ── Browse ─────────────────────────────────────────────────────────────────

  test("browse annotates compatibility rather than hiding the entry", async () => {
    const { mgr } = manager("browse-bridge");
    await mgr.add(registryUrl);
    const listed = await mgr.browse(registryUrl);

    // Hiding it would read as a missing bridge — the user needs to see it's there and why it can't
    // be installed.
    expect(listed.map((b) => b.entry.id)).toEqual(["ok", "future"]);
    expect(listed.find((b) => b.entry.id === "ok")?.compatible).toBe(true);
    expect(listed.find((b) => b.entry.id === "future")?.compatible).toBe(false);
  });

  test("browse suppresses updateAvailable for an incompatible newer version", async () => {
    const { mgr, manifest } = manager("browse-update");
    await mgr.add(registryUrl);
    await manifest.addInstalled(installed("ok", registryUrl));
    await manifest.addInstalled(installed("future", registryUrl));

    const listed = await mgr.browse(registryUrl);
    const ok = listed.find((b) => b.entry.id === "ok");
    const future = listed.find((b) => b.entry.id === "future");
    expect(ok).toMatchObject({ installedVersion: "0.0.9", updateAvailable: true });
    // Still shown as installed at 0.0.9 — just not nudged toward an upgrade that wouldn't load.
    expect(future).toMatchObject({ installedVersion: "0.0.9", updateAvailable: false, compatible: false });
  });

  test("browseTrackers annotates and suppresses identically", async () => {
    const { mgr, manifest } = manager("browse-tracker");
    await mgr.add(registryUrl);
    await manifest.addInstalledTracker(installed("ok-trk", registryUrl));
    await manifest.addInstalledTracker(installed("future-trk", registryUrl));

    const listed = await mgr.browseTrackers(registryUrl);
    expect(listed.map((t) => t.entry.id)).toEqual(["ok-trk", "future-trk"]);
    expect(listed.find((t) => t.entry.id === "ok-trk")).toMatchObject({ compatible: true, updateAvailable: true });
    expect(listed.find((t) => t.entry.id === "future-trk")).toMatchObject({
      compatible: false,
      updateAvailable: false,
    });
  });
});

/** A registry index entry — `extra` carries the bridge-only fields. */
function entry(
  id: string,
  contractVersion: string,
  url: string,
  sha256: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, name: id, version: "1.0.0", contractVersion, capabilities: [], url, sha256, ...extra };
}

/** A manifest record one patch behind the registry, seeded without running a real install. */
function installed(id: string, registryUrl: string) {
  return {
    id,
    version: "0.0.9",
    contractVersion: "1.0.0",
    registryUrl,
    bundlePath: `/nonexistent/${id}.js`,
    sha256: "a".repeat(64),
    installedAt: new Date().toISOString(),
  };
}
