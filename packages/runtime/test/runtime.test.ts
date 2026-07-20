/** ComicalRuntime — auto-tracker-linking, title-search suggestions, and read-sync. */
import { describe, expect, test } from "bun:test";
import type { Bridge, BridgeInfo, Chapter, SeriesInfo, Tracker, TrackerInfo, TrackerLibraryEntry } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library } from "@comical/library";
import { ComicalRuntime, type BridgeProvider, type TrackerProvider } from "@comical/runtime";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLib() {
  return new Library(new InMemoryLibraryStore());
}

const BRIDGE_INFO: BridgeInfo = {
  id: "test",
  name: "Test",
  version: "0.0.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

const TRACKER_INFO: TrackerInfo = {
  id: "anilist",
  name: "AniList",
  version: "0.0.0",
  contractVersion: "1.0.0",
  capabilities: ["search", "status-sync"],
};

/** A minimal bridge that returns controlled series info. */
function mockBridge(info: Partial<SeriesInfo> & { id: string; title: string }): Bridge {
  return {
    info: BRIDGE_INFO,
    async getSeriesDetails() { return info; },
  };
}

/**
 * A bridge that also exposes chapters and read-state, for backgroundSync / tracker-pull tests.
 * `chapters` are returned by getChapters; `readChapters` (ids) by getReadChapters (read-sync cap).
 */
function syncBridge(opts: {
  details: Partial<SeriesInfo> & { id: string; title: string };
  chapters?: Chapter[];
  readChapters?: string[];
}): Bridge {
  return {
    info: { ...BRIDGE_INFO, capabilities: opts.readChapters ? ["read-sync"] : [] },
    async getSeriesDetails() { return opts.details; },
    async getChapters() { return opts.chapters ?? []; },
    ...(opts.readChapters && { async getReadChapters() { return opts.readChapters!; } }),
  };
}

function mockBridgeProvider(bridge: Bridge): BridgeProvider {
  return { get: async () => bridge };
}

/** A minimal tracker with controllable search results, push capture, and a pullable library list. */
function mockTracker(
  id: string,
  opts: {
    capabilities?: TrackerInfo["capabilities"];
    searchResults?: Array<{ externalId: number; title: string }>;
    updateCalls?: Array<{ externalId: string | number; chaptersRead?: number }>;
    libraryEntries?: TrackerLibraryEntry[];
  } = {},
): Tracker {
  return {
    info: { ...TRACKER_INFO, id, capabilities: opts.capabilities ?? TRACKER_INFO.capabilities },
    async search(query, page) {
      void query; void page;
      return {
        items: (opts.searchResults ?? []).map((r) => ({ externalId: r.externalId, title: r.title })),
        page: 1,
        hasNextPage: false,
      };
    },
    async updateEntry(externalId, update) {
      opts.updateCalls?.push({ externalId, ...(update.chaptersRead !== undefined && { chaptersRead: update.chaptersRead }) });
    },
    async getLibrary(page) {
      void page;
      return { items: opts.libraryEntries ?? [], page: 1, hasNextPage: false };
    },
  };
}

const ch = (id: string, number: number): Chapter => ({ id, name: `Ch ${number}`, number });

function mockTrackerProvider(trackers: Tracker[]): TrackerProvider {
  const map = new Map(trackers.map((t) => [t.info.id, t]));
  return {
    get: async (id) => {
      const t = map.get(id);
      if (!t) throw new Error(`tracker not found: ${id}`);
      return t;
    },
    list: async () => trackers.map((t) => ({ info: { id: t.info.id, capabilities: t.info.capabilities } })),
  };
}

// ── Offline metadata capture ─────────────────────────────────────────────────

describe("addToLibrary — offline metadata capture", () => {
  test("caches the full series detail and seeds the chapter list at add time", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "One Piece", description: "Pirates.", author: "Oda" },
      chapters: [ch("c1", 1), ch("c2", 2)],
    });
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    await runtime.addToLibrary("test", "s1");

    const detail = await lib.getCachedDetail("test:s1");
    expect(detail?.info.description).toBe("Pirates.");
    const chapters = await lib.getCachedChapters("test:s1");
    expect(chapters?.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("captures the detail even when the caller supplied a full snapshot (no earlier fetch)", async () => {
    const lib = makeLib();
    const bridge = syncBridge({ details: { id: "s1", title: "One Piece", description: "Pirates." } });
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    await runtime.addToLibrary("test", "s1", { title: "One Piece" });

    expect((await lib.getCachedDetail("test:s1"))?.info.description).toBe("Pirates.");
  });

  test("a failing capture never fails the add", async () => {
    const lib = makeLib();
    const bridge: Bridge = {
      info: BRIDGE_INFO,
      async getSeriesDetails() { throw new Error("source down"); },
    };
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    await runtime.addToLibrary("test", "s1", { title: "Known Title" });

    expect(await lib.isInLibrary("test:s1")).toBe(true);
    expect(await lib.getCachedDetail("test:s1")).toBeUndefined();
  });
});

