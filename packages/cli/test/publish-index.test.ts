/**
 * `registry publish` — what a bridge's index entry says about it. Driven through the real CLI
 * process against this repo's own built bridges (`bun run build` first), because the entry is
 * assembled from the info each bundle reports once loaded.
 *
 * The index is all an on-device client lists its installed bridges from, so a display flag the
 * publish leaves out is one that client never learns, whatever the bundle declares.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { registryIndexSchema } from "@comical/registry";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");

const tmp = mkdtempSync(join(tmpdir(), "comical-publish-index-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("registry publish", () => {
  test("mirrors a bridge's display flags into its entry, and only where it declares them", async () => {
    const out = join(tmp, "out");
    const proc = Bun.spawn(
      ["bun", "run", CLI, "registry", "publish", "--base-url", "https://example.test/reg", "--bridges-dir", BRIDGES_DIR, "--out", out],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const index = registryIndexSchema.parse(JSON.parse(await readFile(join(out, "index.json"), "utf8")));
    const byId = new Map(index.bridges.map((b) => [b.id, b]));

    // The example bridge declares both; the direct one declares neither.
    expect(byId.get("example")?.cardSubtitles).toBe(true);
    expect(byId.get("example")?.ratings).toBe(true);
    const direct = byId.get("direct-example");
    expect(direct).toBeDefined();
    expect("cardSubtitles" in direct!).toBe(false);
    expect("ratings" in direct!).toBe(false);
  });
});
