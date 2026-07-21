import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  FetchError,
  ManifestStore,
  RegistryManager,
  VerificationError,
  assertVersionImmutable,
  generateKeyPair,
  publicKeyFingerprint,
  registryBridgeEntrySchema,
  registryDisplayName,
  resolveRegistryUrl,
  sha256Hex,
  signSha256,
  verifyChecksum,
  verifySignature,
} from "../src/index.ts";

const BUNDLE_PATH = join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js");
const DATA_DIR = join(import.meta.dir, ".tmp-registry");

// ── URL resolution ────────────────────────────────────────────────────────────

describe("resolveRegistryUrl", () => {
  test("resolves github.com repo URL to raw content", () => {
    expect(resolveRegistryUrl("github.com/alice/my-bridges"))
      .toBe("https://raw.githubusercontent.com/alice/my-bridges/main/index.json");
    expect(resolveRegistryUrl("https://github.com/alice/my-bridges"))
      .toBe("https://raw.githubusercontent.com/alice/my-bridges/main/index.json");
    expect(resolveRegistryUrl("https://github.com/alice/my-bridges/"))
      .toBe("https://raw.githubusercontent.com/alice/my-bridges/main/index.json");
  });

  test("uses a direct .json URL as-is", () => {
    expect(resolveRegistryUrl("https://cdn.example.com/registry.json"))
      .toBe("https://cdn.example.com/registry.json");
  });

  test("appends /index.json to a bare host path", () => {
    expect(resolveRegistryUrl("https://alice.github.io/bridges"))
      .toBe("https://alice.github.io/bridges/index.json");
  });

  test("adds https:// to protocol-less input", () => {
    expect(resolveRegistryUrl("alice.github.io/bridges/index.json"))
      .toBe("https://alice.github.io/bridges/index.json");
  });
});

describe("registryDisplayName", () => {
  test("shortens raw.githubusercontent.com to owner/repo", () => {
    expect(registryDisplayName("https://raw.githubusercontent.com/alice/bridges/main/index.json"))
      .toBe("alice/bridges");
  });

  test("returns hostname for other URLs", () => {
    expect(registryDisplayName("https://cdn.example.com/index.json")).toBe("cdn.example.com");
  });
});

const BASE_ENTRY = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
  url: "https://cdn.example.com/bridges/example/0.1.0/bridge.js",
  sha256: "a".repeat(64),
};

describe("registryBridgeEntrySchema iconUrl", () => {
  test("accepts an absolute icon URL", () => {
    const entry = registryBridgeEntrySchema.parse({ ...BASE_ENTRY, iconUrl: "https://example.com/favicon.ico" });
    expect(entry.iconUrl).toBe("https://example.com/favicon.ico");
  });

  test("parses when omitted (backward-compatible with existing registry entries)", () => {
    expect(registryBridgeEntrySchema.parse({ ...BASE_ENTRY }).iconUrl).toBeUndefined();
  });
});

describe("registryBridgeEntrySchema assetProxy", () => {
  test("round-trips declared proxy hosts + Referer from the index", () => {
    const entry = registryBridgeEntrySchema.parse({
      ...BASE_ENTRY,
      assetProxy: { hosts: ["cdn.example.net", "example.org"], referer: "https://example.org/" },
    });
    expect(entry.assetProxy).toEqual({ hosts: ["cdn.example.net", "example.org"], referer: "https://example.org/" });
  });

  test("parses when omitted (bridges that proxy nothing)", () => {
    expect(registryBridgeEntrySchema.parse({ ...BASE_ENTRY }).assetProxy).toBeUndefined();
  });
});

// ── Checksum verification ─────────────────────────────────────────────────────

describe("verifyChecksum", () => {
  test("passes for matching checksum", async () => {
    const bytes = new Uint8Array(Buffer.from("hello"));
    const hash = await sha256Hex(bytes);
    await expect(verifyChecksum(bytes, hash)).resolves.toBeUndefined();
  });

  test("throws VerificationError for wrong checksum", async () => {
    const bytes = new Uint8Array(Buffer.from("hello"));
    await expect(verifyChecksum(bytes, "a".repeat(64))).rejects.toBeInstanceOf(VerificationError);
  });
});

