/**
 * Fails when README.md's package reference and `packages/*` disagree — a package that was added,
 * removed, or renamed without the docs following. Run in CI (`bun run check:readme`).
 *
 * The README lists packages as `@comical/<name>` (npm-scoped) or as a bare `host-ios` /
 * `host-android` directory (the native hosts, consumed by source). Both forms count.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const readme = await readFile(join(ROOT, "README.md"), "utf8");

const onDisk = new Set(
  (await readdir(join(ROOT, "packages"), { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name),
);

// Only the "Package reference" section counts as the list; the rest of the README may mention a
// package in passing (or in prose about one that was removed) without that being a listing.
const section = readme.split(/^## Package reference$/m)[1]?.split(/^## /m)[0];
if (!section) {
  console.error("check-readme-packages: README.md has no '## Package reference' section");
  process.exit(1);
}
const listed = new Set<string>();
for (const m of section.matchAll(/^\| `(?:@comical\/)?([a-z0-9-]+)`/gm)) listed.add(m[1]!);

const missing = [...onDisk].filter((p) => !listed.has(p)).sort();
const stale = [...listed].filter((p) => !onDisk.has(p)).sort();

if (missing.length || stale.length) {
  if (missing.length) console.error(`README package reference is missing: ${missing.join(", ")}`);
  if (stale.length) console.error(`README package reference lists packages that don't exist: ${stale.join(", ")}`);
  process.exit(1);
}
console.log(`check-readme-packages: ${onDisk.size} packages, README in sync`);
