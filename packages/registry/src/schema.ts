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

/** A single bridge entry in the registry index. */
export const registryBridgeEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
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
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
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
   * Base64url-encoded Ed25519 public key for this registry.
   * Present when the operator signs bridge entries; absent for checksum-only registries.
   */
  publicKey: z.string().optional(),
  bridges: z.array(registryBridgeEntrySchema),
  trackers: z.array(registryTrackerEntrySchema).optional(),
});
export type RegistryIndex = z.infer<typeof registryIndexSchema>;

/** Persisted record of a user-added registry, stored in the local manifest. */
export const savedRegistrySchema = z.object({
  /** The canonical URL the user added (already resolved to index.json). */
  url: z.string().url(),
  /** Human-readable display name (defaults to the hostname). */
  name: z.string(),
  /** Pinned public key fingerprint (SHA-256 of the public key bytes, hex). */
  publicKeyFingerprint: z.string().optional(),
  /** ISO-8601 timestamp of last successful fetch. */
  lastFetched: z.string().optional(),
  /** Whether this registry requires signature verification. Default: false. */
  requireSignature: z.boolean().default(false),
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
