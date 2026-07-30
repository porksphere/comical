/**
 * Integration tests for per-bridge max content rating (capability "content-rating"):
 *   - `PUT /bridges/:id/max-content-rating` — set/clear the reserved ceiling, validation, 404.
 *   - `redactByContentRating` — entries above the ceiling get redacted on search/list/favorites,
 *     entries at-or-below or unrated pass through, and the whole thing is a no-op for a bridge that
 *     doesn't advertise "content-rating" or has no ceiling configured.
 *
 * Uses a fully mocked `BridgeProvider` (no real bundle loading, no FixtureBackend) since the
 * behaviour under test is purely host-side redaction over whatever `contentRating` a bridge's
 * entries already carry — see `router.ts`'s `redactByContentRating` doc comment.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BridgeInfo, ContentRating, SeriesEntry, SettingValue } from "@comical/contract";
import type { BridgeProvider, BridgeSummary } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

type FakeEntry = SeriesEntry & { contentRating?: ContentRating };

const RATED_ITEMS: FakeEntry[] = [
  { id: "e1", title: "Everyone One", contentRating: "everyone", thumbnailUrl: "http://x/e1.png", badges: [{ text: "EN" }] },
  { id: "m1", title: "Mature One", contentRating: "mature", thumbnailUrl: "http://x/m1.png", badges: [{ text: "EN" }] },
  { id: "a1", title: "Adult One", contentRating: "adult", thumbnailUrl: "http://x/a1.png", badges: [{ text: "EN" }] },
  { id: "u1", title: "Unrated One", thumbnailUrl: "http://x/u1.png" },
];

function fakeBridge(id: string, capabilities: string[], items: FakeEntry[]) {
  const info: BridgeInfo = {
    id,
    name: id,
    version: "1.0.0",
    contractVersion: "2.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: capabilities as BridgeInfo["capabilities"],
  };
  const clone = (): FakeEntry[] => items.map((i) => ({ ...i, badges: i.badges ? [...i.badges] : undefined }));
  return {
    info,
    getSettings: () => [],
    getSearchResults: async () => ({ items: clone() }),
    getListItems: async () => ({ items: clone() }),
    getFavorites: async () => ({ items: clone() }),
  };
}

/** A minimal in-memory `BridgeProvider` — no bundle loading, no disk. */
class MockManager implements BridgeProvider {
  private readonly bridges = new Map<string, ReturnType<typeof fakeBridge>>();
  private readonly stored = new Map<string, Record<string, SettingValue>>();

  add(bridge: ReturnType<typeof fakeBridge>): void {
    this.bridges.set(bridge.info.id, bridge);
  }