// ── Publish-time immutability guard ────────────────────────────────────────────
// This is what stops a version-pinned path (`bridges/<id>/<version>/bridge.js`) from being
// silently republished with different bytes — content changing at an already-published version
// broke every installed device's pinned sha256, since a same-version republish never bumps and so
// never surfaces as an "update" for the client to catch.

describe("assertVersionImmutable", () => {
  test("no-op when nothing was previously published at this path", () => {
    expect(() => assertVersionImmutable("demo@1.0.0", undefined, "abc123")).not.toThrow();
  });

  test("no-op when republishing byte-identical content", () => {
    expect(() => assertVersionImmutable("demo@1.0.0", "abc123", "abc123")).not.toThrow();
  });

  test("throws when the hash changed at an already-published version", () => {
    expect(() => assertVersionImmutable("demo@1.0.0", "abc123", "def456")).toThrow(
      /demo@1\.0\.0.*version was not bumped/s,
    );
  });
});

// ── Ed25519 signing ───────────────────────────────────────────────────────────

describe("signing", () => {
  test("generateKeyPair produces a valid keypair", async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    expect(publicKey.length).toBeGreaterThan(0);
    expect(privateKey.length).toBeGreaterThan(0);
  });

  test("sign + verify round-trip succeeds", async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const bytes = new Uint8Array(Buffer.from("test bundle"));
    const hash = await sha256Hex(bytes);
    const sig = await signSha256(hash, privateKey);
    await expect(verifySignature(hash, sig, publicKey)).resolves.toBeUndefined();
  });

  test("wrong signature fails verification", async () => {
    const { publicKey } = await generateKeyPair();
    const { privateKey: otherPriv } = await generateKeyPair();
    const bytes = new Uint8Array(Buffer.from("test"));
    const hash = await sha256Hex(bytes);
    const wrongSig = await signSha256(hash, otherPriv);
    await expect(verifySignature(hash, wrongSig, publicKey)).rejects.toBeInstanceOf(VerificationError);
  });

  test("publicKeyFingerprint is deterministic", async () => {
    const { publicKey } = await generateKeyPair();
    const fp1 = await publicKeyFingerprint(publicKey);
    const fp2 = await publicKeyFingerprint(publicKey);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(64); // hex SHA-256
  });
});

// ── Registry index fetch (local mock server) ──────────────────────────────────

