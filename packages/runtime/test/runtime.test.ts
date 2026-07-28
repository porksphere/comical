/** ComicalRuntime — auto-tracker-linking, title-search suggestions, and read-sync. */
import { describe, expect, test } from "bun:test";
import type { Bridge, BridgeInfo, Chapter, SeriesInfo, Tracker, TrackerEntryUpdate, TrackerInfo, TrackerLibraryEntry } from "@comical/contract";
import { trackerEntryUpdateSchema } from "@comical/contract";
import { entryKey, InMemoryLibraryStore, Library, type TrackerLink } from "@comical/library";
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

/**
 * One captured `updateEntry` call — the WHOLE payload, not just `chaptersRead`. Status, dates and
 * progress now travel together in a single push, and asserting on the merged object is what proves
 * a status-only push carries no progress (and vice versa).
 */
type PushCall = { externalId: string | number } & TrackerEntryUpdate;

/** Today as `YYYY-MM-DD`, matching the runtime's own local-time stamp. */
const TODAY = new Date().toLocaleDateString("sv-SE");

/** A minimal tracker with controllable search results, push capture, and a pullable library list. */
function mockTracker(
  id: string,
  opts: {
    capabilities?: TrackerInfo["capabilities"];
    searchResults?: Array<{ externalId: number; title: string }>;
    updateCalls?: PushCall[];
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
      opts.updateCalls?.push({ externalId, ...update });
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
    const updateCalls: PushCall[] = [];
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
    const updateCalls: PushCall[] = [];
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

  test("does not re-push a count the tracker is already known to hold", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const updateCalls: PushCall[] = [];
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist", { updateCalls })]),
    });

    await runtime.addToLibrary("test", "s1");
    await runtime.markRead("test", "s1", "c2", true, "Ch 2", 2);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1", 1); // re-reading an earlier chapter
    await runtime.markRead("test", "s1", "c2", true, "Ch 2", 2); // and re-marking the same one

    // Only the first read moved the high-water mark, so only it reached the tracker — the other two
    // would have been identical writes burning a rate-limited slot on every page turn. That first
    // push also carries "reading": a link with no known status has never been seen on the service,
    // so the read that creates it is the start of reading.
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 2, status: "reading", startedAt: TODAY }]);
  });

  test("a failing push is reported to the log instead of being swallowed, and never fails the read", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const warns: unknown[][] = [];
    const tracker: Tracker = {
      ...mockTracker("anilist"),
      async updateEntry() { throw new Error("AniList: invalid or expired access token"); },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
      log: { debug() {}, info() {}, warn: (...args) => { warns.push(args); }, error() {} },
    });

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);

    // The read itself still succeeds…
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");
    const read = (await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId);
    expect(read).toEqual(["c1"]);

    // …but the dropped push is now visible.
    expect(warns).toHaveLength(1);
    expect(String(warns[0]![0])).toContain("tracker push failed: anilist test:s1");
    expect(String(warns[0]![1])).toContain("invalid or expired access token");
  });

  test("retries a transient push failure and succeeds without reporting anything", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const warns: unknown[][] = [];
    let attempts = 0;
    const tracker: Tracker = {
      ...mockTracker("anilist"),
      async updateEntry() {
        attempts++;
        if (attempts < 3) throw new Error("network request failed");
      },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
      log: { debug() {}, info() {}, warn: (...args) => { warns.push(args); }, error() {} },
    });

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");

    expect(attempts).toBe(3);
    expect(warns).toHaveLength(0);
    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link).toMatchObject({ chaptersRead: 1 });
  });

  test("gives up immediately on an auth failure — retrying a dead token just burns rate limit", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    let attempts = 0;
    const tracker: Tracker = {
      ...mockTracker("anilist"),
      async updateEntry() {
        attempts++;
        throw new Error("AniList: invalid or expired access token");
      },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");

    expect(attempts).toBe(1);
  });

  test("a push failure leaves the link's lastSyncAt unstamped (not a false 'synced just now')", async () => {
    const lib = makeLib();
    const bridge = mockBridge({ id: "s1", title: "Series", externalIds: { anilist: 111 } });
    const tracker: Tracker = {
      ...mockTracker("anilist"),
      async updateEntry() { throw new Error("network down"); },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    }); // no log configured — must still not throw

    await runtime.addToLibrary("test", "s1");
    await lib.syncChapters("test:s1", [{ id: "c1", name: "Ch 1", number: 1 }]);
    await runtime.markRead("test", "s1", "c1", true, "Ch 1");

    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link!.lastSyncAt).toBeUndefined();
  });
});

