/**
 * Contract-compatibility guard for registry entries — shared by the server's `RegistryManager` and
 * the on-device `EmbeddedRegistryProvider`, for the same reason `conflicts.ts` is shared: the
 * decision has to be identical on both, or the weaker one becomes the way in.
 *
 * `@comical/core`'s loaders already refuse a bundle whose `contractVersion` this runtime can't
 * honour — but they do it at *evaluation* time, which is the wrong end of the process to find out.
 * By then the bundle has been fetched, checksum-verified, written to the cache and recorded in the
 * manifest, and the only symptom the user gets is that the bridge or tracker stopped working. The
 * update path made that worse than merely useless: `checkUpdates` compared versions alone, so a
 * routine "update available" tap could replace a working install with one the runtime refuses,
 * with nothing anywhere explaining why.
 *
 * So the same check runs here too, against the index entry, before anything is downloaded — and
 * browse listings carry the verdict so a client can label an entry "needs a newer app" instead of
 * offering an install that cannot work. Registry entries mirror their bundle's declared
 * `contractVersion` (the publish CLI copies it straight from `info`), so the entry is a faithful
 * stand-in for the bundle here.
 *
 * Node-free by construction, so host-rn can import it.
 */
import { CONTRACT_VERSION, isContractCompatible } from "@comical/contract";

/** An install refused because the entry targets a contract this runtime can't honour. */
export class ContractIncompatibleError extends Error {
  override readonly name = "ContractIncompatibleError";
}

/**
 * Can this runtime load a bundle targeting `contractVersion`?
 *
 * Thin pass-through to the contract's own rule (same major, and not a newer minor/patch than the
 * runtime implements) so browse annotations and the install guard can never drift apart, and
 * neither can drift from what the loader will actually accept.
 */
export function isEntryCompatible(contractVersion: string, runtimeVersion: string = CONTRACT_VERSION): boolean {
  return isContractCompatible(contractVersion, runtimeVersion);
}

/**
 * Refuse to install an entry this runtime could not load.
 *
 * The two failing directions read very differently to a user, so they get different messages: a
 * newer contract means their app is behind and updating it fixes this, while an older *major* means
 * the entry is stale and only its publisher can fix it. Neither is worth downloading a bundle over.
 */
export function assertContractCompatible(
  kind: "bridge" | "tracker",
  id: string,
  contractVersion: string,
  runtimeVersion: string = CONTRACT_VERSION,
): void {
  if (isEntryCompatible(contractVersion, runtimeVersion)) return;
  throw new ContractIncompatibleError(
    `${kind} "${id}" targets contract ${contractVersion}, which this app (contract ${runtimeVersion}) ` +
      `cannot load. ${isAhead(contractVersion, runtimeVersion)
        ? "Update the app and try again."
        : "It was built for an older, incompatible contract — its publisher needs to update it."}`,
  );
}

/** Is `contractVersion` asking for something newer than the runtime, rather than older? */
function isAhead(contractVersion: string, runtimeVersion: string): boolean {
  const entry = parts(contractVersion);
  const runtime = parts(runtimeVersion);
  if (!entry || !runtime) return false; // malformed: neither message fits, so use the "stale" wording
  for (let i = 0; i < 3; i++) {
    if (entry[i]! !== runtime[i]!) return entry[i]! > runtime[i]!;
  }
  return false;
}

/** Comparable tuple, or undefined for anything that isn't strict `x.y.z`. */
function parts(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
