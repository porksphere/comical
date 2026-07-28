/**
 * The shared contract-compatibility guard. The rule itself lives in `@comical/contract`
 * (`isContractCompatible`) and governs what the loaders accept; what's tested here is that the
 * registry layer applies exactly that rule *before* a download, and that the refusal tells the user
 * which side is behind — the two directions have different fixes and only one of them is theirs.
 */
import { describe, expect, test } from "bun:test";
import { ContractIncompatibleError, assertContractCompatible, isEntryCompatible } from "../src/compat.ts";

const RUNTIME = "1.4.2";

describe("isEntryCompatible", () => {
  test("accepts an exact match and anything older within the major", () => {
    for (const v of ["1.4.2", "1.4.1", "1.3.9", "1.0.0"]) {
      expect(isEntryCompatible(v, RUNTIME)).toBe(true);
    }
  });

  test("rejects a newer minor or patch — the runtime can't promise features it predates", () => {
    expect(isEntryCompatible("1.5.0", RUNTIME)).toBe(false);
    expect(isEntryCompatible("1.4.3", RUNTIME)).toBe(false);
  });

  test("rejects either direction across a major — that's what a major bump means", () => {
    expect(isEntryCompatible("2.0.0", RUNTIME)).toBe(false);
    expect(isEntryCompatible("0.9.0", RUNTIME)).toBe(false);
  });

  test("rejects a malformed version rather than guessing at it", () => {
    for (const v of ["1.4", "v1.4.2", "1.4.2-beta", "", "latest"]) {
      expect(isEntryCompatible(v, RUNTIME)).toBe(false);
    }
  });

  test("compares numerically, not lexically (10 is newer than 9)", () => {
    expect(isEntryCompatible("1.10.0", "1.9.0")).toBe(false);
    expect(isEntryCompatible("1.9.0", "1.10.0")).toBe(true);
  });
});

describe("assertContractCompatible", () => {
  test("passes silently for a version the runtime can load", () => {
    expect(() => assertContractCompatible("bridge", "demo", "1.4.0", RUNTIME)).not.toThrow();
  });

  test("an entry ahead of the runtime tells the user to update the app", () => {
    let caught: unknown;
    try {
      assertContractCompatible("bridge", "demo", "2.0.0", RUNTIME);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContractIncompatibleError);
    const msg = (caught as Error).message;
    expect(msg).toContain('bridge "demo"');
    expect(msg).toContain("2.0.0");
    expect(msg).toContain("1.4.2"); // what this build implements, so the mismatch is legible
    expect(msg).toContain("Update the app");
  });

  test("an entry behind the runtime points at the publisher instead — the user can't fix it", () => {
    const msg = messageFor(() => assertContractCompatible("tracker", "anilist", "0.9.0", RUNTIME));
    expect(msg).toContain('tracker "anilist"');
    expect(msg).toContain("publisher needs to update it");
    expect(msg).not.toContain("Update the app");
  });

  test("a newer minor is still an 'update the app' case, not a stale-publisher one", () => {
    expect(messageFor(() => assertContractCompatible("bridge", "demo", "1.5.0", RUNTIME))).toContain("Update the app");
  });

  test("a malformed version is refused, and doesn't claim the app is behind", () => {
    const msg = messageFor(() => assertContractCompatible("bridge", "demo", "not-a-version", RUNTIME));
    expect(msg).toContain("publisher needs to update it");
  });
});

/** Run `fn`, expecting it to throw, and return the message. */
function messageFor(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}
