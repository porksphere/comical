import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore } from "../src/blob-store.ts";

const dirs: string[] = [];
async function store(): Promise<FileBlobStore> {
  const dir = await mkdtemp(join(tmpdir(), "comical-blobs-"));
  dirs.push(dir);
  return new FileBlobStore(join(dir, "blobs"));
}

afterEach(async () => {
  setSystemTime();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("FileBlobStore.usage", () => {
  test("is 0 before anything was written", async () => {
    expect(await (await store()).usage()).toBe(0);
  });

  test("callers arriving during a walk share it", async () => {
    const blobs = await store();
    await blobs.write("s/c/0.jpg", new Uint8Array(100));
    const calls = Array.from({ length: 20 }, () => blobs.usage());
    expect(new Set(calls).size).toBe(1);
    expect(await calls[0]).toBe(100);
  });

  test("a write inside the TTL is reported once it lapses", async () => {
    const blobs = await store();
    await blobs.write("s/c/0.jpg", new Uint8Array(100));
    expect(await blobs.usage()).toBe(100);
    await blobs.write("s/c/1.jpg", new Uint8Array(50));
    expect(await blobs.usage()).toBe(100);
    setSystemTime(new Date(Date.now() + 5_000));
    expect(await blobs.usage()).toBe(150);
  });

  test("a delete is reported immediately", async () => {
    const blobs = await store();
    await blobs.write("s/c/0.jpg", new Uint8Array(100));
    await blobs.write("s/c/1.jpg", new Uint8Array(50));
    expect(await blobs.usage()).toBe(150);
    await blobs.remove(["s/c/1.jpg"]);
    expect(await blobs.usage()).toBe(100);
    await blobs.removeAll();
    expect(await blobs.usage()).toBe(0);
  });

  test("a walk that started before a delete isn't served after it", async () => {
    const blobs = await store();
    await blobs.write("s/c/0.jpg", new Uint8Array(100));
    const before = blobs.usage();
    await blobs.remove(["s/c/0.jpg"]);
    await before;
    expect(await blobs.usage()).toBe(0);
  });
});
