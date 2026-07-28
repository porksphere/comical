/**
 * `registry publish --tombstone` — the forwarding index left behind at a URL a registry moved away
 * from. Driven through the real CLI process, because what's under test is the flag wiring: a
 * tombstone must publish the `movedTo` note and *nothing else*, with no `--base-url` and without
 * sweeping up the monorepo's own bridges (which the default `--bridges-dir` would otherwise do).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { registryIndexSchema } from "@comical/registry";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const NEW_HOME = "https://example.test/new-home/index.json";

const tmp = mkdtempSync(join(tmpdir(), "comical-tombstone-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Run the CLI and capture its outcome. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("registry publish --tombstone", () => {
  test("emits a valid forwarding index with no bridges and no bundles", async () => {
    const out = join(tmp, "moved-away");
    const { code, stdout } = await cli("registry", "publish", "--tombstone", "--moved-to", NEW_HOME, "--out", out);
    expect(code).toBe(0);
    expect(stdout).toContain("Tombstone");

    const raw = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as unknown;
    // It must be a *valid* registry index — clients parse it with this schema before following it.
    const index = registryIndexSchema.parse(raw);
    expect(index.movedTo).toBe(NEW_HOME);
    expect(index.bridges).toEqual([]);
    expect(index.trackers).toBeUndefined();

    // Nothing but the index — no bundle tree was copied out.
    expect(existsSync(join(out, "bridges"))).toBe(false);
    expect(existsSync(join(out, "trackers"))).toBe(false);
  });

  test("does not pick up the monorepo's bridges despite no --bridges-dir", async () => {
    // Without --bridges-dir a normal publish falls back to this repo's bridges/. A tombstone must
    // not: it would republish unrelated bundles under a URL that is supposed to be going away.
    const out = join(tmp, "no-default-bridges");
    await cli("registry", "publish", "--tombstone", "--moved-to", NEW_HOME, "--out", out);
    const index = registryIndexSchema.parse(JSON.parse(await readFile(join(out, "index.json"), "utf8")));
    expect(index.bridges).toHaveLength(0);
  });

  test("ignores --bridges-dir and --trackers-dir when tombstoning", async () => {
    const out = join(tmp, "explicit-dirs-ignored");
    const bridgesDir = join(import.meta.dir, "..", "..", "..", "bridges");
    const { code } = await cli(
      "registry", "publish", "--tombstone", "--moved-to", NEW_HOME,
      "--out", out, "--bridges-dir", bridgesDir,
    );
    expect(code).toBe(0);
    const index = registryIndexSchema.parse(JSON.parse(await readFile(join(out, "index.json"), "utf8")));
    expect(index.bridges).toEqual([]);
    expect(existsSync(join(out, "bridges"))).toBe(false);
  });

  test("carries displayName and movedFrom through, for a registry that both moved and succeeded another", async () => {
    const out = join(tmp, "with-metadata");
    const previous = "https://example.test/older/index.json";
    const { code } = await cli(
      "registry", "publish", "--tombstone", "--moved-to", NEW_HOME, "--out", out,
      "--display-name", "SFW", "--moved-from", previous,
    );
    expect(code).toBe(0);
    const index = registryIndexSchema.parse(JSON.parse(await readFile(join(out, "index.json"), "utf8")));
    expect(index.displayName).toBe("SFW");
    expect(index.movedFrom).toEqual([previous]);
    expect(index.movedTo).toBe(NEW_HOME);
  });

  test("signing a tombstone carries the publicKey, which is what makes the move follow silently", async () => {
    // `resolveIndex` checks key continuity against the index carrying `movedTo` — the tombstone
    // itself — so an unsigned one strands clients on a manual confirm. Sign it with the same key.
    const keyFile = join(tmp, "key.json");
    expect((await cli("registry", "keygen", "--out", keyFile)).code).toBe(0);

    const out = join(tmp, "signed");
    const { code, stdout, stderr } = await cli(
      "registry", "publish", "--tombstone", "--moved-to", NEW_HOME, "--out", out, "--key", keyFile,
    );
    expect(code).toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("Unsigned tombstone");

    const index = registryIndexSchema.parse(JSON.parse(await readFile(join(out, "index.json"), "utf8")));
    const { publicKey } = JSON.parse(await readFile(keyFile, "utf8")) as { publicKey: string };
    expect(index.publicKey).toBe(publicKey);
  });

  test("warns when a tombstone is published unsigned", async () => {
    const { code, stdout, stderr } = await cli(
      "registry", "publish", "--tombstone", "--moved-to", NEW_HOME, "--out", join(tmp, "unsigned"),
    );
    expect(code).toBe(0); // an unsigned tombstone is legal, just weaker
    expect(`${stdout}${stderr}`).toContain("Unsigned tombstone");
  });

  test("refuses a tombstone with nowhere to forward", async () => {
    const { code, stderr } = await cli("registry", "publish", "--tombstone", "--out", join(tmp, "nowhere"));
    expect(code).not.toBe(0);
    expect(stderr).toContain("--moved-to");
  });

  test("still requires --base-url for a normal (non-tombstone) publish", async () => {
    const { code, stderr } = await cli("registry", "publish", "--out", join(tmp, "normal"));
    expect(code).not.toBe(0);
    expect(stderr).toContain("base-url");
  });
});
