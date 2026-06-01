/**
 * Development server for the browser demo. Builds app.ts and serves it on localhost:3300.
 * The demo is now a thin REST client — it calls comical-server (port 3100) for all data.
 * No bridge bundle is loaded or executed in the browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(import.meta.dir, ".out");
mkdirSync(OUT_DIR, { recursive: true });

// Bundle app.ts → app.js for the browser.
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "app.ts")],
  outdir: OUT_DIR,
  target: "browser",
  format: "esm",
  naming: "app.js",
  sourcemap: "inline",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("app.ts build failed");
}
console.log("✓ app.js bundled");

// Copy index.html.
writeFileSync(join(OUT_DIR, "index.html"), await Bun.file(join(import.meta.dir, "index.html")).text());

// Serve.
const port = Number(process.env.PORT ?? 3300);
Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(OUT_DIR, path === "/" ? "index.html" : path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});
console.log(`\nDemo running at http://localhost:${port}`);
console.log("Ensure comical-server is running on :3100  (bun run demo:server)");
