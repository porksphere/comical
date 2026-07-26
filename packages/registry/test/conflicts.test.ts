/**
 * `assertInstallableFrom` — the guard that stops one registry's install from silently overwriting
 * another's record for the same id. Both runtimes key installs by bare id and upsert on write, so
 * without this an id collision (honest or squatted) swaps out the bundle URL, sha256 and signing key
 * under everything the user has saved against that id.
 */
import { describe, expect, test } from "bun:test";
import { InstallConflictError, assertInstallableFrom } from "../src/conflicts.ts";

const A = "https://a.example/index.json";
const B = "https://b.example/index.json";

describe("assertInstallableFrom", () => {
  test("allows a first install (nothing held under the id)", () => {
    expect(() => assertInstallableFrom("bridge", "x", A, null)).not.toThrow();
    expect(() => assertInstallableFrom("bridge", "x", A, undefined)).not.toThrow();
  });

  test("allows a re-pin/update from the same registry", () => {
    // The update path: `update()` reinstalls from the record's own registryUrl, and a followed
    // registry move repoints records before any install runs — both must keep working.
    expect(() => assertInstallableFrom("bridge", "x", A, { registryUrl: A })).not.toThrow();
  });

  test("refuses an install of an id held by a different registry", () => {
    expect(() => assertInstallableFrom("bridge", "x", B, { registryUrl: A })).toThrow(InstallConflictError);
    // The message has to name both sides — which registry holds it is the whole decision the user
    // is being asked to make.
    expect(() => assertInstallableFrom("bridge", "x", B, { registryUrl: A })).toThrow(
      new RegExp(`bridge "x".*${A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });

  test("refuses an install over a locally built bridge", () => {
    // registryUrl null = built locally. Overwriting it from a registry is the same silent swap.
    expect(() => assertInstallableFrom("bridge", "x", A, { registryUrl: null })).toThrow(InstallConflictError);
    expect(() => assertInstallableFrom("bridge", "x", A, { registryUrl: null })).toThrow(/installed locally/);
  });

  test("names the kind, so a tracker conflict doesn't read as a bridge one", () => {
    expect(() => assertInstallableFrom("tracker", "t", B, { registryUrl: A })).toThrow(/tracker "t"/);
  });

  test("is exact about URLs — a near-miss is still a different registry", () => {
    expect(() => assertInstallableFrom("bridge", "x", `${A}?v=2`, { registryUrl: A })).toThrow(InstallConflictError);
  });
});
