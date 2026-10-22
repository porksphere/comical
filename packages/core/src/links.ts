/**
 * Opening a web link to a source (`BridgeInfo.linkHosts` + `Bridge.resolveUrl`, contract 2.1):
 * pick the bridges whose declared hosts cover the link, then ask each in turn until one recognizes
 * it. Hosts share this so a pasted link resolves the same everywhere.
 */
import type { BridgeInfo, LinkTarget } from "@comical/contract";
import { findHostRule, hostOf } from "./net/url-match.ts";

/** Why a link opened nothing: not a web link, no installed bridge covers its host, or none recognized it. */
export type LinkMissReason = "invalid-url" | "no-bridge" | "not-recognized";

export type LinkResolution =
  | { ok: true; bridgeId: string; target: LinkTarget }
  | { ok: false; reason: LinkMissReason };

/** The pasted text as a link: trimmed, and only when it is an absolute http(s) URL with a host. */
export function normalizeLink(text: string): string | undefined {
  const url = text.trim();
  if (!/^https?:\/\//i.test(url) || /\s/.test(url)) return undefined;
  return hostOf(url) === undefined ? undefined : url;
}

/** The ids of the bridges whose `linkHosts` cover `url`'s host, in the order given. */
export function bridgesForLink(infos: Iterable<Pick<BridgeInfo, "id" | "linkHosts">>, url: string): string[] {
  const host = hostOf(url);
  if (host === undefined) return [];
  const ids: string[] = [];
  for (const info of infos) {
    if (info.linkHosts && findHostRule(host, info.linkHosts) !== -1) ids.push(info.id);
  }
  return ids;
}

/**
 * Resolve a link against the installed bridges. Each bridge that covers the host is asked in turn;
 * the first to recognize the link wins. A bridge that throws doesn't stop the others — but if none
 * recognizes the link, the first error is rethrown, since "not recognized" would hide a source that
 * is down or rate-limiting.
 */
export async function resolveLink(
  infos: Iterable<Pick<BridgeInfo, "id" | "linkHosts">>,
  text: string,
  resolve: (bridgeId: string, url: string) => Promise<LinkTarget | null>,
): Promise<LinkResolution> {
  const url = normalizeLink(text);
  if (url === undefined) return { ok: false, reason: "invalid-url" };
  const candidates = bridgesForLink(infos, url);
  if (candidates.length === 0) return { ok: false, reason: "no-bridge" };
  let firstError: unknown;
  let failed = false;
  for (const bridgeId of candidates) {
    try {
      const target = await resolve(bridgeId, url);
      if (target) return { ok: true, bridgeId, target };
    } catch (e) {
      if (!failed) firstError = e;
      failed = true;
    }
  }
  if (failed) throw firstError;
  return { ok: false, reason: "not-recognized" };
}