  async list(): Promise<BridgeSummary[]> {
    return [...this.bridges.values()].map((b) => ({
      info: b.info,
      settings: [],
      configured: true,
      missingRequired: [],
      source: "local",
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get(id: string): Promise<any> {
    const b = this.bridges.get(id);
    if (!b) throw new Error(`bridge not found: ${id}`);
    return b;
  }

  async missingRequired(): Promise<string[]> {
    return [];
  }

  async storedSettings(id: string): Promise<Record<string, SettingValue>> {
    return { ...(this.stored.get(id) ?? {}) };
  }

  async updateSettings(id: string, patch: Record<string, SettingValue>): Promise<Record<string, SettingValue>> {
    const merged = { ...(this.stored.get(id) ?? {}), ...patch };
    this.stored.set(id, merged);
    return { ...merged };
  }

  invalidate(): void {}
  refresh(): void {}
}

let baseUrl: string;
let stop: () => void;
let manager: MockManager;

async function setMaxRating(bridgeId: string, rating: ContentRating | null): Promise<Response> {
  return fetch(`${baseUrl}/bridges/${bridgeId}/max-content-rating`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
}

type ItemsBody = { items: Array<{ id: string; title: string; excluded?: boolean; thumbnailUrl?: string; badges?: unknown[] }> };
async function searchItems(bridgeId: string): Promise<ItemsBody["items"]> {
  const data = (await fetch(`${baseUrl}/bridges/${bridgeId}/search?q=`).then((r) => r.json())) as ItemsBody;
  return data.items;
}
async function listItems(bridgeId: string): Promise<ItemsBody["items"]> {
  const data = (await fetch(`${baseUrl}/bridges/${bridgeId}/lists/all`).then((r) => r.json())) as ItemsBody;
  return data.items;
}
async function favoriteItems(bridgeId: string): Promise<ItemsBody["items"]> {
  const data = (await fetch(`${baseUrl}/bridges/${bridgeId}/favorites`).then((r) => r.json())) as ItemsBody;
  return data.items;
}

beforeAll(() => {
  manager = new MockManager();
  manager.add(fakeBridge("rated", ["search", "lists", "favorites", "content-rating"], RATED_ITEMS));
  manager.add(fakeBridge("unrated-bridge", ["search", "lists", "favorites"], RATED_ITEMS));

  const srv = Bun.serve({ port: 0, fetch: createRouter(manager as unknown as BridgeProvider).fetch });
  baseUrl = `http://localhost:${srv.port}`;
  stop = () => srv.stop(true);
});

afterAll(() => stop());

describe("PUT /bridges/:id/max-content-rating", () => {
  test("sets and round-trips in bridge detail, excluded from generic values", async () => {
    const res = await setMaxRating("rated", "mature");
    expect(res.status).toBe(200);
    expect((await res.json() as { maxContentRating: string }).maxContentRating).toBe("mature");

    type DetailBody = { maxContentRating: string | null; values: Record<string, unknown> };
    const detail = (await fetch(`${baseUrl}/bridges/rated`).then((r) => r.json())) as DetailBody;
    expect(detail.maxContentRating).toBe("mature");
    expect(detail.values).not.toHaveProperty("maxContentRating");

    await setMaxRating("rated", null); // reset for other tests
  });

  test("null clears the ceiling", async () => {
    await setMaxRating("rated", "adult");
    const cleared = await setMaxRating("rated", null);
    expect((await cleared.json() as { maxContentRating: string | null }).maxContentRating).toBeNull();

    const detail = (await fetch(`${baseUrl}/bridges/rated`).then((r) => r.json())) as { maxContentRating: string | null };
    expect(detail.maxContentRating).toBeNull();
  });

  test("400 on an invalid rating value", async () => {
    const res = await fetch(`${baseUrl}/bridges/rated/max-content-rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "explicit" }),
    });
    expect(res.status).toBe(400);
  });

  test("404 for an unknown bridge", async () => {
    const res = await setMaxRating("nonexistent", "mature");
    expect(res.status).toBe(404);
  });
});

describe("redaction on a capable bridge (rated)", () => {
  test("entries above the ceiling are redacted; at-or-below and unrated pass through", async () => {
    await setMaxRating("rated", "mature");
    for (const items of [await searchItems("rated"), await listItems("rated"), await favoriteItems("rated")]) {
      const byId = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(byId.e1?.excluded).toBeFalsy();
      expect(byId.e1?.title).toBe("Everyone One");
      expect(byId.m1?.excluded).toBeFalsy();
      expect(byId.m1?.title).toBe("Mature One");
      expect(byId.u1?.excluded).toBeFalsy();
      expect(byId.u1?.title).toBe("Unrated One");

      expect(byId.a1?.excluded).toBe(true);
      expect(byId.a1?.title).toBe("Hidden");
      expect(byId.a1?.thumbnailUrl).toBeUndefined();
      expect(byId.a1?.badges).toBeUndefined();
    }
    await setMaxRating("rated", null);
  });

  test("no ceiling configured is a no-op", async () => {
    await setMaxRating("rated", null);
    const items = await searchItems("rated");
    expect(items.find((i) => i.id === "a1")?.excluded).toBeFalsy();
  });
});

describe("inert on a non-capable bridge (unrated-bridge)", () => {
  test("a stored ceiling never redacts results", async () => {
    const detail = (await fetch(`${baseUrl}/bridges/unrated-bridge`).then((r) => r.json())) as {
      info: { capabilities?: string[] };
    };
    expect(detail.info.capabilities).not.toContain("content-rating");

    await setMaxRating("unrated-bridge", "everyone");
    const items = await searchItems("unrated-bridge");
    expect(items.find((i) => i.id === "a1")?.excluded).toBeFalsy();
    expect(items.find((i) => i.id === "a1")?.title).toBe("Adult One");

    await setMaxRating("unrated-bridge", null);
  });
});
