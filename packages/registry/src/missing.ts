/**
 * Naming the bridges a library still holds series from after they were uninstalled.
 *
 * Uninstalling never touches the library, so its series stay — and a client still has to say what
 * they are, hide them when they are adult content and the user hides that, and open them as pages
 * when the bridge was `direct`. With the bridge gone, the only places that know any of that are the
 * record kept at uninstall and the registries that offer it. This asks them in that order.
 *
 * Node-free, so the on-device provider shares it with `RegistryManager`.
 */
import type { AvailableBridge } from "./available.ts";
import type { BridgeSnapshot, MissingBridge, RegistryBridgeEntry, RetiredBridge } from "./schema.ts";

/** How long a lookup waits on registries for an id nothing local knows. A slow host can't hold up
 *  the library screen: past this the id goes back unnamed, and the fetch, finishing anyway, leaves
 *  the index cached for the next ask. */
export const MISSING_LOOKUP_TIMEOUT_MS = 4_000;

/** The parts of an index entry a client lists a bridge's series by. */
export function snapshotOf(entry: Pick<RegistryBridgeEntry, "name" | "nsfw" | "capabilities">): BridgeSnapshot {
  return { name: entry.name, nsfw: entry.nsfw, capabilities: [...entry.capabilities] };
}

export interface MissingBridgeSources {
  /** Bridges uninstalled here, with what was known of them then. */
  retired: RetiredBridge[];
  /** Entries from indexes already read — no network. */
  cached: Array<Pick<AvailableBridge, "entry" | "registryUrl">>;
  /** Read the saved registries, for ids nothing above knows. Omitted: don't touch the network. */
  browseAll?: () => Promise<Array<Pick<AvailableBridge, "entry" | "registryUrl">>>;
  timeoutMs?: number;
}

/**
 * Describe each of `ids`: from its retired record, else from a cached index entry, else — only if
 * some are still unknown and `browseAll` is given — from the registries, under a timeout. An id
 * nobody knows comes back as just `{ id }`. A retired record from before snapshots were kept still
 * gives the registry it came from; the rest is then filled from an index if one has it.
 */
export async function describeMissingBridges(ids: string[], src: MissingBridgeSources): Promise<MissingBridge[]> {
  const out = new Map<string, MissingBridge>();
  const retired = new Map(src.retired.map((r) => [r.id, r]));
  for (const id of ids) {
    const rec = retired.get(id);
    out.set(id, {
      id,
      ...(rec?.info ? rec.info : {}),
      ...(rec?.registryUrl ? { registryUrl: rec.registryUrl } : {}),
    });
  }

  // The registry it was installed from wins over another that happens to list the same id.
  const fill = (entries: Array<Pick<AvailableBridge, "entry" | "registryUrl">>) => {
    for (const sameRegistryOnly of [true, false]) {
      for (const { entry, registryUrl } of entries) {
        const cur = out.get(entry.id);
        if (!cur || cur.name !== undefined) continue;
        if (sameRegistryOnly && cur.registryUrl !== undefined && cur.registryUrl !== registryUrl) continue;
        out.set(entry.id, { ...cur, ...snapshotOf(entry), registryUrl: cur.registryUrl ?? registryUrl });
      }
    }
  };
  const unnamed = () => [...out.values()].some((m) => m.name === undefined);

  fill(src.cached);
  if (unnamed() && src.browseAll) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), src.timeoutMs ?? MISSING_LOOKUP_TIMEOUT_MS);
    });
    try {
      const browsed = await Promise.race([src.browseAll().catch(() => undefined), timeout]);
      if (browsed) fill(browsed);
    } finally {
      clearTimeout(timer);
    }
  }
  return ids.map((id) => out.get(id)!);
}

/** `list` with `id`'s record replaced by `rec` (or just removed, without one). */
export function withRetired(list: RetiredBridge[], id: string, rec?: RetiredBridge): RetiredBridge[] {
  const rest = list.filter((r) => r.id !== id);
  return rec ? [...rest, rec] : rest;
}
