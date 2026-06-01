/**
 * REST API router. Browser and app clients call these endpoints — they never load
 * bridge bundles or know what a bridge is internally.
 *
 * All bridge execution (fetching, parsing, rate-limiting) happens server-side.
 * The browser gets back clean JSON matching the @comical/contract models.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { RegistryManager } from "@comical/registry";
import type { BridgeManager } from "./bridge-manager.ts";

export interface RouterOptions {
  /** CORS origin(s) allowed. Defaults to '*' for LAN use. */
  origin?: string;
  /** Optional bearer token for simple auth. */
  token?: string;
  /** Registry manager — enables M4 registry endpoints. */
  registry?: RegistryManager;
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
    app.use("/bridges/*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== opts.token) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
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
      const settings = bridge.getSettings?.() ?? [];
      return c.json({ info: bridge.info, settings });
    });
  });

  /** Update user settings for a bridge (e.g. set baseUrl, credentials). */
  app.put("/bridges/:id/settings", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, string | boolean>;
    try {
      body = await c.req.json<Record<string, string | boolean>>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const updated = await (c.get("manager") as BridgeManager).updateSettings(id, body);
    return c.json({ settings: updated });
  });

  // ── Content endpoints ────────────────────────────────────────────────────────

  app.get("/bridges/:id/search", (c) =>
    withBridge(c, async (bridge) => {
      const q = c.req.query("q") ?? "";
      const page = Number(c.req.query("page") ?? "1");
      return c.json(await bridge.getSearchResults(q, page));
    }),
  );

  app.get("/bridges/:id/popular", (c) =>
    withBridge(c, async (bridge) => {
      if (!bridge.getPopular) return c.json({ error: "not supported" }, 400);
      const page = Number(c.req.query("page") ?? "1");
      return c.json(await bridge.getPopular(page));
    }),
  );

  app.get("/bridges/:id/latest", (c) =>
    withBridge(c, async (bridge) => {
      if (!bridge.getLatest) return c.json({ error: "not supported" }, 400);
      const page = Number(c.req.query("page") ?? "1");
      return c.json(await bridge.getLatest(page));
    }),
  );

  app.get("/bridges/:id/home", (c) =>
    withBridge(c, async (bridge) => {
      if (!bridge.getHomeSections) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getHomeSections());
    }),
  );

  app.get("/bridges/:id/filters", (c) =>
    withBridge(c, async (bridge) => {
      if (!bridge.getFilters) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getFilters());
    }),
  );

  app.get("/bridges/:id/tags", (c) =>
    withBridge(c, async (bridge) => {
      if (!bridge.getTags) return c.json({ error: "not supported" }, 400);
      return c.json(await bridge.getTags());
    }),
  );

  app.get("/bridges/:id/series/:seriesId", (c) =>
    withBridge(c, async (bridge) => {
      return c.json(await bridge.getSeriesDetails(c.req.param("seriesId")));
    }),
  );

  app.get("/bridges/:id/series/:seriesId/chapters", (c) =>
    withBridge(c, async (bridge) => {
      return c.json(await bridge.getChapters(c.req.param("seriesId")));
    }),
  );

  app.get("/bridges/:id/series/:seriesId/chapters/:chapterId/pages", (c) =>
    withBridge(c, async (bridge) => {
      return c.json(
        await bridge.getChapterPages(c.req.param("seriesId"), c.req.param("chapterId")),
      );
    }),
  );

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
    return fn(bridge);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 500);
  }
}
