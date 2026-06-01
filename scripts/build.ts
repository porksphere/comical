/**
 * Bundles every bridge in `bridges/*` into a single portable ESM artifact
 * (`bridges/<id>/dist/bridge.js`) using Bun's bundler.
 *
 * Bridges are the only thing that must be pre-bundled: the runtime loads exactly
 * one file per bridge into a sandboxed JS context. The `packages/*` libraries run
 * directly under Bun (no build step needed) and are typechecked with `tsc --build`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BRIDGES_DIR = join(ROOT, "bridges");

async function listBridges(): Promise<string[]> {
  const entries = await readdir(BRIDGES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function buildBridge(id: string): Promise<void> {
  const entry = join(BRIDGES_DIR, id, "src", "index.ts");
  const outdir = join(BRIDGES_DIR, id, "dist");

  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser", // engine-agnostic output: no Bun/Node builtins
    format: "cjs", // self-contained CJS: loaded via the core's node:vm sandbox
    naming: "bridge.js",
    minify: false,
    sourcemap: "external",
  });

  if (!result.success) {
    console.error(`✗ bridge "${id}" failed to build`);
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, `bridge build failed: ${id}`);
  }
  console.log(`✓ bridge "${id}" → ${join("bridges", id, "dist", "bridge.js")}`);
}

const bridges = await listBridges();
if (bridges.length === 0) {
  console.log("No bridges to build.");
} else {
  for (const id of bridges) await buildBridge(id);
  console.log(`\nBuilt ${bridges.length} bridge(s).`);
}
