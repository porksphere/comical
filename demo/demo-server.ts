/**
 * Starts comical-server with the testkit fixture backend pre-configured for the demo.
 * Spins up the fixture backend, writes settings pointing at it, then calls comical-server.
 */
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
});

console.log(`comical-server running at http://localhost:${server.port}`);
console.log("Now start the demo UI:  bun run demo:dev");
await new Promise(() => {});
