/**
 * Unit tests for the direct-read bridge's "ongoing only" toggle filter.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge } from "@comical/contract";
import { DirectFixtureBackend, mockHost } from "@comical/testkit";
import factory from "../src/index.ts";

function load(backend = new DirectFixtureBackend()): Bridge {
  return factory(
    mockHost({
      handle: (req) => backend.handle(req),
      settings: { baseUrl: "http://fixture.local" },
    }),
  );
}

describe("direct-example getFilters", () => {
  test("advertises an 'ongoing only' toggle", async () => {
    const bridge = load();
    const filters = await bridge.getFilters!();
    expect(filters).toEqual([{ type: "toggle", key: "ongoing", label: "Ongoing only" }]);
  });
});

describe("direct-example getListItems with the ongoing filter", () => {
  test("returns every fixture entry with no filter applied", async () => {
    const bridge = load();
    const { items } = await bridge.getListItems("all", 1);
    expect(items.length).toBe(7);
  });

  test("narrows to only ongoing works when the toggle is true", async () => {
    const bridge = load();
    const { items } = await bridge.getListItems("all", 1, {
      filters: [{ key: "ongoing", value: true }],
    });
    expect(items).toEqual([expect.objectContaining({ id: "serialized-oddities" })]);
  });

  test("returns every entry when the toggle is explicitly false", async () => {
    const bridge = load();
    const { items } = await bridge.getListItems("all", 1, {
      filters: [{ key: "ongoing", value: false }],
    });
    expect(items.length).toBe(7);
  });
});
