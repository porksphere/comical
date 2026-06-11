/**
 * On-demand Playwright capture for the browser demo.
 *
 *   bun run e2e:capture            # run all e2e specs, collect video + screenshots
 *   bun run e2e:capture "reader"   # only specs whose title matches (passed to playwright -g)
 *
 * Runs the Playwright CLI, then copies this run's video(s) and step screenshots into a timestamped
 * folder under e2e/.captures/ and prints their absolute paths. Artifacts are collected even when a
 * test fails — a failed run's recording is exactly what you want to look at. The CAPTURE_DIR= line at
 * the end is the marker the agent uses to find the files to send.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESULTS = join(ROOT, "e2e", ".test-results");
const CAPTURES = join(ROOT, "e2e", ".captures");

// Start clean so we only ever collect the current run's artifacts.
rmSync(RESULTS, { recursive: true, force: true });

const grep = process.argv.slice(2);
const args = ["playwright", "test", ...(grep.length ? ["-g", grep.join(" ")] : [])];
console.log(`▶ bunx ${args.join(" ")}\n`);
const run = spawnSync("bunx", args, { cwd: ROOT, stdio: "inherit", shell: true });

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(RESULTS);
const videos = files.filter((f) => f.endsWith(".webm"));
const shots = files.filter((f) => f.endsWith(".png")).sort();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest = join(CAPTURES, stamp);
mkdirSync(dest, { recursive: true });

// Playwright records VP8/webm, which several viewers (incl. the Claude app) won't play. Transcode to
// H.264 mp4 (yuv420p + faststart) for broad compatibility; fall back to copying the webm if ffmpeg
// isn't on PATH.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: true }).status === 0;

const collected: string[] = [];
let vi = 1;
for (const v of videos) {
  const base = videos.length > 1 ? `recording-${vi++}` : "recording";
  if (hasFfmpeg) {
    const to = join(dest, `${base}.mp4`);
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-i", v, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", to],
      { stdio: "ignore", shell: true },
    );
    if (r.status === 0) { collected.push(to); continue; }
    console.warn(`  (ffmpeg transcode failed for ${v}; falling back to webm)`);
  }
  const to = join(dest, `${base}.webm`);
  cpSync(v, to);
  collected.push(to);
}
for (const s of shots) {
  cpSync(s, join(dest, s.split(/[\\/]/).pop()!));
  collected.push(join(dest, s.split(/[\\/]/).pop()!));
}

console.log(`\n${run.status === 0 ? "✓ tests passed" : "✗ tests failed"} (exit ${run.status})`);
console.log(`Collected ${collected.length} artifact(s):`);
for (const f of collected) console.log("  " + f);
console.log("\nCAPTURE_DIR=" + dest);

// Always exit 0: the artifacts are the deliverable even when the underlying test failed.
process.exit(0);
