/**
 * Fetches and validates a registry index from a resolved URL.
 * Downloads a bridge bundle, verifies its checksum (always), and optionally
 * verifies its Ed25519 signature.
 */
import { registryIndexSchema, type RegistryIndex } from "./schema.ts";

/** Minimal shape required to download and verify any registry bundle (bridge or tracker). */
export interface BundleEntryLike {
  id: string;
  url: string;
  sha256: string;
  signature?: string | undefined;
}
import { verifyChecksum, verifySignature, sha256Hex } from "./verify.ts";

export class FetchError extends Error {
  override readonly name = "FetchError";
  constructor(message: string, readonly status?: number) { super(message); }
}

/** Fetch and parse a registry index from `url`. Throws on network error or invalid schema. */
export async function fetchIndex(url: string): Promise<RegistryIndex> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new FetchError(`network error fetching ${url}: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status} fetching ${url}`, res.status);

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new FetchError(`invalid JSON in registry index at ${url}`);
  }

  const parsed = registryIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FetchError(
      `registry index at ${url} failed schema validation: ${parsed.error.issues.map(i => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export interface DownloadResult {
  bytes: Uint8Array;
  sha256: string;
  text: string;
}

/**
 * Download a bundle (bridge or tracker), verify its SHA-256 checksum (always), and optionally
 * verify its Ed25519 signature if both `entry.signature` and `publicKey` are present.
 *
 * When `requireSignature` is true and no signature is present, throws VerificationError.
 */
export async function downloadBundle(
  entry: BundleEntryLike,
  opts: { publicKey?: string; requireSignature?: boolean } = {},
): Promise<DownloadResult> {
  let res: Response;
  try {
    res = await fetch(entry.url);
  } catch (e) {
    throw new FetchError(
      `network error downloading bridge "${entry.id}": ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status} downloading bridge "${entry.id}"`, res.status);

  const bytes = new Uint8Array(await res.arrayBuffer() as ArrayBuffer);

  // 1. Always verify checksum.
  await verifyChecksum(bytes, entry.sha256);

  // 2. Optionally verify signature.
  if (entry.signature && opts.publicKey) {
    await verifySignature(entry.sha256, entry.signature, opts.publicKey);
  } else if (opts.requireSignature) {
    throw new Error(
      `bridge "${entry.id}" has no signature but registry requires signature verification`,
    );
  }

  const actual = await sha256Hex(bytes);
  return { bytes, sha256: actual, text: new TextDecoder().decode(bytes) };
}
