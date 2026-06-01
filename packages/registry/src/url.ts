/**
 * Registry URL resolution.
 *
 * Accepts any of:
 *   github.com/user/repo              → raw.githubusercontent.com/user/repo/main/index.json
 *   https://github.com/user/repo      → same
 *   https://user.github.io/repo/      → https://user.github.io/repo/index.json
 *   https://any-static-host/path/     → https://any-static-host/path/index.json
 *   https://any-static-host/index.json → used as-is
 *
 * The resolved URL is what gets stored in the manifest and used for all future fetches.
 */

const GITHUB_REPO = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/?#]+)/;

export function resolveRegistryUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");

  // github.com/user/repo → raw content
  const ghMatch = GITHUB_REPO.exec(trimmed);
  if (ghMatch) {
    const [, owner, repo] = ghMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/index.json`;
  }

  // Ensure it has a protocol.
  const withProtocol = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;

  // Already ends in .json → use as-is.
  if (withProtocol.endsWith(".json")) return withProtocol;

  // Otherwise append /index.json.
  return `${withProtocol}/index.json`;
}

/** Extract a human-readable registry name from a URL. */
export function registryDisplayName(resolvedUrl: string): string {
  try {
    const url = new URL(resolvedUrl);
    // raw.githubusercontent.com/owner/repo/... → owner/repo
    if (url.hostname === "raw.githubusercontent.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
    return url.hostname;
  } catch {
    return resolvedUrl;
  }
}