// ── Auto-link via externalIds ─────────────────────────────────────────────────

describe("addToLibrary — auto-link via externalIds", () => {
  test("links tracker when bridge externalId matches loaded tracker id", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "One Piece", externalIds: { anilist: 123 } });
    const tracker = mockTracker("anilist");
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");

    const links = await lib.listTrackerLinks("test:s1");
    expect(links).toHaveLength(1);
    expect(links[0]?.trackerId).toBe("anilist");
    expect(links[0]?.externalId).toBe(123);
  });

  test("does not duplicate link on re-add", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "One Piece", externalIds: { anilist: 123 } });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist")]),
    });

    await runtime.addToLibrary("test", "s1");
    await runtime.addToLibrary("test", "s1");

    expect(await lib.listTrackerLinks("test:s1")).toHaveLength(1);
  });

  test("auto-links only the matching tracker, leaves others for suggestions", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "One Piece", externalIds: { anilist: 123 } });
    const malTracker = mockTracker("mal", { searchResults: [{ externalId: 456, title: "One Piece" }] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist"), malTracker]),
    });

    const result = await runtime.addToLibrary("test", "s1");

    // anilist was auto-linked; mal goes through search → suggestion
    const links = await lib.listTrackerLinks("test:s1");
    expect(links.map((l) => l.trackerId)).toEqual(["anilist"]);
    expect(result.trackerSuggestions).toHaveLength(1);
    expect(result.trackerSuggestions![0]!.trackerId).toBe("mal");
    expect(result.trackerSuggestions![0]!.result.externalId).toBe(456);
  });
});

// ── Title-search suggestions ─────────────────────────────────────────────────

describe("addToLibrary — title-search suggestions", () => {
  test("returns tracker suggestions when no externalIds are available", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Berserk" }); // no externalIds
    const tracker = mockTracker("anilist", { searchResults: [{ externalId: 789, title: "Berserk" }] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    const result = await runtime.addToLibrary("test", "s1");

    expect(result.trackerSuggestions).toHaveLength(1);
    expect(result.trackerSuggestions![0]!.trackerId).toBe("anilist");
    expect(result.trackerSuggestions![0]!.result.externalId).toBe(789);
    // Should NOT have auto-linked
    expect(await lib.listTrackerLinks("test:s1")).toHaveLength(0);
  });

  test("returns no suggestions when tracker search returns empty", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Obscure Title" });
    const tracker = mockTracker("anilist", { searchResults: [] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    const result = await runtime.addToLibrary("test", "s1");

    expect(result.trackerSuggestions).toBeUndefined();
  });

  test("returns no suggestions when no trackers configured", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series" });
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    const result = await runtime.addToLibrary("test", "s1");

    expect(result.trackerSuggestions).toBeUndefined();
  });
});

// ── syncEntryToTrackers ───────────────────────────────────────────────────────

describe("syncEntryToTrackers", () => {
  test("pushes chaptersRead to linked tracker after markRead", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const updateCalls: Array<{ externalId: string | number; chaptersRead?: number }> = [];
    const tracker = mockTracker("anilist", { updateCalls });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");

    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls[0]!.externalId).toBe(111);
  });

  test("does nothing when no tracker links exist", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series" }); // no externalIds, no search match
    const updateCalls: Array<{ externalId: string | number }> = [];
    const tracker = mockTracker("anilist", { searchResults: [], updateCalls: [] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");

    expect(updateCalls).toHaveLength(0);
  });

  test("pushes the highest read chapter NUMBER, not a count", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const updateCalls: Array<{ externalId: string | number; chaptersRead?: number }> = [];
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist", { updateCalls })]),
    });

    await runtime.addToLibrary("test", "s1");
    // Three chapters read, but the highest number is 2.5 — a count (3) would be wrong.
    await runtime.markReadUpTo("test", "s1", [ch("c1", 1), ch("c2", 2), ch("c2_5", 2.5)], "c2_5");

    expect(updateCalls.at(-1)!.chaptersRead).toBe(2.5);
  });
});

// ── backgroundSync — automatic, safe tracker pull ─────────────────────────────

