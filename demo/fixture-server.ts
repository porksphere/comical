/**
 * Standalone fixture backend server for the demo (serves the public-domain test library).
 * Listens on PORT (default 3200).
 */
import { FixtureBackend } from "@comical/testkit";

const port = Number(process.env.PORT ?? 3200);
const backend = new FixtureBackend();

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const res = backend.handle({ url: url.pathname + url.search });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
});
console.log(`Fixture backend running at http://localhost:${port}`);
