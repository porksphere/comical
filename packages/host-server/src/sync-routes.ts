/**
 * The hub's HTTP face: `POST /push` and `POST /pull`, meant to be mounted at `/sync`. Kept apart from
 * `createRouter` so a desktop can expose these two routes on the LAN and nothing else.
 */
import { Hono } from "hono";
import { parsePullRequest, parseSegment, SeqConflictError, SeqGapError, type PushRefusal, type SyncBackend } from "@comical/sync";

export function createSyncRoutes(hub: SyncBackend): Hono {
  const app = new Hono();

  app.post("/push", async (c) => {
    const parsed = parseSegment(await c.req.json().catch(() => undefined));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      await hub.push(parsed.value);
    } catch (err) {
      if (err instanceof SeqConflictError || err instanceof SeqGapError) {
        const refusal: PushRefusal = {
          error: err instanceof SeqConflictError ? "seq-conflict" : "seq-gap",
          device: err.device,
          seq: err.seq,
          head: err.head,
        };
        return c.json(refusal, 409);
      }
      throw err;
    }
    return c.body(null, 204);
  });

  app.post("/pull", async (c) => {
    const parsed = parsePullRequest(await c.req.json().catch(() => undefined));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    return c.json(await hub.pull(parsed.value.have, parsed.value.limit));
  });

  return app;
}