// ── Status sync: completion, reading/rereading, dates, clamping ───────────────

describe("syncEntryToTrackers — status", () => {
  /**
   * A linked, chapter-synced entry ready for status assertions. `status` is the bridge's publication
   * status (trigger B's input, cached at add time); `link` patches the tracker link the way a pull
   * would have — the only way `totalChapters` or a service-side status ever gets there.
   */
  async function setup(opts: {
    chapters: Chapter[];
    status?: SeriesInfo["status"];
    link?: Partial<TrackerLink>;
    read?: Chapter[];
  }) {
    const lib = makeLib();
    const updateCalls: PushCall[] = [];
    const bridge = syncBridge({
      details: {
        id: "s1",
        title: "Series",
        externalIds: { anilist: 111 },
        ...(opts.status && { status: opts.status }),
      },
      chapters: opts.chapters,
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([mockTracker("anilist", { updateCalls })]),
    });
    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111, caches the detail + chapters
    if (opts.link) await lib.updateTrackerLink("test:s1", "anilist", opts.link);
    // Seeded through the library, not the runtime, so the pushes under test are the only ones.
    for (const c of opts.read ?? []) await lib.markRead("test:s1", c.id, true, c.name, c.number);
    return { lib, runtime, updateCalls };
  }

  const CH = [ch("c1", 1), ch("c2", 2), ch("c3", 3)];

  test("trigger B: a fully-read COMPLETED series completes even when progress didn't move", async () => {
    // The reported bug. The watermark already holds 3, so there is no progress to report — and the
    // old push was progress-only, which is exactly why the tracker sat on "Reading" forever.
    const { lib, runtime, updateCalls } = await setup({
      chapters: CH,
      status: "completed",
      link: { chaptersRead: 3 },
      read: CH,
    });

    await runtime.markRead("test", "s1", "c3", true, "Ch 3", 3);

    expect(updateCalls).toEqual([{ externalId: 111, status: "completed", finishedAt: TODAY }]);
    const link = await lib.getTrackerLink("test:s1", "anilist");
    expect(link).toMatchObject({ status: "completed", chaptersRead: 3 });
    expect(link!.completedPushedAt).toBeGreaterThan(0);
  });

  test("a status-only push never drags the watermark down to local progress", async () => {
    // A pull had raised the watermark to 70 (the tracker holds more than this source publishes).
    // Writing `chaptersRead` unconditionally would reset it to 3 and re-push forever.
    const { lib, runtime, updateCalls } = await setup({
      chapters: CH,
      status: "completed",
      link: { chaptersRead: 70 },
      read: CH,
    });

    await runtime.markRead("test", "s1", "c3", true, "Ch 3", 3);

    expect(updateCalls[0]).not.toHaveProperty("chaptersRead");
    expect((await lib.getTrackerLink("test:s1", "anilist"))!.chaptersRead).toBe(70);
  });

  test("trigger A: reaching the tracker's own total completes a series the bridge calls unknown", async () => {
    // No usable publication status, so trigger B can never fire — this is the Mihon/Aidoku rule.
    const { runtime, updateCalls } = await setup({
      chapters: [ch("c20", 20)],
      link: { totalChapters: 20, status: "reading" },
    });

    await runtime.markRead("test", "s1", "c20", true, "Ch 20", 20);

    expect(updateCalls).toEqual([
      { externalId: 111, chaptersRead: 20, status: "completed", finishedAt: TODAY },
    ]);
  });

  test("progress is clamped to the tracker's total, and the clamped value settles", async () => {
    const { lib, runtime, updateCalls } = await setup({
      chapters: [ch("c70", 70)],
      link: { totalChapters: 66, status: "reading" },
    });

    await runtime.markRead("test", "s1", "c70", true, "Ch 70", 70);
    expect(updateCalls.at(-1)).toMatchObject({ chaptersRead: 66 });
    expect((await lib.getTrackerLink("test:s1", "anilist"))!.chaptersRead).toBe(66);

    // Comparing the CLAMPED value against the watermark is what stops this repeating: local (70) is
    // permanently "ahead" of a total of 66, so an unclamped comparison would re-push on every read.
    await runtime.syncEntryToTrackers("test", "s1");
    expect(updateCalls).toHaveLength(1);
  });

  test("completion is pushed exactly once", async () => {
    const { runtime, updateCalls } = await setup({
      chapters: CH,
      status: "completed",
      link: { chaptersRead: 3 },
      read: CH,
    });

    await runtime.syncEntryToTrackers("test", "s1");
    await runtime.syncEntryToTrackers("test", "s1");
    await runtime.syncEntryToTrackers("test", "s1");

    expect(updateCalls).toHaveLength(1);
  });

  test("a status the user set themselves is never overwritten with 'completed'", async () => {
    // Someone deliberately dropped a series they'd finished reading. Inferring "already pushed" from
    // `link.status` would fail here, because a pull overwrites that field with the service's truth —
    // so the sentinel is `completedPushedAt`, which records only what WE sent.
    const { lib, runtime, updateCalls } = await setup({
      chapters: CH,
      status: "completed",
      link: { chaptersRead: 3, completedPushedAt: 1_000 },
      read: CH,
    });

    await runtime.syncEntryToTrackers("test", "s1");
    // …and still nothing after a pull rewrites the link's status to the user's own choice.
    await lib.updateTrackerLink("test:s1", "anilist", { status: "dropped" });
    await runtime.syncEntryToTrackers("test", "s1");

    expect(updateCalls).toEqual([]);
  });

  test("a fully-read ONGOING series moves progress and stays 'reading'", async () => {
    const { runtime, updateCalls } = await setup({
      chapters: CH,
      status: "ongoing",
      link: { status: "reading" },
      read: [CH[0]!, CH[1]!],
    });

    await runtime.markRead("test", "s1", "c3", true, "Ch 3", 3);

    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 3 }]);
  });

  test("a PLANNING link flips to reading, with a start date", async () => {
    const { runtime, updateCalls } = await setup({ chapters: CH, link: { status: "planning" } });

    await runtime.markRead("test", "s1", "c1", true, "Ch 1", 1);

    expect(updateCalls).toEqual([
      { externalId: 111, chaptersRead: 1, status: "reading", startedAt: TODAY },
    ]);
  });

  test("an ON_HOLD link keeps its status — resuming a paused series is the user's call", async () => {
    const { runtime, updateCalls } = await setup({ chapters: CH, link: { status: "on_hold" } });

    await runtime.markRead("test", "s1", "c1", true, "Ch 1", 1);

    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 1 }]);
  });

  test("reading a series the tracker already holds as completed is a re-read", async () => {
    const { runtime, updateCalls } = await setup({
      chapters: CH,
      link: { status: "completed", chaptersRead: 3, completedPushedAt: 1_000 },
    });

    await runtime.markRead("test", "s1", "c1", true, "Ch 1", 1);
    // Nothing yet: progress (1) is below the watermark (3), so there's no new information.
    expect(updateCalls).toEqual([]);

    await runtime.markRead("test", "s1", "c4", true, "Ch 4", 4);
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 4, status: "rereading" }]);
  });

  test("an in-progress re-read is left alone", async () => {
    const { runtime, updateCalls } = await setup({
      chapters: CH,
      link: { status: "rereading", chaptersRead: 1 },
    });

    await runtime.markRead("test", "s1", "c2", true, "Ch 2", 2);

    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 2 }]);
  });

  test("every pushed payload is a valid TrackerEntryUpdate", async () => {
    const { runtime, updateCalls } = await setup({
      chapters: CH,
      status: "completed",
      link: { status: "planning" },
      read: [CH[0]!, CH[1]!],
    });

    await runtime.markRead("test", "s1", "c3", true, "Ch 3", 3);

    expect(updateCalls).toHaveLength(1);
    for (const { externalId, ...update } of updateCalls) {
      void externalId;
      expect(() => trackerEntryUpdateSchema.parse(update)).not.toThrow();
    }
    // Completion wins over the planning→reading transition: one status, and it's the finished one.
    expect(updateCalls[0]).toMatchObject({ status: "completed", finishedAt: TODAY });
    expect(updateCalls[0]).not.toHaveProperty("startedAt");
  });

  test("a failed completion push leaves completedPushedAt unset so the next sync retries", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 }, status: "completed" },
      chapters: CH,
    });
    let fail = true;
    const calls: PushCall[] = [];
    const base = mockTracker("anilist", { updateCalls: calls });
    const tracker: Tracker = {
      ...base,
      async updateEntry(externalId, update) {
        if (fail) throw new Error("AniList: invalid or expired access token");
        return base.updateEntry!(externalId, update);
      },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    await lib.updateTrackerLink("test:s1", "anilist", { chaptersRead: 3 });
    for (const c of CH) await lib.markRead("test:s1", c.id, true, c.name, c.number);

    await runtime.syncEntryToTrackers("test", "s1");
    expect((await lib.getTrackerLink("test:s1", "anilist"))!.completedPushedAt).toBeUndefined();

    fail = false;
    await runtime.syncEntryToTrackers("test", "s1");
    expect(calls).toEqual([{ externalId: 111, status: "completed", finishedAt: TODAY }]);
    expect((await lib.getTrackerLink("test:s1", "anilist"))!.completedPushedAt).toBeGreaterThan(0);
  });

  test("a pull mirrors the tracker's own chapter count onto the link", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: CH,
    });
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      libraryEntries: [
        { externalId: 111, title: "Series", status: "reading", chaptersRead: 2, totalChapters: 66 },
      ],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    await runtime.syncFromTracker("anilist");

    expect(await lib.getTrackerLink("test:s1", "anilist")).toMatchObject({
      status: "reading",
      chaptersRead: 2,
      totalChapters: 66,
    });
  });
});

