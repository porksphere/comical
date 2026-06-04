/**
 * REST API router. Browser and app clients call these endpoints — they never load
 * bridge bundles or know what a bridge is internally.
 *
 * All bridge execution (fetching, parsing, rate-limiting) happens server-side.
 * The browser gets back clean JSON matching the @comical/contract models.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bridgeSeriesStatusSchema } from "@comical/contract";
import type { Chapter, FilterValue, ListOptions, SearchOptions, SettingValue } from "@comical/contract";
import { BridgeSettingsError, validateSettingsInput } from "@comical/core";
import { entryKey, type Library } from "@comical/library";
import type { RegistryManager } from "@comical/registry";
import type { ComicalRuntime } from "@comical/runtime";
import type { BridgeManager } from "./bridge-manager.ts";
import type { TrackerManager } from "./tracker-manager.ts";

export interface RouterOptions {
  /** CORS origin(s) allowed. Defaults to '*' for LAN use. */
  origin?: string;
  /** Optional bearer token for simple auth. */
  token?: string;
  /** Registry manager — enables M4 registry endpoints. */
  registry?: RegistryManager;
  /** Local library service — enables the optional `/library` tracking endpoints when provided. */
  library?: Library;
  /** Runtime orchestration layer — required alongside `library` for read-sync and richer addToLibrary. */
  runtime?: ComicalRuntime;
  /** Tracker manager — enables `/trackers` endpoints when provided. */
  trackers?: TrackerManager;
}

