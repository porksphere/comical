/**
 * The version of the bridge contract this build of the runtime implements.
 *
 * A bridge declares the contract version it targets in `BridgeInfo.contractVersion`.
 * The runtime accepts a bridge when their major versions match (semver): a major bump
 * signals a breaking change to the interfaces/models in this package.
 */
export const CONTRACT_VERSION = "1.0.0";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a strict `x.y.z` semver. Returns `undefined` for anything malformed. */
export function parseSemver(version: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Is a bridge targeting `bridgeContractVersion` compatible with this runtime?
 * Compatible = same major version, and the bridge's (minor,patch) is not newer than
 * the runtime's within that major (the runtime can't promise features it predates).
 */
export function isContractCompatible(
  bridgeContractVersion: string,
  runtimeVersion: string = CONTRACT_VERSION,
): boolean {
  const bridge = parseSemver(bridgeContractVersion);
  const runtime = parseSemver(runtimeVersion);
  if (!bridge || !runtime) return false;
  if (bridge.major !== runtime.major) return false;
  if (bridge.minor > runtime.minor) return false;
  if (bridge.minor === runtime.minor && bridge.patch > runtime.patch) return false;
  return true;
}