describe("backgroundSync — tracker read-pull", () => {
  test("marks chapters read from a tracker WITHOUT moving the local resume point", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2), ch("c3", 3)],
    });
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 3 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    // User is reading locally — last local read is chapter 1.
    await runtime.markRead("test", "s1", "c1", true, "Ch 1", 1);

    const res = await runtime.backgroundSync();

    // The tracker said 3 read → c2 and c3 get reconciled in (c1 was already read locally).
    const read = new Set((await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2", "c3"]));
    expect(res.readSynced).toBe(2);
    // But the resume pointer stays on the locally-read chapter — the pull never moved it.
    const entry = await lib.getEntry("test:s1");
    expect(entry?.lastReadChapterId).toBe("c1");
    expect(await lib.getResume("test:s1")).toEqual({ chapterId: "c1", lastPage: 0 });
  });

  test("surfaces tracked series absent from the library as suggestions, never auto-adds", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series" });
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync"],
      libraryEntries: [{ externalId: 999, title: "Berserk", status: "reading", chaptersRead: 40 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    const res = await runtime.syncFromTracker("anilist");

    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]).toMatchObject({ trackerId: "anilist", externalId: 999, title: "Berserk" });
    // Nothing was silently added — a tracker entry has no bridge to read from.
    expect(await lib.getLibrary()).toHaveLength(0);
  });
});

// ── syncEntryFromTracker — scoped, manual per-entry pull ─────────────────────

describe("syncEntryFromTracker", () => {
  test("pulls a single linked entry: updates the link and reconciles read state", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2), ch("c3", 3)],
    });
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 2 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111

    const res = await runtime.syncEntryFromTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 2 });
    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link).toMatchObject({ trackerId: "anilist", status: "reading", chaptersRead: 2 });
    const read = new Set((await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2"]));
  });

  test("throws when the entry has no link for that tracker", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series" });
    const tracker = mockTracker("anilist", { capabilities: ["library-sync"] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // no externalIds on this series → no auto-link

    await expect(runtime.syncEntryFromTracker("test", "s1", "anilist")).rejects.toThrow(/no anilist link/);
  });

  test("returns updated: false when the tracker's list doesn't (yet) contain the linked entry", async () => {
    const lib = makeLib();
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } } });
    const tracker = mockTracker("anilist", { capabilities: ["library-sync"], libraryEntries: [] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111

    const res = await runtime.syncEntryFromTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: false, readSynced: 0 });
  });

  test("paginates through getLibrary until the linked entry is found", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1)],
    });
    const pages: Record<number, { items: TrackerLibraryEntry[]; hasNextPage: boolean }> = {
      1: { items: [{ externalId: 222, title: "Other", status: "reading" }], hasNextPage: true },
      2: { items: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 1 }], hasNextPage: false },
    };
    const calledPages: number[] = [];
    const tracker: Tracker = {
      info: { ...TRACKER_INFO, id: "anilist", capabilities: ["library-sync"] },
      async getLibrary(page) {
        calledPages.push(page);
        const p = pages[page]!;
        return { items: p.items, page, hasNextPage: p.hasNextPage };
      },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111

    const res = await runtime.syncEntryFromTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 1 });
    expect(calledPages).toEqual([1, 2]);
  });
});

// ── backgroundSync — re-link pass ─────────────────────────────────────────────

describe("backgroundSync — re-link", () => {
  test("links an existing entry once a matching tracker is configured", async () => {
    const lib = makeLib();
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } } });

    // Added BEFORE any tracker existed → no link, but externalIds are persisted.
    const noTrackers = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });
    await noTrackers.addToLibrary("test", "s1");
    expect(await lib.listTrackerLinks("test:s1")).toHaveLength(0);

    // A tracker is configured later; backgroundSync wires up the existing entry.
    const withTracker = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist", { capabilities: ["status-sync"] })]),
    });
    // force: add time counts as a chapter sync, so a plain call would skip this fresh entry.
    await withTracker.backgroundSync({ force: true });

    const links = await lib.listTrackerLinks(entryKey("test", "s1"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ trackerId: "anilist", externalId: 111 });
  });
});

// ── backgroundSync — resilience ───────────────────────────────────────────────

