/**
 * Development server for the browser demo. Builds app.ts and serves it on localhost:3300.
 * Watches demo/ for changes, rebuilds, and notifies the browser via SSE to live-reload.
 */
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(import.meta.dir, ".out");
mkdirSync(OUT_DIR, { recursive: true });

async function rebuild() {
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
  writeFileSync(join(OUT_DIR, "index.html"), await Bun.file(join(import.meta.dir, "index.html")).text());
  console.log("✓ app.js bundled");
}

await rebuild();

// SSE clients waiting for reload events.
const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function notifyReload() {
  const msg = new TextEncoder().encode("data: reload\n\n");
  for (const ctrl of reloadClients) {
    try { ctrl.enqueue(msg); } catch { reloadClients.delete(ctrl); }
  }
}

// Watch demo/ directory; debounce rebuilds to avoid thrash on rapid saves.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
watch(import.meta.dir, { recursive: true }, (_, filename) => {
  if (!filename) return;
  if (filename.startsWith(".out") || filename.startsWith("node_modules")) return;
  if (!filename.endsWith(".ts") && !filename.endsWith(".html")) return;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    try {
      await rebuild();
      notifyReload();
    } catch {}
  }, 150);
});

const RELOAD_SCRIPT = `<script>
  (function(){var es=new EventSource('/sse');es.onmessage=function(){location.reload()};})();
</script>`;

const port = Number(process.env.PORT ?? 3300);
Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/sse") {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { ctrl = c; reloadClients.add(ctrl); },
        cancel() { reloadClients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const file = Bun.file(join(OUT_DIR, path === "/" ? "index.html" : path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });

    if (path === "/" || path === "/index.html") {
      const html = (await file.text()).replace("</body>", `${RELOAD_SCRIPT}</body>`);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    return new Response(file);
  },
});
console.log(`\nDemo running at http://localhost:${port}`);
console.log("Ensure comical-server is running on :3100  (bun run demo:server)");
