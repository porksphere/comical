/**
 * Per-bridge, process-lifetime memory of tag id→label pairs.
 *
 * Bridges store and forward tags as bare ids (the durable key); names are presentational. This cache
 * lets the host fold names back into id-only responses (e.g. a bridge's persisted `excludedTags`)
 * without the client carrying labels or making a second round-trip. Being host-side, one warm cache
 * serves every client of this server — so labels survive across browsers and devices, which a
 * per-browser client cache cannot.
 *
 * It is fed, cheapest source first, by:
 *  - labels the client already holds when it saves an exclusion (`remember`),
 *  - series-detail responses passing through the router (their tag groups pair id + name),
 *  - and, as the authoritative backstop, a bridge's `resolveTags(ids)` for ids it has never seen.
 */
export interface ResolvableBridge {
  info: { id: string; capabilities?: string[] };
  resolveTags?(ids: string[]): Promise<{ id: string; label: string }[]>;
}

export class TagLabelCache {
  private readonly byBridge = new Map<string, Map<string, string>>();

  /** Record id→label pairs already known (from a save body or a series-detail response). */
  remember(bridgeId: string, pairs: Iterable<{ id: string; label: string }>): void {
    let m = this.byBridge.get(bridgeId);
    if (!m) {
      m = new Map();
      this.byBridge.set(bridgeId, m);
    }
    for (const { id, label } of pairs) {
      // A label equal to the id carries no information (free-form entry) — don't pollute the cache.
      if (id && label && label !== id) m.set(id, label);
    }
  }

  /** The cached labels for the subset of `ids` we know; misses are simply absent. */
  known(bridgeId: string, ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const m = this.byBridge.get(bridgeId);
    if (!m) return out;
    for (const id of ids) {
      const label = m.get(id);
      if (label) out[id] = label;
    }
    return out;
  }

  /**
   * Resolve `ids` to labels: cache hits first, then a single `resolveTags` call for the misses on a
   * `"resolve-tags"`-capable bridge (results cached for next time). Tolerant by design — a resolve
   * failure, a non-capable bridge, or a slow backend all just yield the cached subset, so the caller
   * falls back to the raw id rather than erroring or stalling.
   *
   * The lookup is bounded by `timeoutMs`: a cold, slow, or Cloudflare-gated backend must not hang the
   * response (e.g. the settings panel). On timeout we return what we have; the in-flight call keeps
   * running and still warms the cache for the next load.
   */
  async resolve(bridge: ResolvableBridge, ids: string[], timeoutMs = 4000): Promise<Record<string, string>> {
    const out = this.known(bridge.info.id, ids);
    const missing = ids.filter((id) => !(id in out));
    if (missing.length === 0 || !bridge.resolveTags || !bridge.info.capabilities?.includes("resolve-tags")) {
      return out;
    }
    // Self-contained so the background promise never rejects unhandled even if the race times out.
    const lookup = (async (): Promise<{ id: string; label: string }[]> => {
      try {
        const resolved = await bridge.resolveTags!(missing);
        this.remember(bridge.info.id, resolved);
        return resolved;
      } catch {
        return [];
      }
    })();
    const resolved = await Promise.race([
      lookup,
      new Promise<{ id: string; label: string }[]>((r) => setTimeout(() => r([]), timeoutMs)),
    ]);
    const wanted = new Set(missing);
    for (const { id, label } of resolved) if (wanted.has(id) && label) out[id] = label;
    return out;
  }
}
