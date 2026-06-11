import { defineConfig, devices } from "@playwright/test";

// On-demand e2e capture lane for the browser demo. This is intentionally separate from `bun test`
// (unit/conformance) — it runs via the Playwright CLI and exists to record what the demo does so a
// recording/screenshot can be sent back during remote sessions. See scripts/e2e-capture.ts.
const SERVER_PORT = 3100; // comical-server (demo:server)
const CLIENT_PORT = 3300; // browser demo UI (demo:dev)

export default defineConfig({
  testDir: "./e2e",
  // Use a *.e2e.ts pattern (not *.spec.ts) so `bun test` doesn't try to run these specs under its own
  // runner — Playwright's test() can't execute there.
  testMatch: "**/*.e2e.ts",
  outputDir: "./e2e/.test-results",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    video: "on", // always record — the recording is the deliverable
    screenshot: "only-on-failure", // explicit step screenshots live in the spec; this catches failures
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Boot both demo processes. reuseExistingServer:true means if you already have `demo:server` /
  // `demo:dev` running (the normal dev workflow), Playwright attaches to them instead of starting new
  // ones; otherwise it launches them for the duration of the run.
  webServer: [
    {
      command: "bun run demo:server",
      url: `http://localhost:${SERVER_PORT}/bridges`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "bun run demo:dev",
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
