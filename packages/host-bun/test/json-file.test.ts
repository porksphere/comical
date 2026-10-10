/**
 * The crash-safe JSON layer every server store sits on. The property that matters most: a document
 * that can't be read is never silently treated as empty and then overwritten.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asJsonArray, deleteJsonFile, FileStorage, JsonDoc, jsonMapDoc, readJsonFile, writeJsonFile } from "../src/index.ts";

let dir: string;
const quiet = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comical-json-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const files = () => readdirSync(dir).sort();

describe("readJsonFile", () => {
  test("a missing file is the fallback, and nothing is created", async () => {
    expect(await readJsonFile(join(dir, "nope.json"), { empty: true })).toEqual({ empty: true });
    expect(files()).toEqual([]);
  });

  test("a valid file is returned as parsed", async () => {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ x: 1 }));
    expect(await readJsonFile(join(dir, "a.json"), {})).toEqual({ x: 1 });
  });

  test("a truncated file is quarantined, not read as empty-and-overwritable", async () => {
    const path = join(dir, "a.json");
    writeFileSync(path, '{"x": 1, "y"'); // a write cut off mid-document
    const logged: string[] = [];
    expect(await readJsonFile(path, {}, { log: (m) => logged.push(m) })).toEqual({});

    const [aside] = files();
    expect(aside).toMatch(/^a\.json\.corrupt-\d+$/);
    expect(readFileSync(join(dir, aside!), "utf8")).toBe('{"x": 1, "y"'); // kept for recovery
    expect(logged).toHaveLength(1);
  });

  test("a zero-byte file is corrupt too", async () => {
    writeFileSync(join(dir, "a.json"), "");
    expect(await readJsonFile(join(dir, "a.json"), [], { log: quiet })).toEqual([]);
    expect(files()[0]).toMatch(/^a\.json\.corrupt-/);
  });

  test("a document the decoder rejects is quarantined", async () => {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ not: "an array" }));
    expect(await readJsonFile(join(dir, "a.json"), [], { decode: asJsonArray, log: quiet })).toEqual([]);
    expect(files()[0]).toMatch(/^a\.json\.corrupt-/);
  });

  test("a real IO error throws instead of falling back", async () => {
    mkdirSync(join(dir, "a.json")); // reading a directory fails with something other than ENOENT
    await expect(readJsonFile(join(dir, "a.json"), {})).rejects.toThrow();
    expect(files()).toEqual(["a.json"]); // left alone
  });
});

describe("writeJsonFile", () => {
  test("writes the value, creating directories, leaving no temp files", async () => {
    await writeJsonFile(join(dir, "deep", "a.json"), { x: 1 });
    expect(JSON.parse(readFileSync(join(dir, "deep", "a.json"), "utf8"))).toEqual({ x: 1 });
    expect(readdirSync(join(dir, "deep"))).toEqual(["a.json"]);
  });

  test("overlapping writes to one path land in call order", async () => {
    const path = join(dir, "a.json");
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeJsonFile(path, { i })));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ i: 24 });
    expect(files()).toEqual(["a.json"]);
  });

  test("a failed write leaves the previous document intact and no temp file", async () => {
    const path = join(dir, "a.json");
    await writeJsonFile(path, { good: true });
    await expect(writeJsonFile(path, { bad: 1n })).rejects.toThrow(); // BigInt can't be serialized
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ good: true });
    expect(files()).toEqual(["a.json"]);
  });

  test("a delete queued after a write wins; a write queued after a delete wins", async () => {
    const path = join(dir, "a.json");
    await Promise.all([writeJsonFile(path, { a: 1 }), deleteJsonFile(path)]);
    expect(files()).toEqual([]);
    await Promise.all([deleteJsonFile(path), writeJsonFile(path, { b: 2 })]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ b: 2 });
  });
});

describe("JsonDoc", () => {
  test("concurrent first touches share one load, so no mutation is lost", async () => {
    const path = join(dir, "m.json");
    writeFileSync(path, JSON.stringify({ seed: 0 }));
    const doc = jsonMapDoc<number>(path);
    await Promise.all(Array.from({ length: 10 }, (_, i) => doc.update((m) => m.set(`k${i}`, i))));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "seed"]);
  });

  test("a replace issued while the load is in flight is not undone by the load", async () => {
    const path = join(dir, "m.json");
    writeFileSync(path, JSON.stringify({ old: 1 }));
    const doc = jsonMapDoc<number>(path);
    const loading = doc.get();
    await doc.replace(new Map());
    await loading;
    expect([...(await doc.get()).keys()]).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  test("an update after a replace mutates the replacement, not the old value", async () => {
    const doc = jsonMapDoc<number>(join(dir, "m.json"));
    await doc.update((m) => m.set("a", 1));
    await Promise.all([doc.replace(new Map()), doc.update((m) => m.set("b", 2))]);
    expect(Object.fromEntries(await doc.get())).toEqual({ b: 2 });
    expect(JSON.parse(readFileSync(join(dir, "m.json"), "utf8"))).toEqual({ b: 2 });
  });

  test("deleteWhenEmpty removes the file once the map empties, and a re-add restores it", async () => {
    const path = join(dir, "shard.json");
    const doc = jsonMapDoc<number>(path, { deleteWhenEmpty: true });
    await doc.update((m) => m.set("a", 1));
    expect(files()).toEqual(["shard.json"]);
    await doc.update((m) => m.delete("a"));
    expect(files()).toEqual([]);
    await Promise.all([doc.update((m) => m.set("b", 2)), doc.update((m) => m.delete("b")), doc.update((m) => m.set("c", 3))]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ c: 3 });
  });

  test("a corrupt document starts empty and the next write does not destroy the original", async () => {
    const path = join(dir, "m.json");
    writeFileSync(path, "{ definitely not json");
    const doc = jsonMapDoc<number>(path, { log: quiet });
    await doc.update((m) => m.set("fresh", 1));

    const aside = files().find((f) => f.includes(".corrupt-"))!;
    expect(readFileSync(join(dir, aside), "utf8")).toBe("{ definitely not json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ fresh: 1 });
  });

  test("a failed load is not cached; the next call retries", async () => {
    const path = join(dir, "m.json");
    mkdirSync(path);
    const doc = new JsonDoc<number[]>(path, { empty: () => [] });
    await expect(doc.get()).rejects.toThrow();
    rmSync(path, { recursive: true });
    writeFileSync(path, "[1,2]");
    expect(await doc.get()).toEqual([1, 2]);
  });
});

describe("FileStorage", () => {
  test("a corrupt storage file is quarantined rather than wiped by the next set", async () => {
    const storageDir = join(dir, "storage");
    mkdirSync(storageDir);
    writeFileSync(join(storageDir, "b.json"), '{"token": "abc"'); // truncated
    const store = new FileStorage(dir, "b");
    const warn = console.warn;
    console.warn = quiet;
    try {
      expect(await store.get("token")).toBeUndefined();
      await store.set("etag", "1");
    } finally {
      console.warn = warn;
    }
    const names = readdirSync(storageDir);
    expect(names.some((n) => n.startsWith("b.json.corrupt-"))).toBe(true);
    expect(JSON.parse(readFileSync(join(storageDir, "b.json"), "utf8"))).toEqual({ etag: "1" });
  });
});
