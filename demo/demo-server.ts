/**
 * Starts comical-server with the testkit fixture backend pre-configured for the demo.
 * Spins up the fixture backend, writes settings pointing at it, then calls comical-server.
 */
import { existsSync, utimesSync, watch } from "node:fs";
import { join } from "node:path";
import { SettingsStore } from "../packages/host-server/src/settings-store.ts";
import { createServer } from "../packages/host-server/src/server.ts";
import { DirectFixtureBackend, FixtureBackend } from "../packages/testkit/src/index.ts";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, ".comical-demo");
const BRIDGES_DIRS = [
  join(ROOT, "bridges"),
  join(ROOT, "..", "example-bridge-repo", ".build"),
];
const TRACKERS_DIR = join(ROOT, "..", "comical-trackers", ".build");

const fixture = new FixtureBackend().serve();
console.log(`Fixture backend running at ${fixture.url}`);

const directFixture = new DirectFixtureBackend().serve();
console.log(`Direct fixture backend running at ${directFixture.url}`);

const settings = new SettingsStore(DATA_DIR);
await settings.set("example", { baseUrl: fixture.url });
await settings.set("direct-example", { baseUrl: directFixture.url });

const server = createServer({
  port: Number(process.env.PORT ?? 3100),
  bridgesDir: BRIDGES_DIRS,
  dataDir: DATA_DIR,
  origin: "*",
  library: true,
  trackersDir: TRACKERS_DIR,
});

console.log(`comical-server running at http://localhost:${server.port}`);
console.log("Now start the demo UI:  bun run demo:dev");

// Watch bridge and tracker build dirs. These .js files live outside this script's
// module graph, so bun --watch can't see them directly. On any .js change, touch this
// entrypoint's mtime — that IS in bun --watch's graph, so it triggers a clean restart.
// (process.exit(0) does NOT restart: bun --watch reloads on file change, not self-exit.)
// Ignore events in the first 2 s to avoid spurious Windows fs.watch notifications on startup.
const watchReadyAt = Date.now() + 2000;
let restarting = false;
for (const dir of [...BRIDGES_DIRS, TRACKERS_DIR].filter((d) => existsSync(d))) {
  watch(dir, { recursive: true }, (_, filename) => {
    if (filename?.endsWith(".js") && Date.now() >= watchReadyAt && !restarting) {
      restarting = true;
      console.log(`[watch] ${filename} changed — restarting`);
      const now = new Date();
      utimesSync(import.meta.path, now, now);
    }
  });
}

await new Promise(() => {});
