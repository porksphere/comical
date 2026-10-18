/**
 * ManifestStore persistence. Losing this file forgets every saved registry and every install, so a
 * manifest that can't be read must never be quietly replaced by an empty one.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ManifestStore } from "../src/node.ts";

const DIR = join(import.meta.dir, ".tmp-manifest");
const PATH = join(DIR, "registry-manifest.json");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

describe("ManifestStore", () => {
  test("a truncated manifest is quarantined and survives the next write", async () => {
    const original = '{"registries":[{"url":"https://example.test/index.json","name":"x","requireSignature":false}],"installed":[';
    writeFileSync(PATH, original);
    const store = new ManifestStore(DIR);
    expect(await silenced(() => store.allRegistries())).toEqual([]);
    await store.addRegistry({ url: "https://other.test/index.json", name: "o", requireSignature: false });

    const aside = readdirSync(DIR).find((f) => f.startsWith("registry-manifest.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(DIR, aside!), "utf8")).toBe(original);
  });

  test("a manifest that fails the schema is quarantined too", async () => {
    writeFileSync(PATH, JSON.stringify({ registries: "nope" }));
    expect(await silenced(() => new ManifestStore(DIR).allInstalled())).toEqual([]);
    expect(readdirSync(DIR).some((f) => f.startsWith("registry-manifest.json.corrupt-"))).toBe(true);
  });

  test("an unreadable manifest throws instead of reading as empty", async () => {
    mkdirSync(PATH);
    await expect(new ManifestStore(DIR).allRegistries()).rejects.toThrow();
  });

  test("concurrent first calls share one load, so both writes land", async () => {
    const store = new ManifestStore(DIR);
    await Promise.all([
      store.addRegistry({ url: "https://a.test/index.json", name: "a", requireSignature: false }),
      store.addRegistry({ url: "https://b.test/index.json", name: "b", requireSignature: false }),
    ]);
    const urls = (await new ManifestStore(DIR).allRegistries()).map((r) => r.url).sort();
    expect(urls).toEqual(["https://a.test/index.json", "https://b.test/index.json"]);
  });
});
