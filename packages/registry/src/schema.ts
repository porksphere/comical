/**
 * Registry index schema — the versioned format for `index.json` hosted on any static server.
 *
 * A registry is two things:
 *   1. index.json  — this schema, cataloguing available bridges
 *   2. bridge bundle files — the CJS artifacts, served as static files
 *
 * Both can be hosted on GitHub Pages, Codeberg Pages, a CDN, or any static host.
 * GitHub repo URLs are auto-resolved to their raw content (see url.ts).
 */
import { z } from "zod";
import { BRIDGE_ID_PATTERN } from "@comical/contract";

/** A single bridge entry in the registry index. */
export const registryBridgeEntrySchema = z.object({
  id: z.string().regex(BRIDGE_ID_PATTERN),
  name: z.string().min(1),
  version: z.string(),
  contractVersion: z.string(),
  languages: z.array(z.string()).min(1),
  nsfw: z.boolean(),
  capabilities: z.array(z.string()),
  description: z.string().optional(),
  /** Absolute URL (or data URI) to a small square icon representing the bridge/source. */
  iconUrl: z.string().url().optional(),
  /**
   * Mirror of `BridgeInfo.assetProxy` — the hosts this bridge proxies assets from (+ optional
   * Referer). Carried in the index so a client that installs from the registry knows the proxy
   * allowlist without loading the bundle first (the on-device runtime derives its allowlist from
   * these). Omitted for bridges that emit no `/img-proxy` URLs.
   */
  assetProxy: z
    .object({
      hosts: z.array(z.string().min(1)).min(1),
      referer: z.string().url().optional(),
    })
    .optional(),
  /** Absolute URL to the CJS bridge bundle. */
  url: z.string().url(),
  /** Lowercase hex SHA-256 of the bundle content. Always required. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"),
  /**
   * Base64url Ed25519 signature over the SHA-256 bytes. Optional — present when the
   * registry operator has a keypair and wants to provide authenticity guarantees.
   */
  signature: z.string().optional(),
});
export type RegistryBridgeEntry = z.infer<typeof registryBridgeEntrySchema>;

/** A single tracker entry in the registry index. */
export const registryTrackerEntrySchema = z.object({
  id: z.string().regex(BRIDGE_ID_PATTERN),
  name: z.string().min(1),
  version: z.string(),
  contractVersion: z.string(),
  capabilities: z.array(z.string()),
  description: z.string().optional(),
  /** Absolute URL to the CJS tracker bundle. */
  url: z.string().url(),
  /** Lowercase hex SHA-256 of the bundle content. Always required. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"),
  signature: z.string().optional(),
});
export type RegistryTrackerEntry = z.infer<typeof registryTrackerEntrySchema>;

/** The top-level registry index file (index.json). */
export const registryIndexSchema = z.object({
  /** Semver of the index format itself (not the bridges). Current: "1". */
  registryVersion: z.literal("1"),
  /** ISO-8601 timestamp of when this index was last generated. */
  updated: z.string(),
  /**
   * Optional short label the operator sets for this registry (e.g. "SFW", "NSFW"). Clients show it
   * next to the derived owner/repo name, so one publisher can serve several distinguishable
   * registries from the same repo. Absent for registries that don't set one.
   */
  displayName: z.string().optional(),
  /**
   * Base64url-encoded Ed25519 public key for this registry.
   * Present when the operator signs bridge entries; absent for checksum-only registries.
   */
  publicKey: z.string().optional(),
  /**
   * Set by an operator who has moved this registry: the canonical URL it now lives at. Clients
   * follow it and repoint the saved registry (plus everything installed from it), so a planned
   * migration needs no user action — but only the *old* host can assert this, so it requires the
   * old URL to keep serving. Pair it with `movedFrom` on the new index for the case where it can't.
   */
  movedTo: z.string().url().optional(),
  /**
   * URLs this registry previously lived at, asserted by the *new* host. Lets a user who manually
   * re-adds a moved registry adopt their existing installs instead of stranding them — the recovery
   * path when the old host is gone entirely and `movedTo` was never reachable.
   *
   * Unlike `movedTo` this is an unauthenticated claim by an arbitrary publisher (anyone can say they
   * succeed anyone), so clients only honour it on an explicit user-initiated add, and only
   * automatically when the new index's key matches the fingerprint pinned for the old URL.
   */
  movedFrom: z.array(z.string().url()).optional(),
  bridges: z.array(registryBridgeEntrySchema),
  trackers: z.array(registryTrackerEntrySchema).optional(),
});
export type RegistryIndex = z.infer<typeof registryIndexSchema>;

/** Persisted record of a user-added registry, stored in the local manifest. */
export const savedRegistrySchema = z.object({
  /** The canonical URL the user added (already resolved to index.json). */
  url: z.string().url(),
  /** Human-readable name derived from the URL (e.g. the owner/repo, else the hostname). */
  name: z.string(),
  /** Operator-declared label captured from the index's `displayName`, shown next to `name`. Optional. */
  displayName: z.string().optional(),
  /** Pinned public key fingerprint (SHA-256 of the public key bytes, hex). */
  publicKeyFingerprint: z.string().optional(),
  /** ISO-8601 timestamp of last successful fetch. */
  lastFetched: z.string().optional(),
  /** Whether this registry requires signature verification. Default: false. */
  requireSignature: z.boolean().default(false),
  /**
   * A `movedTo` claim from this registry's index that could NOT be verified by key continuity
   * (unsigned registry, or a different key). Held here for the UI to surface as a one-tap confirm
   * rather than followed silently — an expired domain or a compromised repo could otherwise redirect
   * every user to a hostile registry.
   */
  pendingMove: z.string().url().optional(),
  /**
   * Saved-registry URLs this one claims to succeed (its index's `movedFrom`) that could not be
   * verified by key continuity. The UI offers adoption per entry, naming what would be rebound.
   */
  pendingAdoption: z.array(z.string().url()).optional(),
});
export type SavedRegistry = z.infer<typeof savedRegistrySchema>;

/** Persisted record of an installed bridge, stored in the local manifest. */
export const installedBridgeSchema = z.object({
  id: z.string(),
  version: z.string(),
  contractVersion: z.string(),
  /** URL of the registry this was installed from. null = locally built / no registry. */
  registryUrl: z.string().url().nullable(),
  /** Absolute path to the cached bundle on disk. */
  bundlePath: z.string(),
  /** SHA-256 of the installed bundle (for integrity re-verification). */
  sha256: z.string(),
  installedAt: z.string(),
});
export type InstalledBridge = z.infer<typeof installedBridgeSchema>;

/** Persisted record of an installed tracker, stored in the local manifest. */
export const installedTrackerSchema = z.object({
  id: z.string(),
  version: z.string(),
  contractVersion: z.string(),
  /** URL of the registry this was installed from. null = locally built / no registry. */
  registryUrl: z.string().url().nullable(),
  /** Absolute path to the cached bundle on disk. */
  bundlePath: z.string(),
  /** SHA-256 of the installed bundle (for integrity re-verification). */
  sha256: z.string(),
  installedAt: z.string(),
});
export type InstalledTracker = z.infer<typeof installedTrackerSchema>;

/** The full local manifest stored in dataDir/registry-manifest.json. */
export const manifestSchema = z.object({
  registries: z.array(savedRegistrySchema),
  installed: z.array(installedBridgeSchema),
  installedTrackers: z.array(installedTrackerSchema).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;
