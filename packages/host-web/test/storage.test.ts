import { describe, expect, test } from "bun:test";
import { WebMemoryStorage } from "../src/storage.ts";

describe("WebMemoryStorage", () => {
  test("get/set/delete/keys round-trip", async () => {
    const s = new WebMemoryStorage();
    await s.set("a", "1");
    await s.set("b", "2");
    expect(await s.get("a")).toBe("1");
    expect(await s.keys()).toEqual(["a", "b"]);
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
    expect(await s.keys()).toEqual(["b"]);
  });
});
