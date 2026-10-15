/**
 * Resolves which of a bridge's page-image budgets (`info.assetRateLimit`) an asset URL falls
 * under, so the image proxy and the download engine — which pace images on the bridge's behalf —
 * read the declaration the same way. The result's `key` names the budget (one limiter per key per
 * bridge); the default budget is `""`, a `byHost` group its index.
 */
import type { AssetRateLimit } from "@comical/contract";
import { findHostRule, hostOf } from "./url-match.ts";
import type { RateLimitBudget } from "./rate-limiter.ts";

export interface ResolvedAssetBudget {
  key: string;
  budget: RateLimitBudget;
}

/** The host an asset is really fetched from: a server-relative `/img-proxy?url=…` is unwrapped. */
export function assetHostOf(url: string): string | undefined {
  const proxied = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?\/img-proxy\?(?:.*&)?url=([^&#]+)/i.exec(url);
  const target = proxied ? safeDecode(proxied[1]!) : url;
  return hostOf(target);
}

/**
 * The budget to pace `url` by, or undefined when the bridge declares none for it (unpaced). A host
 * no group names — including one the URL doesn't reveal — gets the default budget.
 */
export function assetBudgetFor(decl: AssetRateLimit | undefined, url: string): ResolvedAssetBudget | undefined {
  if (!decl) return undefined;
  const host = assetHostOf(url);
  if (host && decl.byHost) {
    for (let i = 0; i < decl.byHost.length; i++) {
      const group = decl.byHost[i]!;
      if (findHostRule(host, group.hosts) === -1) continue;
      const budget: RateLimitBudget = {};
      if (group.maxConcurrent !== undefined) budget.maxConcurrent = group.maxConcurrent;
      if (group.minIntervalMs !== undefined) budget.minIntervalMs = group.minIntervalMs;
      return { key: String(i), budget };
    }
  }
  const budget: RateLimitBudget = {};
  if (decl.maxConcurrent !== undefined) budget.maxConcurrent = decl.maxConcurrent;
  if (decl.minIntervalMs !== undefined) budget.minIntervalMs = decl.minIntervalMs;
  return { key: "", budget };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
