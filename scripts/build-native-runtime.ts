/**
 * Bundles the shared native runtime (@comical/host-native) into the per-platform asset each native
 * host evaluates: the iOS JSC harness and the Android QuickJS harness.
 *
 * Output is a classic script (IIFE — no import/export/import.meta) targeting the browser profile, so
 * it carries no Node builtins. It installs the comical_init/comical_call globals the Swift/Kotlin
 * layers call. The asset filenames are kept stable so those native resource lookups are untouched.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "packages", "host-native", "src");

const targets = [
  {
    entry: join(SRC, "entry-jsc.ts"),
    outdir: join(ROOT, "packages", "host-ios", "Sources", "ComicalHostIOS", "Resources"),
    name: "harness.js",
  },
  {
    entry: join(SRC, "entry-quickjs.ts"),
    outdir: join(ROOT, "packages", "host-android", "src", "main", "assets"),
    name: "comical_harness.js",
  },
];

for (const t of targets) {
  const result = await Bun.build({
    entrypoints: [t.entry],
    outdir: t.outdir,
    target: "browser", // engine-agnostic: no Node builtins
    format: "iife", // classic script: side effects run on evaluate, no module syntax
    naming: t.name,
    external: ["node:vm"], // never reached (NativeContextEvaluator is used), kept off the graph
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, `native runtime build failed: ${t.name}`);
  }
  console.log(`✓ ${t.name} → ${join(t.outdir, t.name)}`);
}

console.log("\nBuilt native runtime assets.");