// ── markActivityRead ─────────────────────────────────────────────────────────

describe("markActivityRead", () => {
  /** A library + runtime whose entry has two detected activity chapters, one already read. */
  async function withFeed(tracker: Tracker, lib = makeLib()) {
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1)],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });
    await runtime.addToLibrary("test", "s1"); // baseline sync — no activity yet
    await lib.syncChapters("test:s1", [ch("c1", 1), ch("c2", 2), ch("c3", 3)]);
    return { lib, runtime };
  }

  test("clearing a series' feed pushes the new progress to its tracker", async () => {
    // Previously the one way to mark chapters read that never reached a tracker: the route called
    // the library directly, bypassing the runtime.
    const updateCalls: PushCall[] = [];
    const { lib, runtime } = await withFeed(mockTracker("anilist", { updateCalls }));

    const { marked } = await runtime.markActivityRead("test", "s1");

    expect(marked).toBe(2);
    expect(updateCalls).toEqual([
      { externalId: 111, chaptersRead: 3, status: "reading", startedAt: TODAY },
    ]);
    const read = new Set((await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c2", "c3"]));
  });

  test("a tracker failure never fails the mark", async () => {
    const tracker: Tracker = {
      ...mockTracker("anilist"),
      async updateEntry() { throw new Error("AniList: invalid or expired access token"); },
    };
    const { runtime } = await withFeed(tracker);

    expect(await runtime.markActivityRead("test", "s1")).toEqual({ marked: 2 });
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

// ── syncEntryWithTracker — scoped, manual per-entry TWO-WAY sync ─────────────

describe("syncEntryWithTracker", () => {
  test("pulls when the tracker is ahead: updates the link and reconciles read state", async () => {
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

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 2, pushed: false, chaptersRead: 2 });
    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link).toMatchObject({ trackerId: "anilist", status: "reading", chaptersRead: 2 });
    const read = new Set((await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId));
    expect(read).toEqual(new Set(["c1", "c2"]));
  });

  test("pushes when local is ahead: writes the local count to the tracker, marks nothing new read", async () => {
    const lib = makeLib();
    const chapters = [ch("c1", 1), ch("c2", 2), ch("c3", 3)];
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } }, chapters });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      updateCalls,
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 1 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    // Read locally without going through the runtime, so the only push is the one under test.
    await lib.markRead("test:s1", "c3", true, "Ch 3", 3);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 0, pushed: true, chaptersRead: 3 });
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 3 }]);
    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link).toMatchObject({ chaptersRead: 3 });
    expect(link!.lastSyncAt).toBeGreaterThan(0);
  });

  test("pushes (creating the entry) when the tracker's list has nothing for the link", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2)],
    });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      updateCalls,
      libraryEntries: [],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c2", true, "Ch 2", 2);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 0, pushed: true, chaptersRead: 2 });
    // The tracker has no entry at all, so this push creates one — hence "reading" and a start date.
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 2, status: "reading", startedAt: TODAY }]);
  });

  test("neither side moves when both are level: no push, nothing newly read", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2)],
    });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      updateCalls,
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 2 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c1", true, "Ch 1", 1);
    await lib.markRead("test:s1", "c2", true, "Ch 2", 2);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 0, pushed: false, chaptersRead: 2 });
    expect(updateCalls).toEqual([]);
  });

  test("a push-only tracker (status-sync, no library-sync) still pushes without pulling a list", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2)],
    });
    const updateCalls: PushCall[] = [];
    let libraryCalls = 0;
    const base = mockTracker("anilist", { capabilities: ["status-sync"], updateCalls });
    const tracker: Tracker = {
      ...base,
      async getLibrary(page) { libraryCalls++; return base.getLibrary!(page); },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c2", true, "Ch 2", 2);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 0, pushed: true, chaptersRead: 2 });
    // No pull means no known status either, so this is still the "first read" transition.
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 2, status: "reading", startedAt: TODAY }]);
    expect(libraryCalls).toBe(0);
  });

  test("a pull-only tracker (library-sync, no status-sync) never pushes, even when local is ahead", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c1", 1), ch("c2", 2), ch("c3", 3)],
    });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync"],
      updateCalls,
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 1 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c3", true, "Ch 3", 3);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    // c1 gets marked read from the remote count of 1; c3 was already read locally.
    expect(res).toEqual({ updated: true, readSynced: 1, pushed: false, chaptersRead: 1 });
    expect(updateCalls).toEqual([]);
    // The local read stands — pulling a lower remote count never un-reads a chapter.
    const read = new Set((await lib.getProgress("test:s1")).filter((p) => p.read).map((p) => p.chapterId));
    expect(read.has("c3")).toBe(true);
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

    await expect(runtime.syncEntryWithTracker("test", "s1", "anilist")).rejects.toThrow(/no anilist link/);
  });

  test("throws when the tracker can neither pull nor push", async () => {
    const lib = makeLib();
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } } });
    const tracker = mockTracker("anilist", { capabilities: ["search"] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111

    await expect(runtime.syncEntryWithTracker("test", "s1", "anilist")).rejects.toThrow(
      /neither library-sync nor status-sync/,
    );
  });

  test("returns updated: false when neither side has anything to move", async () => {
    const lib = makeLib();
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } } });
    const tracker = mockTracker("anilist", { capabilities: ["library-sync"], libraryEntries: [] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: false, readSynced: 0, pushed: false, chaptersRead: 0 });
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

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(res).toEqual({ updated: true, readSynced: 1, pushed: false, chaptersRead: 1 });
    expect(calledPages).toEqual([1, 2]);
  });

  // The reason "local ahead" is measured against the link's watermark and not against what the
  // tracker reports back. AniList's `progress` and MAL's `num_chapters_read` are integers, so a
  // decimal chapter comes back truncated — forever lower than local, if you compare against it.
  test("an integer-only tracker's truncated echo does not cause a repeat push", async () => {
    const lib = makeLib();
    const chapters = [ch("c12", 12), ch("c12.5", 12.5)];
    const bridge = syncBridge({ details: { id: "s1", title: "Series", externalIds: { anilist: 111 } }, chapters });
    const updateCalls: PushCall[] = [];
    // Stores whatever it's given as an integer and reports that back, exactly like AniList.
    const entries: TrackerLibraryEntry[] = [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 0 }];
    const tracker: Tracker = {
      info: { ...TRACKER_INFO, id: "anilist", capabilities: ["library-sync", "status-sync"] },
      async updateEntry(externalId, update) {
        updateCalls.push({ externalId, ...(update.chaptersRead !== undefined && { chaptersRead: update.chaptersRead }) });
        entries[0]!.chaptersRead = Math.floor(update.chaptersRead ?? 0);
      },
      async getLibrary() {
        return { items: entries, page: 1, hasNextPage: false };
      },
    };
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c12", true, "Ch 12", 12);
    await lib.markRead("test:s1", "c12.5", true, "Ch 12.5", 12.5);

    const first = await runtime.syncEntryWithTracker("test", "s1", "anilist");
    expect(first).toEqual({ updated: true, readSynced: 0, pushed: true, chaptersRead: 12.5 });
    expect(entries[0]!.chaptersRead).toBe(12); // the tracker truncated it

    // Pressing Sync again: the tracker still says 12, but the watermark says it has 12.5, so this
    // settles instead of pushing the same value a second (and third, and fourth) time.
    const second = await runtime.syncEntryWithTracker("test", "s1", "anilist");
    expect(second).toEqual({ updated: true, readSynced: 0, pushed: false, chaptersRead: 12.5 });
    expect(updateCalls).toEqual([{ externalId: 111, chaptersRead: 12.5 }]);
  });

  test("a pull does not lower the watermark to the tracker's truncated echo", async () => {
    const lib = makeLib();
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 } },
      chapters: [ch("c12", 12), ch("c12.5", 12.5)],
    });
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 12 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1"); // auto-links anilist:111
    await lib.markRead("test:s1", "c12.5", true, "Ch 12.5", 12.5);
    await runtime.syncEntryWithTracker("test", "s1", "anilist"); // pushes 12.5, watermark := 12.5

    // The bulk pull sees the tracker's 12. Writing that to the link would undo the watermark and
    // make the very next sync push 12.5 all over again.
    await runtime.syncFromTracker("anilist");

    const [link] = await lib.listTrackerLinks("test:s1");
    expect(link).toMatchObject({ chaptersRead: 12.5 });
  });

  test("repairs a stuck finished series: pushes the status alone, sending no progress", async () => {
    // The already-broken entry from the bug report. Everything is read and the watermark is level
    // with local progress, so there is nothing left for a read to trigger — the Sync button has to be
    // able to fix it, which it can only do if a push no longer requires progress to have moved.
    const lib = makeLib();
    const chapters = [ch("c1", 1), ch("c2", 2), ch("c3", 3)];
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 }, status: "completed" },
      chapters,
    });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      updateCalls,
      libraryEntries: [{ externalId: 111, title: "Series", status: "reading", chaptersRead: 3 }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    for (const c of chapters) await lib.markRead("test:s1", c.id, true, c.name, c.number);
    await lib.updateTrackerLink("test:s1", "anilist", { chaptersRead: 3 });

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    expect(updateCalls).toEqual([{ externalId: 111, status: "completed", finishedAt: TODAY }]);
    expect(res).toMatchObject({ updated: true, pushed: true });
    // The just-pushed status survives the pulled item, which still says "reading" (it predates us).
    expect(await lib.getTrackerLink("test:s1", "anilist")).toMatchObject({
      status: "completed",
      chaptersRead: 3,
    });

    // And it doesn't repeat.
    await runtime.syncEntryWithTracker("test", "s1", "anilist");
    expect(updateCalls).toHaveLength(1);
  });

  test("the pull's own chapter total drives trigger A here, clamping what it pushes", async () => {
    // The manual path builds its decision from the item it just pulled, not from the link — so a
    // total the link has never seen still completes the entry on the very first sync. The bridge
    // calls the series "unknown", so trigger B cannot be what fires.
    const lib = makeLib();
    const chapters = [ch("c1", 1), ch("c2", 2), ch("c3", 3), ch("c4", 4)];
    const bridge = syncBridge({
      details: { id: "s1", title: "Series", externalIds: { anilist: 111 }, status: "unknown" },
      chapters,
    });
    const updateCalls: PushCall[] = [];
    const tracker = mockTracker("anilist", {
      capabilities: ["library-sync", "status-sync"],
      updateCalls,
      // AniList numbers this series 1–3; the source has a fourth chapter it doesn't know about.
      libraryEntries: [
        { externalId: 111, title: "Series", status: "reading", chaptersRead: 1, totalChapters: 3 },
      ],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(bridge),
      library: lib,
      trackers: mockTrackerProvider([tracker]),
    });

    await runtime.addToLibrary("test", "s1");
    for (const c of chapters) await lib.markRead("test:s1", c.id, true, c.name, c.number);

    const res = await runtime.syncEntryWithTracker("test", "s1", "anilist");

    // 3, not the local 4 — never claim more chapters than the service thinks exist.
    expect(updateCalls).toEqual([
      { externalId: 111, chaptersRead: 3, status: "completed", finishedAt: TODAY },
    ]);
    expect(res).toMatchObject({ updated: true, pushed: true, chaptersRead: 3 });
    expect(await lib.getTrackerLink("test:s1", "anilist")).toMatchObject({
      chaptersRead: 3,
      totalChapters: 3,
      status: "completed",
    });

    // The clamped value settles: local is still "ahead" at 4 forever, and that must not re-push.
    await runtime.syncEntryWithTracker("test", "s1", "anilist");
    expect(updateCalls).toHaveLength(1);
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

describe("backgroundSync — series-detail refresh", () => {
  /** A bridge whose publication status can change between syncs, counting detail fetches. */
  function statusBridge(status: () => SeriesInfo["status"]) {
    let detailCalls = 0;
    const bridge: Bridge = {
      info: BRIDGE_INFO,
      async getSeriesDetails() {
        detailCalls++;
        return { id: "s1", title: "Series", status: status() };
      },
      async getChapters() { return [ch("c1", 1)]; },
    };
    return { bridge, calls: () => detailCalls };
  }

  test("re-fetches an ongoing series' detail once the cache goes stale, catching that it finished", async () => {
    // Without this, a series added while ongoing is never *known* to have finished unless the user
    // opens its page — so its tracker sits on "Reading" indefinitely.
    const lib = makeLib();
    let status: SeriesInfo["status"] = "ongoing";
    const { bridge, calls } = statusBridge(() => status);
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    await runtime.addToLibrary("test", "s1");
    expect(calls()).toBe(1);

    // Inside the window, the cached answer stands — this is the common path, and re-fetching here
    // would double every background sync's request count.
    await runtime.backgroundSync({ force: true });
    expect(calls()).toBe(1);

    // Now treat the cache as stale (a zero window makes any cached age qualify).
    status = "completed";
    await runtime.backgroundSync({ force: true, detailStaleMs: 0 });

    expect(calls()).toBe(2);
    expect((await lib.getCachedDetail("test:s1"))?.info.status).toBe("completed");
  });

  test("a terminal status is never re-fetched — 'completed' cannot go stale", async () => {
    const lib = makeLib();
    const { bridge, calls } = statusBridge(() => "completed");
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    await runtime.addToLibrary("test", "s1");
    await runtime.backgroundSync({ force: true, detailStaleMs: 0 });

    expect(calls()).toBe(1);
  });

  test("an entry with no cached detail gets one, whatever the window says", async () => {
    const lib = makeLib();
    const { bridge, calls } = statusBridge(() => "ongoing");
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });

    // Seeded straight into the library (a favourites import), so nothing was ever cached.
    await lib.addSeries({ bridgeId: "test", seriesId: "s1", title: "Series" });
    expect(await lib.getCachedDetail("test:s1")).toBeUndefined();

    await runtime.backgroundSync();

    expect(calls()).toBe(1);
    expect((await lib.getCachedDetail("test:s1"))?.info.status).toBe("ongoing");
  });

  test("a failing detail fetch never aborts the entry's sync", async () => {
    const lib = makeLib();
    const bridge: Bridge = {
      info: BRIDGE_INFO,
      async getSeriesDetails() { throw new Error("source down"); },
      async getChapters() { return [ch("c1", 1), ch("c2", 2)]; },
    };
    const runtime = new ComicalRuntime({ bridges: mockBridgeProvider(bridge), library: lib });
    await lib.addSeries({ bridgeId: "test", seriesId: "s1", title: "Series" });

    const res = await runtime.backgroundSync();

    expect(res).toMatchObject({ updated: 1 });
    expect((await lib.getEntry("test:s1"))?.knownChapters).toHaveLength(2);
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

// ── searchTracker — the "link tracker" UI flow ────────────────────────────────
// Directly exercises the method the tracker-link search calls. Its "no trackers configured" guard
// is the exact error the on-device runtime once threw (see host-rn's install-trackers.test.ts): a
// runtime built without a tracker provider, so a passing runtime-layer test here plus the install-
// layer test there fence the bug from both ends.

describe("searchTracker", () => {
  test("returns a search-capable tracker's results", async () => {
    const tracker = mockTracker("anilist", {
      capabilities: ["search"],
      searchResults: [{ externalId: 42, title: "Blame!" }],
    });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(mockBridge({ id: "s1", title: "x" })),
      library: makeLib(),
      trackers: mockTrackerProvider([tracker]),
    });

    const res = await runtime.searchTracker("anilist", "blame");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ externalId: 42, title: "Blame!" });
  });

  test("throws 'no trackers configured' when the runtime has no tracker provider", async () => {
    // The literal on-device regression: list/settings/connect went through the router's
    // TrackerManager, but search routes through this runtime, which was built trackers-unaware.
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(mockBridge({ id: "s1", title: "x" })),
      library: makeLib(),
    });
    await expect(runtime.searchTracker("anilist", "blame")).rejects.toThrow(/no trackers configured/);
  });

  test("throws when the tracker lacks the search capability", async () => {
    const tracker = mockTracker("anilist", { capabilities: ["library-sync"] });
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(mockBridge({ id: "s1", title: "x" })),
      library: makeLib(),
      trackers: mockTrackerProvider([tracker]),
    });
    await expect(runtime.searchTracker("anilist", "blame")).rejects.toThrow(/does not support search/);
  });

  test("propagates an unknown tracker id from the provider", async () => {
    const runtime = new ComicalRuntime({
      bridges: mockBridgeProvider(mockBridge({ id: "s1", title: "x" })),
      library: makeLib(),
      trackers: mockTrackerProvider([mockTracker("anilist", { capabilities: ["search"] })]),
    });
    await expect(runtime.searchTracker("mal", "blame")).rejects.toThrow(/not found/);
  });
});
