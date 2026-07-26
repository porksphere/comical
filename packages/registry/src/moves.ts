/**
 * Registry-move primitives, shared by the server's `RegistryManager` and the on-device
 * `EmbeddedRegistryProvider`.
 *
 * The two hold their state very differently — one JSON manifest vs. three AsyncStorage stores — so
 * the *mechanics* of a rebind can't be shared. The **trust decisions** must be, because a divergence
 * between them is a security bug that only shows up on one platform. Everything that decides whether
 * a move is followed lives here; each side only supplies its own persistence.
 *
 * Node-free by construction (WebCrypto only), so host-rn can import it.
 */
import type { RegistryIndex } from "./schema.ts";
import { publicKeyFingerprint } from "./verify.ts";

/** A registry move that was refused because it doesn't look like the same registry. */
export class MoveError extends Error {
  override readonly name = "MoveError";
}

/**
 * Hard cap on `movedTo` hops followed in one resolution. A chain this long is already pathological;
 * the cap is what stops a hostile or broken index from turning every fetch into a crawl.
 */
export const MAX_MOVE_HOPS = 3;

/** Every id offered by an index, bridges and trackers alike. */
export function offeredIds(index: RegistryIndex): Set<string> {
  return new Set<string>([
    ...index.bridges.map((b) => b.id),
    ...(index.trackers ?? []).map((t) => t.id),
  ]);
}

/**
 * Guard against a "move" that isn't one.
 *
 * Bridge ids are the key for *everything* the user owns — settings, credentials, library entries
 * (`entryKey(bridgeId, seriesId)`), history, progress — so a move preserves all of it precisely
 * because the ids don't change. That cuts the other way too: if a registry has installs and the
 * target index shares none of their ids, this is a different registry wearing the name. Rebinding to
 * it would hand it update authority over bridges it never published, while every install silently
 * reads as discontinued. A *partial* overlap is normal (a publisher dropping a bridge across the
 * move) and allowed; an empty one is refused.
 *
 * `installedIds` is the ids installed from `oldUrl` — empty means nothing is at stake, so anything goes.
 */
export function assertSameRegistry(
  oldUrl: string,
  newUrl: string,
  installedIds: string[],
  index: RegistryIndex,
): void {
  if (installedIds.length === 0) return;
  const offered = offeredIds(index);
  if (installedIds.some((id) => offered.has(id))) return;
  throw new MoveError(
    `refusing to move ${oldUrl} → ${newUrl}: none of the ${installedIds.length} installed id(s) ` +
      `appear in the target index, so this is not the same registry`,
  );
}

/**
 * True when `index` is signed by the key already pinned for the registry being moved *from* — the
 * one piece of cryptographic proof that the same operator is behind both URLs, and the only thing
 * that lets a move be followed without asking the user.
 */
export async function hasKeyContinuity(
  pinnedFingerprint: string | undefined,
  index: RegistryIndex,
): Promise<boolean> {
  if (!pinnedFingerprint || !index.publicKey) return false;
  return (await publicKeyFingerprint(index.publicKey)) === pinnedFingerprint;
}
