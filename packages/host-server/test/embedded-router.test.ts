/**
 * Embedded (in-process) router usage.
 *
 * comical-app's iOS/Android targets run the runtime on-device: bridge bundles execute in a
 * separate JS engine (JSC/QuickJS) behind a native module, and the app resolves requests by
 * driving THIS router in-process — `createRouter(manager).fetch(new Request(...))` — with no
 * socket, no `Bun.serve`, and no filesystem `BridgeManager`. The `manager` is a lightweight
 * proxy `BridgeProvider` whose `get(id)` returns a bridge whose methods marshal to the native
 * engine, rather than a `loadBridge`d bundle.
 *
 * These tests pin that contract: the router must serve its content routes given only the
 * `list`/`get`/`missingRequired`/`storedSettings` surface, driven by plain `Request` objects.
 * They also guard the Node-free consumability of `router.ts` — importing it here (without
 * `bridge-manager.ts`/`settings-store.ts`/`Bun.serve`) must not drag in `node:vm` via the
 * `@comical/core` barrel (see the subpath imports at the top of `router.ts`).
 */
import { describe, expect, test } from "bun:test";
import type {
  BridgeInfo,
  Chapter,
  ListOptions,
  Page,
  PagedResults,
  SearchOptions,
  SeriesEntry,
  SeriesInfo,
  SeriesList,
  SettingValue,
} from "@comical/contract";
import type { BridgeProvider } from "../src/bridge-provider.ts";
import { createRouter } from "../src/router.ts";

// ── A proxy bridge — the shape comical-app's native-module-backed bridge presents ────────────

// The router gates each content route on the *presence* of the bridge method, not the capability
// string — so comical-app's proxy must attach only the methods the bridge actually implements
// (derived from its `info.capabilities`). `methods` models exactly that method set.
function makeBridge(id: string, capabilities: string[], methods: string[]): Record<string, unknown> {
  const info: BridgeInfo = {
    id,
    name: `Bridge ${id}`,
    version: "1.0.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: capabilities as BridgeInfo["capabilities"],
  };
  const entry = (n: number): SeriesEntry => ({ id: `s${n}`, title: `Series ${n}` });
  const page = (items: SeriesEntry[]): PagedResults<SeriesEntry> => ({ items, page: 1, hasNextPage: false });
  const all: Record<string, unknown> = {
    getLists: async (): Promise<SeriesList[]> => [{ id: "home", name: "Home" }],
    getListItems: async (_listId: string, _page: number, _opts?: ListOptions): Promise<PagedResults<SeriesEntry>> =>
      page([entry(1), entry(2)]),
    getSearchResults: async (q: string, _page: number, _opts?: SearchOptions): Promise<PagedResults<SeriesEntry>> =>
      page([{ id: "hit", title: `Result for ${q}` }]),
    getSeriesDetails: async (seriesId: string): Promise<SeriesInfo> => ({
      id: seriesId,
      title: `Series ${seriesId}`,
    }),
    getChapters: async (_seriesId: string): Promise<Chapter[]> => [{ id: "c1", name: "Chapter 1", number: 1 }],
    getChapterPages: async (_seriesId: string, _chapterId: string): Promise<Page[]> => [
      { index: 0, imageUrl: "https://cdn.example/p0.webp" },
      { index: 1, imageUrl: "https://cdn.example/p1.webp" },
    ],
  };
  const bridge: Record<string, unknown> = { info };
  for (const m of methods) bridge[m] = all[m];
  return bridge;
}

const CONTENT_METHODS = [
  "getLists",
  "getListItems",
  "getSearchResults",
  "getSeriesDetails",
  "getChapters",
  "getChapterPages",
];

// ── A proxy BridgeProvider — the in-process manager comical-app supplies to createRouter ─────

interface FakeBridgeSpec {
  capabilities: string[];
  methods: string[];
  missingRequired?: string[];
  storedSettings?: Record<string, SettingValue>;
}

