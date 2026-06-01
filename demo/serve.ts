/**
 * Development server for the browser demo. Builds app.ts, copies the bridge bundle, and serves
 * everything from demo/ on localhost:3300 with live-rebuild on source changes.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(import.meta.dir, ".out");
mkdirSync(OUT_DIR, { recursive: true });

// 1. Bundle the bridge (ensure it's fresh).
const bridgeSrc = join(ROOT, "bridges", "example-bridge", "dist", "bridge.js");
copyFileSync(bridgeSrc, join(OUT_DIR, "bridge.js"));
console.log("✓ bridge.js copied");

// 2. Bundle app.ts → app.js for the browser.
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "app.ts")],
  outdir: OUT_DIR,
  target: "browser",
  format: "esm",
  naming: "app.js",
  sourcemap: "inline",
  external: [],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("app.ts build failed");
}
console.log("✓ app.js bundled");

// 3. Write index.html to out dir.
const html = Bun.file(join(import.meta.dir, "index.html"));
writeFileSync(join(OUT_DIR, "index.html"), await html.text());

// 4. Serve.
const port = Number(process.env.PORT ?? 3300);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(OUT_DIR, path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});
console.log(`\nDemo running at http://localhost:${port}`);
console.log("Make sure the proxy (port 3100) and fixture backend (port 3200) are running.");