describe("backgroundSync — best-effort", () => {
  test("an unreachable bridge or failing tracker does not abort the run", async () => {
    const lib = makeLib();
    // Bridge adds fine but throws when listing chapters; tracker throws on getLibrary.
    const bridge: Bridge = {
      info: BRIDGE_INFO,
      async getSeriesDetails() { return { id: "s1", title: "Series", externalIds: { anilist: 111 } }; },
      async getChapters() { throw new Error("network down"); },
    };
    const tracker: Tracker = {
      info: { ...TRACKER_INFO, id: "anilist", capabilities: ["library-sync"] },
      async getLibrary() { throw new Error("tracker 500"); },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");

    // Should resolve cleanly despite both sources failing.
    const res = await runtime.backgroundSync();
    expect(res).toMatchObject({ updated: 0, newChapters: 0, readSynced: 0 });
    expect(res.suggestions).toEqual([]);
  });
});

// ── backgroundSync — large-library behavior (staleness, concurrency, budget) ──

/**
 * A bridge whose getChapters is instrumented: counts calls per series, tracks the max number of
 * concurrent in-flight calls, and can delay to make timing-sensitive behavior observable.
 */
function instrumentedBridge(opts: { delayMs?: number } = {}) {
  const calls = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const bridge: Bridge = {
    info: BRIDGE_INFO,
    async getSeriesDetails(id: string) { return { id, title: `Series ${id}` }; },
    async getChapters(seriesId: string) {
      calls.set(seriesId, (calls.get(seriesId) ?? 0) + 1);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      inFlight--;
      return [ch("c1", 1)];
    },
  };
  return { bridge, calls, maxInFlight: () => maxInFlight };
}

/** Seed `n` entries directly through the library so chaptersSyncedAt stays unset (= stale). */
async function seedStaleEntries(lib: Library, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await lib.addSeries({ bridgeId: "test", seriesId: `s${i}`, title: `Series ${i}` });
  }
}

describe("backgroundSync — staleness window", () => {
  test("skips entries synced within the window; force overrides", async () => {
    const lib = makeLib();
    const { bridge, calls } = instrumentedBridge();
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    // addToLibrary seeds chapters → chaptersSyncedAt is fresh.
    await runtime.addToLibrary("test", "s1");
    expect(calls.get("s1")).toBe(1);

    const res = await runtime.backgroundSync();
    expect(calls.get("s1")).toBe(1); // untouched — inside the window
    expect(res).toMatchObject({ updated: 0, scanned: 1, skipped: 1, partial: false });

    const forced = await runtime.backgroundSync({ force: true });
    expect(calls.get("s1")).toBe(2);
    expect(forced).toMatchObject({ updated: 1, skipped: 0 });
  });

  test("never-synced entries always qualify", async () => {
    const lib = makeLib();
    const { bridge, calls } = instrumentedBridge();
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });
    await seedStaleEntries(lib, 2);

    const res = await runtime.backgroundSync();
    expect(res).toMatchObject({ updated: 2, scanned: 2, skipped: 0 });
    expect(calls.get("s0")).toBe(1);
    expect(calls.get("s1")).toBe(1);

    // A second run finds everything freshly synced.
    const again = await runtime.backgroundSync();
    expect(again).toMatchObject({ updated: 0, skipped: 2 });
  });
});

describe("backgroundSync — bounded concurrency", () => {
  test("at most `concurrency` entries sync in parallel", async () => {
    const lib = makeLib();
    const { bridge, maxInFlight } = instrumentedBridge({ delayMs: 10 });
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });
    await seedStaleEntries(lib, 6);

    await runtime.backgroundSync({ concurrency: 2 });
    expect(maxInFlight()).toBeGreaterThan(1); // actually parallel…
    expect(maxInFlight()).toBeLessThanOrEqual(2); // …but bounded
  });
});

describe("backgroundSync — time budget", () => {
  test("stops starting entries past the budget and resumes stalest-first next run", async () => {
    const lib = makeLib();
    const { bridge, calls } = instrumentedBridge({ delayMs: 20 });
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });
    await seedStaleEntries(lib, 3);

    // Budget expires during the first entry → exactly one synced, run reports partial.
    const first = await runtime.backgroundSync({ concurrency: 1, budgetMs: 1 });
    expect(first.partial).toBe(true);
    expect(first.updated).toBe(1);

    // Next run (no budget) picks up the two remaining never-synced entries — not the synced one.
    const second = await runtime.backgroundSync({ concurrency: 1 });
    expect(second).toMatchObject({ updated: 2, skipped: 1, partial: false });
    const total = [...calls.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(3); // every entry synced exactly once across both runs
  });
});

describe("backgroundSync — tracker gate", () => {
  test("trackers: false skips the whole-list tracker pull", async () => {
    const lib = makeLib();
    let pulls = 0;
    const tracker: Tracker = {
      info: { ...TRACKER_INFO, id: "anilist", capabilities: ["library-sync"] },
      async getLibrary(page) {
        void page;
        pulls++;
        return { items: [], page: 1, hasNextPage: false };
      },
    };
    const { bridge } = instrumentedBridge();
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });
    await seedStaleEntries(lib, 1);

    await runtime.backgroundSync({ trackers: false });
    expect(pulls).toBe(0);

    await runtime.backgroundSync({ force: true });
    expect(pulls).toBe(1);
  });
});
