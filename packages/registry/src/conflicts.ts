/**
 * Install-conflict guard, shared by the server's `RegistryManager` and the on-device
 * `EmbeddedRegistryProvider` — for the same reason `moves.ts` is shared: the two runtimes hold their
 * state very differently, but a decision about *what is allowed to overwrite what* has to be
 * identical on both, or the weaker one becomes the way in.
 *
 * Both keep installs in a store keyed by bare id, so writing a record is an upsert: installing an id
 * you already have overwrites the old one. That's exactly right when it's the same registry (a
 * re-pin, or an update) and a silent takeover when it isn't. The replacement record carries a
 * different publisher's bundle URL, sha256 and signing key, while everything the user owns —
 * library entries (`entryKey(bridgeId, seriesId)`), history, progress, credentials, downloads —
 * stays keyed to the unchanged id and now resolves through that other publisher's code.
 *
 * This needs no hostile publisher to happen: ids are only unique *within* a registry, so two
 * registries can ship the same id in good faith. It just also happens to be what id-squatting looks
 * like, which is why it's refused rather than prompted. Uninstalling first is the one action that
 * makes the id-keyed data loss explicit instead of silent.
 *
 * Node-free by construction, so host-rn can import it.
 */

/** An install refused because the id is already held by a different registry. */
export class InstallConflictError extends Error {
  override readonly name = "InstallConflictError";
}

/** As much of an existing install record as the guard needs. `null` = built locally, no registry. */
export interface InstalledOrigin {
  registryUrl: string | null;
}

/**
 * Refuse to install `id` from `url` when it's already installed from somewhere else.
 *
 * `existing` is the current record for that id, if any — nullish means nothing is installed and
 * anything goes. A record from the *same* registry passes: that's the update/re-pin path, and a
 * followed registry move repoints its records' `registryUrl` before any install runs, so a migrated
 * install still matches.
 */
export function assertInstallableFrom(
  kind: "bridge" | "tracker",
  id: string,
  url: string,
  existing: InstalledOrigin | null | undefined,
): void {
  if (!existing) return;
  const from = existing.registryUrl;
  if (from === url) return;
  throw new InstallConflictError(
    from === null
      ? `${kind} "${id}" is already installed locally, not from a registry. Uninstall it first if you ` +
        `mean to replace it with ${url}'s — they are different code under the same id, and everything ` +
        `saved under it (library, history, progress) would silently follow the new one.`
      : `${kind} "${id}" is already installed from ${from}. Uninstall it first if you mean to replace ` +
        `it with ${url}'s — they are different code under the same id, and everything saved under it ` +
        `(library, history, progress) would silently follow the new one.`,
  );
}
