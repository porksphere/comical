/**
 * Starts comical-server with the testkit fixture backend pre-configured for the demo.
 * Spins up the fixture backend, writes settings pointing at it, then calls comical-server.
 */
import { join } from "node:path";
import { SettingsStore } from "../packages/host-server/src/settings-store.ts";
import { createServer } from "../packages/host-server/src/server.ts";
import { FixtureBackend } from "../packages/testkit/src/index.ts";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, ".comical-demo");
const BRIDGES_DIR = join(ROOT, "bridges");

const fixture = new FixtureBackend().serve();
console.log(`Fixture backend running at ${fixture.url}`);

const settings = new SettingsStore(DATA_DIR);
await settings.set("example", { baseUrl: fixture.url });

const server = createServer({
  port: Number(process.env.PORT ?? 3100),
  bridgesDir: BRIDGES_DIR,
  dataDir: DATA_DIR,
  origin: "*",
});

console.log(`comical-server running at http://localhost:${server.port}`);
console.log("Now start the demo UI:  bun run demo:dev");
await new Promise(() => {});