describe("fetchIndex + RegistryManager", () => {
  let srv: ReturnType<typeof Bun.serve>;
  let registryUrl: string;
  let bridgeUrl: string;
  let indexJson: string;
  let bundleBytes: Uint8Array<ArrayBuffer>;
  let bundleHash: string;

  beforeAll(async () => {
    bundleBytes = new Uint8Array(readFileSync(BUNDLE_PATH) as Buffer);
    bundleHash = await sha256Hex(bundleBytes);

    const index = {
      registryVersion: "1",
      updated: new Date().toISOString(),
      displayName: "Curated",
      bridges: [{
        id: "example",
        name: "Example Bridge",
        version: "0.1.0",
        contractVersion: "1.0.0",
        languages: ["en"],
        nsfw: false,
        capabilities: ["search"],
        url: "PLACEHOLDER", // filled after server starts
        sha256: bundleHash,
      }],
    };

    srv = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/index.json") return new Response(indexJson, { headers: { "content-type": "application/json" } });
        if (path === "/bridge.js") return new Response(bundleBytes);
        return new Response("not found", { status: 404 });
      },
    });

    registryUrl = `http://localhost:${srv.port}/index.json`;
    bridgeUrl = `http://localhost:${srv.port}/bridge.js`;
    index.bridges[0]!.url = bridgeUrl;
    indexJson = JSON.stringify(index);
  });

  afterAll(() => srv.stop(true));

  test("adds a registry and reads its bridges", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-add"));
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-add"), manifest });
    const added = await mgr.add(registryUrl);
    expect(added.url).toBe(registryUrl);
    // The operator's index `displayName` is captured onto the saved registry.
    expect(added.displayName).toBe("Curated");
    const available = await mgr.browse(registryUrl);
    expect(available.length).toBe(1);
    expect(available[0]!.entry.id).toBe("example");
    expect(available[0]!.installedVersion).toBeNull();
    expect(available[0]!.updateAvailable).toBe(false);
  });

  test("reconciles a changed displayName onto the saved registry on next fetch", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-reconcile"));
    // Seed as if it were added when the operator's label was different (here: stale/older).
    await manifest.addRegistry({ url: registryUrl, name: "example", requireSignature: false, displayName: "Stale" });
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-reconcile"), manifest });
    await mgr.browse(registryUrl); // fetches the index (displayName "Curated") → reconcile side-effect
    expect((await manifest.getRegistry(registryUrl))?.displayName).toBe("Curated");
  });

  test("installs a bridge: downloads, verifies checksum, caches to disk", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-install"));
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-install"), manifest });
    await mgr.add(registryUrl);
    const result = await mgr.install(registryUrl, "example");
    expect(result.id).toBe("example");
    expect(result.version).toBe("0.1.0");
    // Bundle is on disk and readable.
    const code = readFileSync(result.bundlePath, "utf8");
    expect(code.length).toBeGreaterThan(0);
  });

  test("installed bridge shows updateAvailable=false when already at latest", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-noupdate"));
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-noupdate"), manifest });
    await mgr.add(registryUrl);
    await mgr.install(registryUrl, "example");
    const available = await mgr.browse(registryUrl);
    expect(available[0]!.installedVersion).toBe("0.1.0");
    expect(available[0]!.updateAvailable).toBe(false);
  });

  test("removing a registry marks its bridges as orphaned", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-orphan"));
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-orphan"), manifest });
    await mgr.add(registryUrl);
    await mgr.install(registryUrl, "example");
    await mgr.remove(registryUrl);
    expect(await mgr.isOrphaned("example")).toBe(true);
    expect(await mgr.resolveBundle("example")).toBeNull();
  });

  test("uninstall removes bridge from manifest", async () => {
    const manifest = new ManifestStore(join(DATA_DIR, "test-uninstall"));
    const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-uninstall"), manifest });
    await mgr.add(registryUrl);
    await mgr.install(registryUrl, "example");
    await mgr.uninstall("example");
    expect(await mgr.isOrphaned("example")).toBe(false);
    expect(await mgr.resolveBundle("example")).toBeNull();
  });

  test("checksum mismatch throws VerificationError during install", async () => {
    // Serve a tampered index with wrong sha256.
    const tamperedIndex = JSON.stringify({
      registryVersion: "1",
      updated: new Date().toISOString(),
      bridges: [{
        id: "example",
        name: "Example", version: "0.1.0", contractVersion: "1.0.0",
        languages: ["en"], nsfw: false, capabilities: [],
        url: bridgeUrl,
        sha256: "a".repeat(64), // wrong
      }],
    });
    const tamperSrv = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.json") return new Response(tamperedIndex, { headers: { "content-type": "application/json" } });
        if (p === "/bridge.js") return new Response(bundleBytes);
        return new Response("not found", { status: 404 });
      },
    });
    const tamperUrl = `http://localhost:${tamperSrv.port}/index.json`;
    try {
      const manifest = new ManifestStore(join(DATA_DIR, "test-tamper"));
      const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-tamper"), manifest });
      await mgr.add(tamperUrl);
      await expect(mgr.install(tamperUrl, "example")).rejects.toBeInstanceOf(VerificationError);
    } finally {
      tamperSrv.stop(true);
    }
  });

  test("signed registry: valid signature verifies successfully", async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const sig = await signSha256(bundleHash, privateKey);
    const signedIndex = JSON.stringify({
      registryVersion: "1",
      updated: new Date().toISOString(),
      publicKey,
      bridges: [{
        id: "example", name: "Example", version: "0.1.0", contractVersion: "1.0.0",
        languages: ["en"], nsfw: false, capabilities: [],
        url: bridgeUrl, sha256: bundleHash, signature: sig,
      }],
    });
    const signedSrv = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.json") return new Response(signedIndex, { headers: { "content-type": "application/json" } });
        if (p === "/bridge.js") return new Response(bundleBytes);
        return new Response("not found", { status: 404 });
      },
    });
    const signedUrl = `http://localhost:${signedSrv.port}/index.json`;
    try {
      const manifest = new ManifestStore(join(DATA_DIR, "test-signed"));
      const mgr = new RegistryManager({ cacheDir: join(DATA_DIR, "cache-signed"), manifest });
      await mgr.add(signedUrl);
      const result = await mgr.install(signedUrl, "example");
      expect(result.id).toBe("example");
    } finally {
      signedSrv.stop(true);
    }
  });
});
