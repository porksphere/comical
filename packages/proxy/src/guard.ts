/**
 * SSRF protection: block forwarding requests to private/loopback/link-local addresses.
 * This prevents a malicious bridge from using the proxy as a pivot into private infrastructure.
 */

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,     // link-local
  /^::1$/,           // IPv6 loopback
  /^fc00:/i,         // IPv6 unique local
  /^fe80:/i,         // IPv6 link-local
];

const BLOCKED_SCHEMES = new Set(["file:", "data:", "javascript:", "ftp:"]);

export class ProxyGuardError extends Error {
  override readonly name = "ProxyGuardError";
}

/**
 * Throw if `rawUrl` should not be forwarded.
 * @param allowedHosts Hostnames exempt from the private-range check (testing only).
 */
export function assertAllowed(rawUrl: string, allowedHosts: Set<string> = new Set()): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProxyGuardError(`invalid URL: ${rawUrl}`);
  }

  if (BLOCKED_SCHEMES.has(url.protocol)) {
    throw new ProxyGuardError(`scheme not allowed: ${url.protocol}`);
  }

  const host = url.hostname;
  if (allowedHosts.has(host)) return url;

  if (host === "localhost" || host === "0.0.0.0") {
    throw new ProxyGuardError("requests to localhost are not allowed");
  }
  for (const re of PRIVATE_RANGES) {
    if (re.test(host)) {
      throw new ProxyGuardError(`requests to private addresses are not allowed (${host})`);
    }
  }

  return url;
}