type Bindings = Record<string, never>;
type Vars = { manager: BridgeManager };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRouter(manager: BridgeManager, opts: RouterOptions = {}): Hono<any> {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

  app.use("*", cors({
    origin: opts.origin ?? "*",
    allowMethods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 3600,
  }));

  if (opts.token) {
    const guard = async (c: { req: { header: (k: string) => string | undefined }; json: (b: unknown, s?: number) => Response }, next: () => Promise<void>) => {
      const auth = c.req.header("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== opts.token) return c.json({ error: "unauthorized" }, 401);
      await next();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use("/bridges/*", guard as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use("/library/*", guard as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use("/trackers/*", guard as any);
  }

  app.use("*", async (c, next) => {
    c.set("manager", manager);
    await next();
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/health", (c) => c.json({ ok: true }));

  // ── Bridge registry ──────────────────────────────────────────────────────────

  app.get("/bridges", async (c) => {
    const list = await c.get("manager").list();
    return c.json(list);
  });

  app.get("/bridges/:id", async (c) => {
    return withBridge(c, async (bridge) => {
      const manager = c.get("manager") as BridgeManager;
      const settings = bridge.getSettings?.() ?? [];
      const missingRequired = await manager.missingRequired(bridge.info.id);

      // Return current stored values so a UI can prefill the form, but never expose secret
      // string values — instead report which secret keys are set.
      const stored = await manager.storedSettings(bridge.info.id);
      const secretKeys = new Set(
        settings.filter((d) => d.type === "string" && d.secret).map((d) => d.key),
      );
      const values: Record<string, SettingValue> = {};
      const secretsSet: string[] = [];
      for (const [k, v] of Object.entries(stored)) {
        if (secretKeys.has(k)) { if (v !== undefined && v !== "") secretsSet.push(k); }
        else values[k] = v;
      }

      return c.json({
        info: bridge.info,
        settings,
        values,
        secretsSet,
        missingRequired,
        configured: missingRequired.length === 0,
      });
    });
  });

  /** Update user settings for a bridge (e.g. set baseUrl, credentials). Validates against descriptors. */
  app.put("/bridges/:id/settings", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, SettingValue>;
    try {
      body = await c.req.json<Record<string, SettingValue>>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const manager = c.get("manager") as BridgeManager;
    try {
      const bridge = await manager.get(id);
      const descriptors = bridge.getSettings?.() ?? [];
      const coerced = validateSettingsInput(body, descriptors);
      const updated = await manager.updateSettings(id, coerced);
      return c.json({ settings: updated });
    } catch (e) {
      if (e instanceof BridgeSettingsError) return c.json({ error: e.message, issues: e.issues }, 400);
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
    }
  });

  // ── Content endpoints ────────────────────────────────────────────────────────

  app.get("/bridges/:id/search", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getSearchResults) return c.json({ error: "not supported" }, 400);
      const q = c.req.query("q") ?? "";
      const page = Number(c.req.query("page") ?? "1");
      const options: SearchOptions = {};
      // Filters: URL-encoded JSON array of FilterValue in ?filters=.
      const rawFilters = c.req.query("filters");
      if (rawFilters) {
        try {
          options.filters = JSON.parse(rawFilters) as FilterValue[];
        } catch {
          return c.json({ error: "invalid filters: expected URL-encoded JSON array" }, 400);
        }
      }
      // Sort: ?sort=<key>&dir=asc|desc (dir defaults to asc).
      const sortKey = c.req.query("sort");
      if (sortKey) options.sort = { key: sortKey, ascending: c.req.query("dir") !== "desc" };
      return c.json(await bridge.getSearchResults(q, page, options));
    }),
  );

  app.get("/bridges/:id/sort", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getSortOptions) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getSortOptions());
    }),
  );

  app.get("/bridges/:id/lists", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getLists) return c.json({ error: "not supported" }, 400);
      const q = c.req.query("q");
      return c.json(await bridge.getLists(q ?? undefined));
    }),
  );

  app.get("/bridges/:id/lists/:listId", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getListItems) return c.json({ error: "not supported" }, 400);
      const page = Number(c.req.query("page") ?? "1");
      const options: ListOptions = {};
      const q = c.req.query("q");
      if (q) options.query = q;
      const rawFilters = c.req.query("filters");
      if (rawFilters) {
        try {
          options.filters = JSON.parse(rawFilters) as FilterValue[];
        } catch {
          return c.json({ error: "invalid filters: expected URL-encoded JSON array" }, 400);
        }
      }
      const sortKey = c.req.query("sort");
      if (sortKey) options.sort = { key: sortKey, ascending: c.req.query("dir") !== "desc" };
      return c.json(await bridge.getListItems(c.req.param("listId"), page, options));
    }),
  );

  app.get("/bridges/:id/filters", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getFilters) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getFilters());
    }),
  );

  app.get("/bridges/:id/tags", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getTags) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getTags());
    }),
  );

  // ── Favorites (capability "favorites") — backend-synced; the bridge handles auth ──────────────

  app.get("/bridges/:id/favorites", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getFavorites) return c.json({ error: "not supported" }, 400);
      const page = Number(c.req.query("page") ?? "1");
      return c.json(await bridge.getFavorites(page));
    }),
  );

  app.put("/bridges/:id/favorites/:seriesId", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.addFavorite) return c.json({ error: "not supported" }, 400);
      await bridge.addFavorite(c.req.param("seriesId"));
      return c.json({ ok: true });
    }),
  );

  app.delete("/bridges/:id/favorites/:seriesId", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.removeFavorite) return c.json({ error: "not supported" }, 400);
      await bridge.removeFavorite(c.req.param("seriesId"));
      return c.json({ ok: true });
    }),
  );

  app.get("/bridges/:id/series/:seriesId", (c) =>
    withContentBridge(c, async (bridge) => {
      return c.json(await bridge.getSeriesDetails(c.req.param("seriesId")));
    }),
  );

  app.get("/bridges/:id/series/:seriesId/chapters", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getChapters) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getChapters(c.req.param("seriesId")));
    }),
  );

  app.get("/bridges/:id/series/:seriesId/chapters/:chapterId/pages", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getChapterPages) return c.json({ error: "not supported" }, 400);
      return c.json(
        await bridge.getChapterPages(c.req.param("seriesId"), c.req.param("chapterId")),
      );
    }),
  );

  app.get("/bridges/:id/series/:seriesId/pages", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getSeriesPages) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getSeriesPages(c.req.param("seriesId")));
    }),
  );

  // ── Read-sync (capability "read-sync") ────────────────────────────────────────

  app.post("/bridges/:id/series/:seriesId/chapters/:chapterId/read", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.markChapterRead) return c.json({ error: "not supported" }, 400);
      await bridge.markChapterRead(c.req.param("seriesId"), c.req.param("chapterId"));
      return c.json({ ok: true });
    }),
  );

  app.delete("/bridges/:id/series/:seriesId/chapters/:chapterId/read", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.markChapterUnread) return c.json({ error: "not supported" }, 400);
      await bridge.markChapterUnread(c.req.param("seriesId"), c.req.param("chapterId"));
      return c.json({ ok: true });
    }),
  );

  app.put("/bridges/:id/series/:seriesId/status", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.setSeriesStatus) return c.json({ error: "not supported" }, 400);
      const b = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }));
      if (!b.status) return c.json({ error: "status is required" }, 400);
      const parsed = bridgeSeriesStatusSchema.safeParse(b.status);
      if (!parsed.success) return c.json({ error: `invalid status: ${b.status}` }, 400);
      await bridge.setSeriesStatus(c.req.param("seriesId"), parsed.data);
      return c.json({ ok: true });
    }),
  );

  // ── Library (optional local tracking module) ──────────────────────────────────
  // Mounted only when a Library service is supplied; cross-bridge, keyed by (bridgeId, seriesId).

  const trackerMgr = opts.trackers;
  const lib = opts.library;
  const runtime = opts.runtime;
  if (lib) {
    const keyOf = (c: { req: { param: (k: string) => string } }) =>
      entryKey(c.req.param("bridgeId"), c.req.param("seriesId"));
    const body = async <T>(c: { req: { json: <U>() => Promise<U> } }): Promise<T | undefined> => {
      try { return await c.req.json<T>(); } catch { return undefined; }
    };

    app.get("/library", async (c) => {
      const category = c.req.query("category");
      return c.json(await lib.getLibrary(category ? { categoryId: category } : {}));
    });

    app.get("/library/history", async (c) => {
      const limit = c.req.query("limit");
      return c.json(await lib.getHistory(limit ? Number(limit) : undefined));
    });

    // Categories
    app.get("/library/categories", async (c) => c.json(await lib.listCategories()));
    app.post("/library/categories", async (c) => {
      const b = await body<{ name?: string }>(c);
      if (!b?.name) return c.json({ error: "name is required" }, 400);
      return c.json(await lib.createCategory(b.name), 201);
    });
    app.post("/library/categories/reorder", async (c) => {
      const b = await body<{ orderedIds?: string[] }>(c);
      if (!b?.orderedIds) return c.json({ error: "orderedIds is required" }, 400);
      await lib.reorderCategories(b.orderedIds);
      return c.json({ ok: true });
    });
    app.patch("/library/categories/:id", async (c) => {
      const b = await body<{ name?: string }>(c);
      if (!b?.name) return c.json({ error: "name is required" }, 400);
      try { await lib.renameCategory(c.req.param("id"), b.name); return c.json({ ok: true }); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 404); }
    });
    app.delete("/library/categories/:id", async (c) => {
      await lib.deleteCategory(c.req.param("id"));
      return c.json({ ok: true });
    });

    // Import from bridge favorites — fetches all pages and bulk-adds to library
    app.post("/library/import/bridges/:id/favorites", (c) =>
      withContentBridge(c, async (bridge) => {
        if (!bridge.getFavorites) return c.json({ error: "bridge does not support favorites" }, 400);
        return c.json(await runtime!.importBridgeFavorites(c.req.param("id")));
      }),
    );

    // Entries
    app.post("/library/entries", async (c) => {
      const b = await body<{
        bridgeId?: string; seriesId?: string; title?: string; thumbnailUrl?: string;
        author?: string; categoryIds?: string[];
        externalIds?: Record<string, string | number>;
      }>(c);
      if (!b?.bridgeId || !b.seriesId) {
        return c.json({ error: "bridgeId and seriesId are required" }, 400);
      }
      try {
        const result = await runtime!.addToLibrary(b.bridgeId, b.seriesId, {
          ...(b.title !== undefined && { title: b.title }),
          ...(b.thumbnailUrl !== undefined && { thumbnailUrl: b.thumbnailUrl }),
          ...(b.author !== undefined && { author: b.author }),
          ...(b.categoryIds !== undefined && { categoryIds: b.categoryIds }),
          ...(b.externalIds !== undefined && { externalIds: b.externalIds }),
        });
        return c.json(result, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    });

    app.get("/library/entries/:bridgeId/:seriesId", async (c) => {
      const key = keyOf(c);
      const entry = await lib.getEntry(key);
      if (!entry) return c.json({ error: "not in library" }, 404);
      return c.json({ entry, progress: await lib.getProgress(key), resume: await lib.getResume(key) });
    });

    app.delete("/library/entries/:bridgeId/:seriesId", async (c) => {
      await lib.removeSeries(keyOf(c));
      return c.json({ ok: true });
    });

    app.put("/library/entries/:bridgeId/:seriesId/categories", async (c) => {
      const b = await body<{ categoryIds?: string[] }>(c);
      if (!b?.categoryIds) return c.json({ error: "categoryIds is required" }, 400);
      return withLibraryEntry(c, () => lib.setCategories(keyOf(c), b.categoryIds!));
    });

    app.post("/library/entries/:bridgeId/:seriesId/sync", async (c) => {
      const b = await body<{ chapters?: Chapter[] }>(c);
      if (!b?.chapters) return c.json({ error: "chapters is required" }, 400);
      return withLibraryEntry(c, () => lib.syncChapters(keyOf(c), b.chapters!));
    });

    app.get("/library/entries/:bridgeId/:seriesId/progress", async (c) =>
      c.json(await lib.getProgress(keyOf(c))),
    );

    app.put("/library/entries/:bridgeId/:seriesId/progress/:chapterId", async (c) => {
      const b = (await body<{ read?: boolean; lastPage?: number; pageCount?: number; chapterName?: string }>(c)) ?? {};
      const chapterId = c.req.param("chapterId");
      const bridgeId = c.req.param("bridgeId");
      const seriesId = c.req.param("seriesId");
      return withLibraryEntry(c, () => {
        if (b.lastPage !== undefined) {
          return runtime!.setProgress(bridgeId, seriesId, chapterId, b.lastPage, b.pageCount, b.chapterName);
        }
        return runtime!.markRead(bridgeId, seriesId, chapterId, b.read ?? true, b.chapterName);
      });
    });

    app.post("/library/entries/:bridgeId/:seriesId/read-up-to", async (c) => {
      const b = await body<{ chapters?: Chapter[]; chapterId?: string }>(c);
      if (!b?.chapters || !b.chapterId) return c.json({ error: "chapters and chapterId are required" }, 400);
      const bridgeId = c.req.param("bridgeId");
      const seriesId = c.req.param("seriesId");
      return withLibraryEntry(c, () => runtime!.markReadUpTo(bridgeId, seriesId, b.chapters!, b.chapterId!));
    });

    // Groups
    app.get("/library/groups", async (c) => c.json(await lib.listGroups()));

    app.post("/library/groups", async (c) => {
      const b = await body<{ memberKeys?: string[]; primaryKey?: string }>(c);
      if (!b?.memberKeys || !b.primaryKey) return c.json({ error: "memberKeys and primaryKey are required" }, 400);
      try { return c.json(await lib.createGroup(b.memberKeys, b.primaryKey), 201); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    });

    app.delete("/library/groups/:id", async (c) => {
      const groups = await lib.listGroups();
      const group = groups.find((g) => g.id === c.req.param("id"));
      if (!group) return c.json({ error: "group not found" }, 404);
      for (const key of group.memberKeys) await lib.leaveGroup(key);
      return c.json({ ok: true });
    });

    app.put("/library/groups/:id/primary", async (c) => {
      const b = await body<{ primaryKey?: string }>(c);
      if (!b?.primaryKey) return c.json({ error: "primaryKey is required" }, 400);
      try { await lib.setPrimarySource(c.req.param("id"), b.primaryKey); return c.json({ ok: true }); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 404); }
    });

    app.post("/library/entries/:bridgeId/:seriesId/join-group", async (c) => {
      const b = await body<{ groupId?: string }>(c);
      if (!b?.groupId) return c.json({ error: "groupId is required" }, 400);
      try { await lib.joinGroup(b.groupId, keyOf(c)); return c.json({ ok: true }); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    });

    app.delete("/library/entries/:bridgeId/:seriesId/leave-group", async (c) => {
      await lib.leaveGroup(keyOf(c));
      return c.json({ ok: true });
    });

    app.post("/library/sync", async (c) => c.json(await runtime!.backgroundSync()));

    // Tracker links — per-entry associations to external tracker services
    app.get("/library/entries/:bridgeId/:seriesId/tracker-links", async (c) =>
      c.json(await lib.listTrackerLinks(keyOf(c))),
    );

    app.post("/library/entries/:bridgeId/:seriesId/tracker-links", async (c) => {
      const b = await body<{ trackerId?: string; externalId?: string | number }>(c);
      if (!b?.trackerId || b.externalId === undefined) {
        return c.json({ error: "trackerId and externalId are required" }, 400);
      }
      return withLibraryEntry(c, () =>
        runtime!.linkTracker(c.req.param("bridgeId"), c.req.param("seriesId"), b.trackerId!, b.externalId!),
      );
    });

    app.delete("/library/entries/:bridgeId/:seriesId/tracker-links/:trackerId", async (c) => {
      await lib.unlinkTracker(keyOf(c), c.req.param("trackerId"));
      return c.json({ ok: true });
    });
  }

  // ── Tracker endpoints ─────────────────────────────────────────────────────────
  // Mounted only when a TrackerManager is provided.

  if (trackerMgr) {
    app.get("/trackers", async (c) => c.json(await trackerMgr.list()));

    app.get("/trackers/:id/settings", async (c) => {
      const id = c.req.param("id");
      try {
        const tracker = await trackerMgr.get(id);
        const settings = tracker.getSettings?.() ?? [];
        const stored = await trackerMgr.storedSettings(id);
        const secretKeys = new Set(settings.filter((d) => d.type === "string" && d.secret).map((d) => d.key));
        const values: Record<string, SettingValue> = {};
        const secretsSet: string[] = [];
        for (const [k, v] of Object.entries(stored)) {
          if (secretKeys.has(k)) { if (v !== undefined && v !== "") secretsSet.push(k); }
          else values[k] = v;
        }
        return c.json({ info: tracker.info, settings, values, secretsSet });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    });

    app.put("/trackers/:id/settings", async (c) => {
      const id = c.req.param("id");
      let b: Record<string, SettingValue>;
      try { b = await c.req.json<Record<string, SettingValue>>(); }
      catch { return c.json({ error: "invalid JSON" }, 400); }
      try {
        const updated = await trackerMgr.updateSettings(id, b);
        return c.json({ settings: updated });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    });

    app.get("/trackers/:id/search", async (c) => {
      const id = c.req.param("id");
      const q = c.req.query("q") ?? "";
      const page = Number(c.req.query("page") ?? "1");
      try {
        return c.json(await runtime!.searchTracker(id, q, page));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
      }
    });

    app.post("/trackers/:id/sync", async (c) => {
      const id = c.req.param("id");
      try {
        return c.json(await runtime!.syncFromTracker(id));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
      }
    });
  }

  // ── M4 Registry endpoints ──────────────────────────────────────────────────

  const reg = opts.registry;
  if (reg) {
    // List registries the user has added.
    app.get("/registries", async (c) => {
      return c.json(await reg.list());
    });

    // Add a registry by URL (GitHub link or any static URL).
    app.post("/registries", async (c) => {
      let body: { url: string; requireSignature?: boolean };
      try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
      if (!body.url) return c.json({ error: "url is required" }, 400);
      try {
        const addOpts: Parameters<typeof reg.add>[1] = {};
        if (body.requireSignature !== undefined) addOpts.requireSignature = body.requireSignature;
        const added = await reg.add(body.url, addOpts);
        return c.json(added, 201);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Remove a registry (orphans its installed bridges).
    app.delete("/registries/:encodedUrl", async (c) => {
      const url = decodeURIComponent(c.req.param("encodedUrl"));
      await reg.remove(url);
      manager.refresh();
      return c.json({ ok: true });
    });

    // Browse bridges available in a specific registry.
    app.get("/registries/:encodedUrl/bridges", async (c) => {
      const url = decodeURIComponent(c.req.param("encodedUrl"));
      try {
        return c.json(await reg.browse(url));
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Browse all bridges across all registries.
    app.get("/registry/bridges", async (c) => {
      return c.json(await reg.browseAll());
    });

    // Install a bridge from a registry.
    app.post("/registries/:encodedUrl/bridges/:id/install", async (c) => {
      const registryUrl = decodeURIComponent(c.req.param("encodedUrl"));
      const bridgeId = c.req.param("id");
      try {
        const result = await reg.install(registryUrl, bridgeId);
        manager.invalidate(bridgeId);
        return c.json(result, 201);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Update an installed bridge to its latest registry version (manual only).
    app.post("/bridges/:id/update", async (c) => {
      const bridgeId = c.req.param("id");
      try {
        const result = await reg.update(bridgeId);
        manager.invalidate(bridgeId);
        return c.json(result);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Uninstall a bridge installed from a registry.
    app.delete("/bridges/:id", async (c) => {
      const bridgeId = c.req.param("id");
      await reg.uninstall(bridgeId);
      manager.invalidate(bridgeId);
      return c.json({ ok: true });
    });

    // Check for available updates across all installed registry bridges.
    app.get("/registry/updates", async (c) => {
      return c.json(await reg.checkUpdates());
    });
  }

  return app;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function withBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: (bridge: Awaited<ReturnType<BridgeManager["get"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") as string;
  try {
    const bridge = await (c.get("manager") as BridgeManager).get(id);
    // `await` so a handler's async rejection (e.g. a bridge throwing "auth required") is caught
    // here and returned as a clean JSON error rather than a bare 500.
    return await fn(bridge);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }
}

/** Run a library mutation, mapping a missing-entry error to 404 and a void result to `{ ok: true }`. */
async function withLibraryEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await fn();
    return c.json(result === undefined ? { ok: true } : result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not in library") || msg.includes("not found") ? 404 : 500;
    return c.json({ error: msg }, code);
  }
}

/** Like `withBridge`, but refuses to dispatch a content call to a bridge missing required settings. */
async function withContentBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: (bridge: Awaited<ReturnType<BridgeManager["get"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") as string;
  const manager = c.get("manager") as BridgeManager;
  try {
    await manager.get(id); // surface load/orphan/404 errors via withBridge's handling below
    const missing = await manager.missingRequired(id);
    if (missing.length > 0) {
      return c.json({ error: `bridge not configured: missing ${missing.join(", ")}` }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
  }
  return withBridge(c, fn);
}