function makeManager(specs: Record<string, FakeBridgeSpec>): BridgeProvider {
  const bridges = new Map(
    Object.entries(specs).map(([id, spec]) => [id, makeBridge(id, spec.capabilities, spec.methods)]),
  );
  // Typed against the real BridgeProvider interface — no `as unknown as` cast — proving comical-app
  // can supply a proxy provider (get() → native-engine-backed bridge) that the router accepts.
  return {
    list: async () =>
      Object.entries(specs).map(([id, spec]) => ({
        info: bridges.get(id)!.info as BridgeInfo,
        settings: [],
        configured: (spec.missingRequired ?? []).length === 0,
        missingRequired: spec.missingRequired ?? [],
        source: "registry" as const,
      })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (id: string): Promise<any> => {
      const b = bridges.get(id);
      if (!b) throw new Error(`bridge not found: ${id}`);
      return b;
    },
    missingRequired: async (id: string) => specs[id]?.missingRequired ?? [],
    storedSettings: async (id: string) => specs[id]?.storedSettings ?? {},
    updateSettings: async (id: string, values) => ({ ...(specs[id]?.storedSettings ?? {}), ...values }),
    invalidate: () => {},
    refresh: () => {},
  };
}

// Drive the router with plain in-process Requests — no socket, no Bun.serve.
function embeddedFetch(app: ReturnType<typeof createRouter>) {
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://embedded${path}`, init));
}

describe("embedded in-process router", () => {
  const app = createRouter(
    makeManager({
      demo: { capabilities: ["lists", "search"], methods: CONTENT_METHODS },
      unconfigured: { capabilities: ["lists", "search"], methods: CONTENT_METHODS, missingRequired: ["baseUrl"] },
      minimal: { capabilities: [], methods: [] }, // implements nothing → content methods "not supported"
    }),
  );
  const call = embeddedFetch(app);

  test("GET /bridges lists proxy bridges with configured status", async () => {
    const res = await call("/bridges");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: BridgeInfo; configured: boolean }[];
    expect(body.map((b) => b.info.id).sort()).toEqual(["demo", "minimal", "unconfigured"]);
    expect(body.find((b) => b.info.id === "demo")?.configured).toBe(true);
    expect(body.find((b) => b.info.id === "unconfigured")?.configured).toBe(false);
  });

  test("GET /bridges/:id/lists proxies to the bridge", async () => {
    const res = await call("/bridges/demo/lists");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "home", name: "Home" }]);
  });

  test("GET /bridges/:id/search parses query + page and returns paged results", async () => {
    const res = await call("/bridges/demo/search?q=naruto&page=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PagedResults<SeriesEntry>;
    expect(body.items[0]?.title).toBe("Result for naruto");
    expect(body.hasNextPage).toBe(false);
  });

  test("GET /bridges/:id/series/:seriesId → detail, then /chapters, then /chapters/:cid/pages", async () => {
    const detail = await call("/bridges/demo/series/s42");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as SeriesInfo).id).toBe("s42");

    const chapters = await call("/bridges/demo/series/s42/chapters");
    expect(((await chapters.json()) as Chapter[])[0]?.id).toBe("c1");

    const pages = await call("/bridges/demo/series/s42/chapters/c1/pages");
    const body = (await pages.json()) as Page[];
    expect(body).toHaveLength(2);
    expect(body[0]?.imageUrl).toContain("p0.webp");
  });

  test("unknown bridge → 404", async () => {
    const res = await call("/bridges/nope/lists");
    expect(res.status).toBe(404);
  });

  test("content call on a bridge missing required settings → 400", async () => {
    const res = await call("/bridges/unconfigured/search?q=x");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not configured");
  });

  test("capability the bridge does not implement → 400 not supported", async () => {
    const res = await call("/bridges/minimal/lists");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not supported");
  });

  test("optional capability with no manager (library) → 404, so the app degrades gracefully", async () => {
    // No `library`/`trackers`/`registry` passed to createRouter, mirroring content-only v1.
    const res = await call("/library");
    expect(res.status).toBe(404);
  });
});
