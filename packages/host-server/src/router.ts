/**
 * REST API router. Browser and app clients call these endpoints — they never load
 * bridge bundles or know what a bridge is internally.
 *
 * All bridge execution (fetching, parsing, rate-limiting) happens server-side.
 * The browser gets back clean JSON matching the @comical/contract models.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bridgeSeriesStatusSchema, EXCLUDED_TAGS_KEY } from "@comical/contract";
import type { Chapter, FilterValue, ListOptions, SearchOptions, SettingValue } from "@comical/contract";
// Import from Node-free subpaths (not the `@comical/core` barrel, which registers the
// node:vm-backed default evaluator) so this router can also be bundled into non-Node hosts
// (e.g. comical-app's embedded runtime on Hermes). See @comical/core/index.ts.
import { BridgeSettingsError } from "@comical/core/errors";
import { validateSettingsInput } from "@comical/core/settings";
import { entryKey, type Library } from "@comical/library";
import type { DownloadChapterMeta, DownloadPageInput, Downloads, DownloadSeriesSnapshot } from "@comical/downloads";
import type { ComicalRuntime } from "@comical/runtime";
import type { BridgeProvider } from "./bridge-provider.ts";
import type { RegistryProvider } from "./registry-provider.ts";
import { TagLabelCache } from "./tag-label-cache.ts";
import type { TrackerProvider } from "./tracker-provider.ts";

export interface RouterOptions {
  /** CORS origin(s) allowed. Defaults to '*' for LAN use. */
  origin?: string;
  /**
   * Apply the CORS middleware (default true). Set false for in-process use (e.g. comical-app's
   * embedded runtime drives `router.fetch` directly): CORS is meaningless without a network origin,
   * and Hono's post-response header tweak re-wraps the Response via `new Response(res.body, …)` —
   * where `res.body` (a ReadableStream) is `null` under React Native, silently emptying the body.
   */
  cors?: boolean;
  /** Optional bearer token for simple auth. */
  token?: string;
  /** Registry manager — enables M4 registry endpoints. `RegistryManager` satisfies `RegistryProvider`. */
  registry?: RegistryProvider;
  /** Local library service — enables the optional `/library` tracking endpoints when provided. */
  library?: Library;
  /** Runtime orchestration layer — required alongside `library` for read-sync and richer addToLibrary. */
  runtime?: ComicalRuntime;
  /** Downloads service — enables the optional `/downloads` offline-manifest endpoints when provided. */
  downloads?: Downloads;
  /** Tracker manager — enables `/trackers` endpoints when provided. `TrackerManager` satisfies `TrackerProvider`. */
  trackers?: TrackerProvider;
  /** Base URL of this server, used as the OAuth callback redirect URI (e.g. "http://localhost:3100"). */
  callbackBaseUrl?: string;
}

// ── OAuth callback state ──────────────────────────────────────────────────────

interface PendingOAuth {
  trackerId: string;
  settingKey: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  exchangeUrl: string;
  refreshUrl?: string;
  expiresAt: number;
}
const pendingOAuth = new Map<string, PendingOAuth>();

type Bindings = Record<string, never>;
type Vars = { manager: BridgeProvider };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRouter(manager: BridgeProvider, opts: RouterOptions = {}): Hono<any> {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

  // Shared id→label memory so the host can fold tag names back into id-only responses (e.g.
  // `excludedTags`). Warms once for every client of this server. See TagLabelCache.
  const tagLabels = new TagLabelCache();

  if (opts.cors !== false) app.use("*", cors({
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use("/downloads/*", guard as any);
  }

  app.use("*", async (c, next) => {
    c.set("manager", manager);
    await next();
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/health", (c) => c.json({ ok: true }));

  // ── Test sprite sheet ────────────────────────────────────────────────────────
  // A local SVG sprite sheet used by the test-sprites bridge to verify CSS sprite
  // thumbnail rendering without any external CDN dependency.
  app.get("/test-sprite.svg", (c) => {
    const W = 200, H = 289, N = 20;
    let cells = "";
    for (let i = 0; i < N; i++) {
      const hue = Math.round((i * 360) / N);
      const x = i * W;
      cells +=
        `<rect x="${x}" y="0" width="${W}" height="${H}" fill="hsl(${hue},70%,55%)"/>` +
        `<text x="${x + W / 2}" y="${H / 2 + 22}" font-size="80" text-anchor="middle" fill="white" ` +
        `font-family="sans-serif" font-weight="bold">${i + 1}</text>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N * W}" height="${H}">${cells}</svg>`;
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
    });
  });

  // Variable-size companion sheet for the test-sprites bridge: a horizontal strip of
  // differently-proportioned tiles (mixed aspect ratios). Geometry MUST match the test-sprites
  // bridge's sheet: tile i width cycles 120/160/200/240/280, height cycles
  // 300/250/200/150, top-aligned in a strip whose natural height is the tallest tile (300).
  app.get("/test-sprite-var.svg", (c) => {
    const N = 20, SHEET_H = 300;
    let x = 0, cells = "";
    for (let i = 0; i < N; i++) {
      const w = 120 + (i % 5) * 40;
      const h = SHEET_H - (i % 4) * 50;
      const hue = Math.round((i * 360) / N);
      cells +=
        `<rect x="${x}" y="0" width="${w}" height="${h}" fill="hsl(${hue},70%,55%)"/>` +
        `<text x="${x + w / 2}" y="${h / 2 + 18}" font-size="${Math.round(Math.min(w, h) * 0.42)}" ` +
        `text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold">${21 + i}</text>`;
      x += w;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${SHEET_H}">${cells}</svg>`;
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
    });
  });

  // ── Image proxy ─────────────────────────────────────────────────────────────
  // Bridges emit server-relative `/img-proxy?url=…` URLs so a client never fetches a source's CDN
  // asset directly (avoids ad-blocker / content-filter interference, and lets an upstream-required
  // Referer be attached). This host hardcodes no source's hostnames: the allowlist is derived
  // entirely from the loaded bridges' `info.assetProxy` declarations, so which hosts may be proxied
  // (and with what Referer) is the bridges' data, not this router's.

  /** A matched allowlist host → the Referer to send upstream for it (undefined = send none). */
  interface ProxyRule {
    host: string;
    referer: string | undefined;
  }
  // Derived allowlist, memoized briefly: a series page can resolve dozens of thumbnails at once, and
  // the installed-bridge set changes rarely. A stale window only delays a just-installed bridge's
  // images by a few seconds (they retry); never a correctness issue.
  const PROXY_RULES_TTL_MS = 5000;
  let proxyRulesCache: { at: number; rules: ProxyRule[] } | null = null;
  const proxyRules = async (): Promise<ProxyRule[]> => {
    const now = Date.now();
    if (proxyRulesCache && now - proxyRulesCache.at < PROXY_RULES_TTL_MS) return proxyRulesCache.rules;
    const rules: ProxyRule[] = [];
    try {
      for (const b of await manager.list()) {
        const ap = b.info.assetProxy;
        if (!ap) continue;
        for (const host of ap.hosts) rules.push({ host: host.toLowerCase(), referer: ap.referer });
      }
    } catch {
      // A listing failure must not 500 image loads — fall back to an empty (deny-all) allowlist.
    }
    proxyRulesCache = { at: now, rules };
    return rules;
  };

  /** Match an absolute target URL against the derived allowlist. Returns the rule (for its Referer)
   *  or null → 403. Enforces http(s) and matches a host exactly or as a parent domain. */
  const matchProxyRule = (target: string, rules: ProxyRule[]): ProxyRule | null => {
    let host: string;
    try {
      const u = new URL(target);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      host = u.hostname.toLowerCase();
    } catch {
      return null;
    }
    return rules.find((r) => host === r.host || host.endsWith(`.${r.host}`)) ?? null;
  };

  /** Fetch `target` (optionally with a Referer) and return its bytes. Buffers the body rather than
   *  piping `r.body`: this router is also reused in-process by the on-device runtime
   *  (`@comical/host-rn`), where the RN fetch exposes no streaming `body` and `new Response(r.body,…)`
   *  would be silently empty. Reading bytes works on every host. */
  const proxyFetch = async (target: string, referer: string | undefined): Promise<Response> => {
    try {
      const r = await fetch(target, referer ? { headers: { Referer: referer } } : undefined);
      const bytes = await r.arrayBuffer();
      return new Response(bytes, {
        status: r.status,
        headers: {
          "Content-Type": r.headers.get("Content-Type") ?? "image/webp",
          "Cache-Control": "max-age=86400",
        },
      });
    } catch {
      return new Response("upstream error", { status: 502 });
    }
  };

  app.get("/img-proxy", async (c) => {
    const url = c.req.query("url") ?? "";
    // The host's own test-sprite sheet is same-origin (no external host, no allowlist needed).
    if (url === "/test-sprite.svg" || url === "/test-sprite-var.svg") {
      return proxyFetch(new URL(url, c.req.url).href, undefined);
    }
    const rule = matchProxyRule(url, await proxyRules());
    if (!rule) return c.text("Forbidden", 403);
    return proxyFetch(url, rule.referer);
  });

  // ── Bridge registry ──────────────────────────────────────────────────────────

  app.get("/bridges", async (c) => {
    const list = await c.get("manager").list();
    return c.json(list);
  });

  app.get("/bridges/:id", async (c) => {
    return withBridge(c, async (bridge) => {
      const manager = c.get("manager") as BridgeProvider;
      const settings = bridge.getSettings?.() ?? [];
      const missingRequired = await manager.missingRequired(bridge.info.id);

      // Return current stored values so a UI can prefill the form, but never expose secret
      // string values — instead report which secret keys are set.
      const stored = await manager.storedSettings(bridge.info.id);
      const secretKeys = new Set(
        settings.filter((d) => (d.type === "string" && !!d.secret) || d.type === "oauth-pin").map((d) => d.key),
      );
      const values: Record<string, SettingValue> = {};
      const secretsSet: string[] = [];
      for (const [k, v] of Object.entries(stored)) {
        if (k === EXCLUDED_TAGS_KEY) continue; // reserved host-managed key, surfaced separately
        if (secretKeys.has(k)) { if (v !== undefined && v !== "") secretsSet.push(k); }
        else values[k] = v;
      }

      const excludedTags = readExcludedTags(stored);
      return c.json({
        info: bridge.info,
        settings,
        values,
        secretsSet,
        missingRequired,
        configured: missingRequired.length === 0,
        excludedTags,
        // Names folded in from the shared cache (resolving cold ids via the bridge once, then
        // cached). The client renders `excludedTagLabels[id] ?? id`; storage stays id-only.
        excludedTagLabels: await tagLabels.resolve(bridge, excludedTags),
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
    const manager = c.get("manager") as BridgeProvider;
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

  /**
   * Replace the bridge's persistent tag exclusions (reserved key, separate from descriptor
   * settings so it sidesteps `validateSettingsInput`'s unknown-key rejection). Body: `{ tags: string[] }`.
   */
  app.put("/bridges/:id/excluded-tags", async (c) => {
    const id = c.req.param("id");
    let body: { tags?: unknown; labels?: unknown };
    try {
      body = await c.req.json<{ tags?: unknown; labels?: unknown }>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
      return c.json({ error: "expected { tags: string[] }" }, 400);
    }
    const tags = [...new Set(body.tags as string[])].filter((t) => t.trim().length > 0);
    // Optional `labels` (id→label) the client already holds — seed the cache so a later detail load
    // folds names in without a `resolveTags` round-trip. Tolerant of a missing/odd shape.
    if (body.labels && typeof body.labels === "object" && !Array.isArray(body.labels)) {
      tagLabels.remember(
        id,
        Object.entries(body.labels as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => ({ id: k, label: v as string })),
      );
    }
    const manager = c.get("manager") as BridgeProvider;
    try {
      await manager.get(id); // surface 404 for an unknown bridge before persisting
      const updated = await manager.updateSettings(id, { [EXCLUDED_TAGS_KEY]: tags });
      const excludedTags = readExcludedTags(updated);
      return c.json({ excludedTags, excludedTagLabels: tagLabels.known(id, excludedTags) });
    } catch (e) {
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
      const excluded = await excludedTagsFor(c, bridge);
      if (excluded.length) options.excludedTags = excluded;
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
      const excluded = await excludedTagsFor(c, bridge);
      if (excluded.length) options.excludedTags = excluded;
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
      const q = c.req.query("q") ?? "";
      return c.json(await bridge.getTags(q));
    }),
  );

  // ── Genre exclusions (capability "exclude-genres") — backend-account state, the bridge owns auth ──
  // Distinct from the host-stored, query-injected tag exclusions: the account is the source of truth,
  // so the host neither persists nor injects these — it just reads/writes through the bridge.

  app.get("/bridges/:id/genre-exclusions", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getGenreExclusions) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getGenreExclusions());
    }),
  );

  app.put("/bridges/:id/genre-exclusions", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.setExcludedGenres) return c.json({ error: "not supported" }, 400);
      let body: { genres?: unknown };
      try {
        body = await c.req.json<{ genres?: unknown }>();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }
      if (!Array.isArray(body.genres) || body.genres.some((g) => typeof g !== "string")) {
        return c.json({ error: "expected { genres: string[] }" }, 400);
      }
      const genres = [...new Set(body.genres as string[])].filter((g) => g.trim().length > 0);
      return c.json(await bridge.setExcludedGenres(genres));
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

  app.get("/bridges/:id/favorites/:seriesId", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getFavorites) return c.json({ error: "not supported" }, 400);
      const seriesId = c.req.param("seriesId");
      if (bridge.isFavorite) {
        return c.json({ favorited: await bridge.isFavorite(seriesId) });
      }
      const MAX_PAGES = 20;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await bridge.getFavorites(page);
        if (result.items.some((item) => item.id === seriesId)) return c.json({ favorited: true });
        if (!result.hasNextPage) break;
      }
      return c.json({ favorited: false });
    }),
  );

  app.get("/bridges/:id/series/:seriesId", (c) =>
    withContentBridge(c, async (bridge) => {
      const info = await bridge.getSeriesDetails(c.req.param("seriesId"));
      // Series detail is the one surface that pairs tag id + name — warm the cache for free so
      // later id→label folds (e.g. excluded tags) need no `resolveTags` call.
      for (const grp of info.tagGroups ?? []) {
        if (grp.tagIds) {
          tagLabels.remember(
            bridge.info.id,
            grp.tags.map((label, i) => ({ id: grp.tagIds![i] ?? "", label })).filter((p) => p.id),
          );
        }
      }
      return c.json(info);
    }),
  );

  app.get("/bridges/:id/series/:seriesId/related", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getRelatedSeries) return c.json([]);
      return c.json(await bridge.getRelatedSeries(c.req.param("seriesId")));
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

  // Lazy per-page image resolver: the bridge's getSeriesPages returns proxy URLs pointing here
  // instead of resolving every CDN URL upfront. The hash and gid-pagenum ref are embedded in
  // the URL so no server-side cache is needed between the two calls.
  app.get("/bridges/:id/series/:seriesId/page-image/:hash/:gidRef", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.resolvePage) return c.json({ error: "not supported" }, 404);
      const url = await bridge.resolvePage(
        c.req.param("seriesId"),
        c.req.param("hash"),
        c.req.param("gidRef"),
      );
      return Response.redirect(url, 302);
    }),
  );

  // Per-page lazy thumbnail resolver: returns the thumbnail descriptor for a single page as JSON.
  app.get("/bridges/:id/series/:seriesId/page-thumb/:pageIndex", (c) =>
    withContentBridge(c, async (bridge) => {
      if (!bridge.getPageThumbnail) return c.json({ error: "not supported" }, 404);
      const pageIndex = Number(c.req.param("pageIndex"));
      if (!Number.isFinite(pageIndex) || pageIndex < 0) return c.json({ error: "pageIndex must be a non-negative integer" }, 400);
      const thumbnail = await bridge.getPageThumbnail(c.req.param("seriesId"), Math.floor(pageIndex));
      return c.json(thumbnail);
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
  const body = async <T>(c: { req: { json: <U>() => Promise<U> } }): Promise<T | undefined> => {
    try { return await c.req.json<T>(); } catch { return undefined; }
  };

  const lib = opts.library;
  const runtime = opts.runtime;
  if (lib) {
    const keyOf = (c: { req: { param: (k: string) => string } }) =>
      entryKey(c.req.param("bridgeId"), c.req.param("seriesId"));

    app.get("/library", async (c) => {
      const list = c.req.query("list");
      const lists = c.req.query("lists");
      const q = c.req.query("q");
      const sort = c.req.query("sort");
      const dir = c.req.query("dir");
      const validSort = sort === "added" || sort === "title" || sort === "lastRead" || sort === "unread";
      return c.json(
        await lib.getLibrary({
          ...(list && { listId: list }),
          ...(lists && { listIds: lists.split(",").filter(Boolean) }),
          ...(c.req.query("unlisted") === "true" && { unlisted: true }),
          ...(q && { q }),
          ...(c.req.query("unreadOnly") === "true" && { unreadOnly: true }),
          ...(validSort && { sort: sort as "added" | "title" | "lastRead" | "unread" }),
          ...((dir === "asc" || dir === "desc") && { dir }),
        }),
      );
    });

    app.get("/library/history", async (c) => {
      const limit = c.req.query("limit");
      return c.json(await lib.getHistory(limit ? Number(limit) : undefined));
    });

    app.delete("/library/history/:bridgeId/:seriesId", async (c) => {
      await lib.clearHistoryEntry(c.req.param("bridgeId"), c.req.param("seriesId"));
      return c.json({ ok: true });
    });

    app.post("/reading-history", async (c) => {
      const b = await body<{ bridgeId?: string; seriesId?: string; title?: string; thumbnailUrl?: string; chapterId?: string; chapterName?: string; lastPage?: number; pageCount?: number; lastReadAt?: number }>(c);
      if (!b?.bridgeId || !b.seriesId || !b.title) return c.json({ error: "bridgeId, seriesId, title required" }, 400);
      await lib.recordRead({
        bridgeId: b.bridgeId,
        seriesId: b.seriesId,
        title: b.title,
        lastReadAt: b.lastReadAt ?? Date.now(),
        ...(b.thumbnailUrl !== undefined && { thumbnailUrl: b.thumbnailUrl }),
        ...(b.chapterId !== undefined && { lastReadChapterId: b.chapterId }),
        ...(b.chapterName !== undefined && { lastReadChapterName: b.chapterName }),
        ...(b.lastPage !== undefined && { lastPage: b.lastPage }),
        ...(b.pageCount !== undefined && { pageCount: b.pageCount }),
      });
      return c.json({ ok: true });
    });

    // Lists
    app.get("/library/lists", async (c) => c.json(await lib.getLists()));
    app.post("/library/lists", async (c) => {
      const b = await body<{ name?: string }>(c);
      if (!b?.name) return c.json({ error: "name is required" }, 400);
      return c.json(await lib.createList(b.name), 201);
    });
    app.post("/library/lists/reorder", async (c) => {
      const b = await body<{ orderedIds?: string[] }>(c);
      if (!b?.orderedIds) return c.json({ error: "orderedIds is required" }, 400);
      await lib.reorderLists(b.orderedIds);
      return c.json({ ok: true });
    });
    app.patch("/library/lists/:id", async (c) => {
      const b = await body<{ name?: string }>(c);
      if (!b?.name) return c.json({ error: "name is required" }, 400);
      try { await lib.renameList(c.req.param("id"), b.name); return c.json({ ok: true }); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 404); }
    });
    app.delete("/library/lists/:id", async (c) => {
      await lib.deleteList(c.req.param("id"));
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
        author?: string; listIds?: string[];
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
          ...(b.listIds !== undefined && { listIds: b.listIds }),
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

    app.put("/library/entries/:bridgeId/:seriesId/lists", async (c) => {
      const b = await body<{ listIds?: string[] }>(c);
      if (!b?.listIds) return c.json({ error: "listIds is required" }, 400);
      return withLibraryEntry(c, () => lib.setLists(keyOf(c), b.listIds!));
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
      const b = (await body<{ read?: boolean; lastPage?: number; pageCount?: number; chapterName?: string; number?: number }>(c)) ?? {};
      const chapterId = c.req.param("chapterId");
      const bridgeId = c.req.param("bridgeId");
      const seriesId = c.req.param("seriesId");
      return withLibraryEntry(c, () => {
        if (b.lastPage !== undefined) {
          return runtime!.setProgress(bridgeId, seriesId, chapterId, b.lastPage, b.pageCount, b.chapterName, b.number);
        }
        return runtime!.markRead(bridgeId, seriesId, chapterId, b.read ?? true, b.chapterName, b.number);
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

    // Activity feed — newly-detected chapters across the library (a "new chapters" news feed)
    app.get("/library/activity", async (c) => {
      const limit = c.req.query("limit");
      const unread = c.req.query("unread");
      return c.json(
        await lib.getActivity({
          ...(limit ? { limit: Number(limit) } : {}),
          ...(unread === "1" ? { unreadOnly: true } : {}),
        }),
      );
    });
    app.get("/library/activity/count", async (c) => c.json({ unread: await lib.unreadActivityCount() }));
    app.delete("/library/activity", async (c) => {
      await lib.clearActivity();
      return c.json({ ok: true });
    });

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

    // Bridge preferences — per-bridge user settings (e.g. disable tracker sync)
    app.get("/library/bridges/:bridgeId/prefs", async (c) =>
      c.json(await lib.getBridgePrefs(c.req.param("bridgeId"))),
    );

    app.put("/library/bridges/:bridgeId/prefs", async (c) => {
      const b = await body<{ trackersDisabled?: boolean; historyDisabled?: boolean }>(c);
      const update: { trackersDisabled?: boolean; historyDisabled?: boolean } = {};
      if (typeof b?.trackersDisabled === "boolean") update.trackersDisabled = b.trackersDisabled;
      if (typeof b?.historyDisabled === "boolean") update.historyDisabled = b.historyDisabled;
      if (Object.keys(update).length === 0) {
        return c.json({ error: "trackersDisabled or historyDisabled (boolean) is required" }, 400);
      }
      await lib.setBridgePrefs(c.req.param("bridgeId"), update);
      return c.json({ ok: true });
    });
  }

  // ── Downloads endpoints ────────────────────────────────────────────────────────
  // Mounted only when a Downloads service is provided. These manage the offline-download MANIFEST
  // (which chapters/pages are downloaded, their state and byte sizes); the image bytes themselves are
  // a client/host concern — this router does not fetch or serve page bytes.

  const downloads = opts.downloads;
  if (downloads) {
    const dlKeyOf = (c: { req: { param: (k: string) => string } }) =>
      entryKey(c.req.param("bridgeId"), c.req.param("seriesId"));

    // Storage-usage tree (total bytes + series → chapters breakdown) for the Downloads screen.
    app.get("/downloads", async (c) => c.json(await downloads.getStorageUsage()));

    // Chapters still needing bytes (the work queue a client drains).
    app.get("/downloads/pending", async (c) => c.json(await downloads.pendingChapters()));

    // Download preferences (wifiOnly / background).
    app.get("/downloads/prefs", async (c) => c.json(await downloads.getPrefs()));
    app.put("/downloads/prefs", async (c) => {
      const b = await body<{ wifiOnly?: boolean; background?: boolean }>(c);
      const current = await downloads.getPrefs();
      return c.json(
        await downloads.setPrefs({
          wifiOnly: typeof b?.wifiOnly === "boolean" ? b.wifiOnly : current.wifiOnly,
          background: typeof b?.background === "boolean" ? b.background : current.background,
        }),
      );
    });

    // One series' manifest (snapshot + its chapters).
    app.get("/downloads/entries/:bridgeId/:seriesId", async (c) => {
      const key = dlKeyOf(c);
      const series = await downloads.getSeries(key);
      if (!series) return c.json({ error: "series not downloaded" }, 404);
      const chapters = (await downloads.getStorageUsage()).bySeries.find(
        (s) => entryKey(s.bridgeId, s.seriesId) === key,
      )?.chapters;
      return c.json({ series, chapters: chapters ?? [] });
    });

    // Enqueue a chapter for download: body carries the series snapshot, chapter meta, and page list.
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId", async (c) => {
      const b = await body<{
        title?: string; thumbnailUrl?: string; author?: string;
        chapterName?: string; number?: number; languageCode?: string;
        pages?: DownloadPageInput[];
      }>(c);
      if (!b?.title || !b.pages) return c.json({ error: "title and pages are required" }, 400);
      const snap: DownloadSeriesSnapshot = {
        bridgeId: c.req.param("bridgeId"),
        seriesId: c.req.param("seriesId"),
        title: b.title,
        ...(b.thumbnailUrl !== undefined && { thumbnailUrl: b.thumbnailUrl }),
        ...(b.author !== undefined && { author: b.author }),
      };
      const meta: DownloadChapterMeta = {
        chapterId: c.req.param("chapterId"),
        ...(b.chapterName !== undefined && { chapterName: b.chapterName }),
        ...(b.number !== undefined && { number: b.number }),
        ...(b.languageCode !== undefined && { languageCode: b.languageCode }),
      };
      return c.json(await downloads.enqueueChapter(snap, meta, b.pages), 201);
    });

    // Record one page's downloaded bytes (client writes the blob, then reports its file + size).
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/pages/:index", async (c) => {
      const b = await body<{ file?: string; bytes?: number }>(c);
      if (typeof b?.file !== "string" || typeof b.bytes !== "number") {
        return c.json({ error: "file (string) and bytes (number) are required" }, 400);
      }
      return withDownloadsEntry(c, () =>
        downloads.recordPage(dlKeyOf(c), c.req.param("chapterId"), Number(c.req.param("index")), b.file!, b.bytes!),
      );
    });

    // Mark one page failed (the client gave up fetching it) — surfaces the chapter as `failed`.
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/pages/:index/fail", async (c) =>
      withDownloadsEntry(c, () =>
        downloads.failPage(dlKeyOf(c), c.req.param("chapterId"), Number(c.req.param("index"))),
      ),
    );

    // The ordered page list (manifest) for a chapter — the offline page-LIST fallback.
    app.get("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/pages", async (c) =>
      c.json(await downloads.getManifestPages(dlKeyOf(c), c.req.param("chapterId"))),
    );

    // Re-queue the missing pages of a partial/failed chapter (resumable retry).
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/requeue", async (c) =>
      withDownloadsEntry(c, () => downloads.requeueMissing(dlKeyOf(c), c.req.param("chapterId"))),
    );

    // Pause (cancel) / resume — chapter and whole-series. Pausing keeps the bytes already fetched.
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/pause", async (c) =>
      withDownloadsEntry(c, () => downloads.pauseChapter(dlKeyOf(c), c.req.param("chapterId"))),
    );
    app.post("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId/resume", async (c) =>
      withDownloadsEntry(c, () => downloads.resumeChapter(dlKeyOf(c), c.req.param("chapterId"))),
    );
    app.post("/downloads/entries/:bridgeId/:seriesId/pause", async (c) =>
      withDownloadsEntry(c, () => downloads.pauseSeries(dlKeyOf(c))),
    );
    app.post("/downloads/entries/:bridgeId/:seriesId/resume", async (c) =>
      withDownloadsEntry(c, () => downloads.resumeSeries(dlKeyOf(c))),
    );

    // Deletion — returns the on-disk `file` paths the client should remove.
    app.delete("/downloads/entries/:bridgeId/:seriesId/chapters/:chapterId", async (c) =>
      c.json({ files: await downloads.deleteChapter(dlKeyOf(c), c.req.param("chapterId")) }),
    );
    app.delete("/downloads/entries/:bridgeId/:seriesId", async (c) =>
      c.json({ files: await downloads.deleteSeries(dlKeyOf(c)) }),
    );
    app.delete("/downloads", async (c) => c.json({ files: await downloads.deleteAll() }));
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
        const secretKeys = new Set(settings.filter((d) => (d.type === "string" && !!d.secret) || d.type === "oauth-pin" || d.type === "oauth-callback").map((d) => d.key));
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
        // For oauth-pin fields with an exchange config, swap the authorization code for a token.
        const tracker = await trackerMgr.get(id).catch(() => null);
        if (tracker) {
          const descriptors = tracker.getSettings?.() ?? [];
          for (const d of descriptors) {
            if (d.type !== "oauth-pin" || !d.exchange) continue;
            const code = b[d.key];
            if (typeof code !== "string" || !code) continue;
            const { url, clientId, clientSecret, redirectUri } = d.exchange;
            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code }),
            });
            if (!resp.ok) return c.json({ error: `OAuth exchange failed: ${resp.status} ${resp.statusText}` }, 502);
            const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
            if (!data.access_token) return c.json({ error: "OAuth exchange returned no access_token" }, 502);
            // Store as a blob so the refresh token and expiry survive restarts.
            const blob: Record<string, unknown> = { access: data.access_token };
            if (data.refresh_token) blob.refresh = data.refresh_token;
            if (data.expires_in) blob.expiresAt = Date.now() + data.expires_in * 1000;
            b[d.key] = JSON.stringify(blob);
          }
        }
        const updated = await trackerMgr.updateSettings(id, b);
        return c.json({ settings: updated });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    });

    app.post("/trackers/:id/oauth-start", async (c) => {
      const trackerId = c.req.param("id");
      const b = await body<{ key?: string; settings?: Record<string, string> }>(c);
      if (!b?.key) return c.json({ error: "key required" }, 400);
      try {
        const tracker = await trackerMgr.get(trackerId);
        const desc = (tracker.getSettings?.() ?? []).find((d) => d.key === b.key);
        if (!desc || desc.type !== "oauth-callback") return c.json({ error: "not an oauth-callback field" }, 400);

        const stored = await trackerMgr.storedSettings(trackerId);
        const resolve = (key?: string, fallback?: string) =>
          key ? String(b.settings?.[key] ?? stored[key] ?? "") : (fallback ?? "");
        const clientId = resolve(desc.exchange.clientIdKey, desc.exchange.clientId);
        if (!clientId) return c.json({ error: "client_id not configured — save settings first" }, 400);
        const clientSecret = resolve(desc.exchange.clientSecretKey, desc.exchange.clientSecret);

        const state = crypto.randomUUID().replace(/-/g, "");
        let codeVerifier = "";
        if (desc.exchange.pkce) {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          codeVerifier = btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "").slice(0, 43);
        }

        const callbackUrl = `${opts.callbackBaseUrl ?? "http://localhost:3100"}/oauth/callback`;
        const authUrl = desc.authUrlTemplate
          .replace("{clientId}", encodeURIComponent(clientId))
          .replace("{pkce}", encodeURIComponent(codeVerifier))
          .replace("{callbackUrl}", encodeURIComponent(callbackUrl))
          .replace("{state}", encodeURIComponent(state));

        // Prune stale entries then register this one.
        for (const [s, p] of pendingOAuth) { if (p.expiresAt < Date.now()) pendingOAuth.delete(s); }
        const pending: PendingOAuth = {
          trackerId, settingKey: b.key, clientId, codeVerifier,
          exchangeUrl: desc.exchange.url,
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        if (clientSecret) pending.clientSecret = clientSecret;
        if (desc.exchange.refreshUrl) pending.refreshUrl = desc.exchange.refreshUrl;
        pendingOAuth.set(state, pending);

        return c.json({ authUrl });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, msg.includes("not found") ? 404 : 500);
      }
    });

    app.get("/oauth/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const htmlErr = (msg: string, status = 400) =>
        c.html(`<!DOCTYPE html><html><body><h2>OAuth error</h2><pre>${msg.replace(/</g, "&lt;")}</pre></body></html>`, status as 400 | 500 | 502);

      if (!code || !state) return htmlErr("Missing code or state parameter.");
      const pending = pendingOAuth.get(state);
      if (!pending || pending.expiresAt < Date.now()) { pendingOAuth.delete(state); return htmlErr("Expired or unknown state — please try connecting again."); }
      pendingOAuth.delete(state);

      const callbackUrl = `${opts.callbackBaseUrl ?? "http://localhost:3100"}/oauth/callback`;
      const params: Record<string, string> = {
        grant_type: "authorization_code",
        client_id: pending.clientId,
        code,
        redirect_uri: callbackUrl,
      };
      if (pending.clientSecret) params.client_secret = pending.clientSecret;
      if (pending.codeVerifier) params.code_verifier = pending.codeVerifier;

      try {
        const resp = await fetch(pending.exchangeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams(params).toString(),
        });
        if (!resp.ok) { const t = await resp.text(); return htmlErr(`Exchange failed (${resp.status}): ${t}`, 502); }
        const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (!data.access_token) return htmlErr("Exchange response missing access_token.", 502);

        const blob: Record<string, unknown> = { access: data.access_token };
        if (data.refresh_token) blob.refresh = data.refresh_token;
        if (data.expires_in) blob.expiresAt = Date.now() + data.expires_in * 1000;
        await trackerMgr.updateSettings(pending.trackerId, { [pending.settingKey]: JSON.stringify(blob) });

        return c.html(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
          <h2>&#10003; Connected!</h2><p>You can close this tab and return to Comical.</p>
          <script>if(window.opener)window.opener.postMessage({type:'comical-oauth-complete'},'*');window.close();</script>
          </body></html>`);
      } catch (e) {
        return htmlErr(e instanceof Error ? e.message : String(e), 500);
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

    // ── Tracker registry endpoints ──────────────────────────────────────────

    // Browse all trackers across all added registries.
    app.get("/registry/trackers", async (c) => {
      return c.json(await reg.browseAllTrackers());
    });

    // Browse trackers in a specific registry.
    app.get("/registries/:encodedUrl/trackers", async (c) => {
      const url = decodeURIComponent(c.req.param("encodedUrl"));
      try {
        return c.json(await reg.browseTrackers(url));
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Install a tracker from a registry.
    app.post("/registries/:encodedUrl/trackers/:id/install", async (c) => {
      const registryUrl = decodeURIComponent(c.req.param("encodedUrl"));
      const trackerId = c.req.param("id");
      try {
        const result = await reg.installTracker(registryUrl, trackerId);
        trackerMgr?.invalidate(trackerId);
        return c.json(result, 201);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Update a tracker to its latest registry version.
    app.post("/trackers/:id/update", async (c) => {
      const trackerId = c.req.param("id");
      try {
        const result = await reg.updateTracker(trackerId);
        trackerMgr?.invalidate(trackerId);
        return c.json(result);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    });

    // Uninstall a registry-installed tracker.
    app.delete("/trackers/:id", async (c) => {
      const trackerId = c.req.param("id");
      await reg.uninstallTracker(trackerId);
      trackerMgr?.invalidate(trackerId);
      return c.json({ ok: true });
    });

    // Check for available tracker updates.
    app.get("/registry/tracker-updates", async (c) => {
      return c.json(await reg.checkTrackerUpdates());
    });
  }

  return app;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function withBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: (bridge: Awaited<ReturnType<BridgeProvider["get"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") as string;
  try {
    const bridge = await (c.get("manager") as BridgeProvider).get(id);
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

/** Run a downloads mutation, mapping a missing-series/chapter error to 404 and a void result to `{ ok: true }`. */
async function withDownloadsEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await fn();
    return c.json(result === undefined ? { ok: true } : result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("not downloaded") || msg.includes("not found") ? 404 : 500;
    return c.json({ error: msg }, code);
  }
}

/** The persisted tag exclusions from a stored-settings map (reserved key, tolerant of bad shapes). */
function readExcludedTags(stored: Record<string, SettingValue>): string[] {
  const v = stored[EXCLUDED_TAGS_KEY];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Tag exclusions to inject for a content call — empty unless the bridge advertises `"exclude-tags"`,
 * so a non-capable bridge never sees them and the result path stays untouched.
 */
async function excludedTagsFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  bridge: Awaited<ReturnType<BridgeProvider["get"]>>,
): Promise<string[]> {
  if (!bridge.info.capabilities?.includes("exclude-tags")) return [];
  const stored = await (c.get("manager") as BridgeProvider).storedSettings(bridge.info.id);
  return readExcludedTags(stored);
}

/** Like `withBridge`, but refuses to dispatch a content call to a bridge missing required settings. */
async function withContentBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  fn: (bridge: Awaited<ReturnType<BridgeProvider["get"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") as string;
  const manager = c.get("manager") as BridgeProvider;
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
