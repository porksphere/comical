# @comical/testkit

The shared **test framework** for Comical bridges: a legal fixture backend, a mock host, network
record/replay cassettes, and a reusable **conformance + metrics evaluator** you can point at either
a fixture or a real, live backend.

Two audiences use it:

- **Bridge authors / this monorepo** — unit-test a bridge against fixtures and cassettes (offline,
  deterministic), and gate CI on a strict conformance check.
- **Downstream bridge repos** (e.g. a standalone bridge registry) — run the *same* evaluator against
  the **real** site on a schedule to catch regressions and drift (e.g. cover-image sizes), tolerating
  flaky/blocked sites instead of going red.

---

## What's in the box

| Export | What it's for |
|--------|---------------|
| `evaluateBridge(bridge, opts)` | Run every applicable probe, get a structured **report** (never throws on a bridge failure — failures are data). |
| `runConformance(bridge, opts)` | Strict gate: same probes, but **throws on the first `fail`**. Use in `bun test`. |
| `isTransientError(e)` | Heuristic: was a thrown error a transient/blocked-network condition (Cloudflare, 403/429, timeout) vs. a real logic bug? Drives warn-vs-fail. |
| `measureThumbnails(items, fetchAsset, opts)` / `parseImageSize(bytes)` | Sample cover images and report byte size + dimensions. Also runs automatically inside `evaluateBridge` when you pass `fetchAsset`. |
| `defaultAssetFetcher` | A live `fetch`-based `AssetFetcher` for real runs. |
| `FixtureBackend` / `DirectFixtureBackend` | Public-domain demo catalogs that answer bridge HTTP calls offline. |
| `mockHost(opts)` / `fixtureHost(backend, settings)` | Build a `HostCapabilities` (network/storage/log/settings) for evaluation. |
| `recordingNetwork(net, sink)` / `replayNetwork(cassette)` | Capture live traffic once, then replay it deterministically in tests. |

Everything is re-exported from the package root — `import { … } from "@comical/testkit"`.

---

## Setup

Not published to npm — it's a workspace package resolved by path. Two ways in:

**A. Inside the `comical` monorepo** — it's already a workspace package. Add it as a dev dep and
import:

```jsonc
// packages/…/package.json
"devDependencies": { "@comical/testkit": "workspace:*" }
```

**B. A sibling repo (your own bridge repo next to `comical`)** — no publish step; point TypeScript's
`paths` at the source, exactly like the other `@comical/*` packages. Keep the two repos side by side:

```
../
├── comical/          # this monorepo (provides @comical/core, @comical/testkit, …)
└── your-bridge-repo/
```

```jsonc
// your-bridge-repo/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@comical/contract": ["../comical/packages/contract/src/index.ts"],
      "@comical/core":     ["../comical/packages/core/src/index.ts"],
      "@comical/testkit":  ["../comical/packages/testkit/src/index.ts"]
    }
  }
}
```

Bun resolves these paths directly from source — no build of `comical` required.

---

## Usage

### 1. Unit-test a bridge against fixtures (offline, deterministic)

Point the bridge at a fixture backend via `fixtureHost`, then gate on `runConformance`:

```ts
import { test } from "bun:test";
import { loadBridge } from "@comical/core";
import { fixtureHost, FixtureBackend, runConformance } from "@comical/testkit";

test("my-bridge conforms", async () => {
  const capabilities = fixtureHost(new FixtureBackend());
  const bridge = loadBridge({ code: myBundle, capabilities });
  await runConformance(bridge, { searchQuery: "the" }); // throws on first fail
});
```

### 2. Inspect results without throwing

`evaluateBridge` returns the full report — every check with its `severity` (`pass`/`warn`/`fail`), a
per-capability summary, and a `verdict`. Warnings never fail the verdict.

```ts
const report = await evaluateBridge(bridge, { searchQuery: "the" });
report.summary; // { pass, warn, fail, capabilitiesDeclared, capabilitiesExercised, verdict }
report.results.filter((r) => r.severity !== "pass"); // what to look at
```

### 3. Live audit against the real backend, with cover-size metrics

Pass `fetchAsset` and the evaluator additionally samples the exercised items' `thumbnailUrl`s and
attaches `report.metrics` — average/median bytes, dimensions, and aspect. This is how you catch a
bridge silently serving full-res covers instead of thumbnails.

```ts
import { evaluateBridge, defaultAssetFetcher } from "@comical/testkit";

const report = await evaluateBridge(bridge, {
  searchQuery: "spy",
  fetchAsset: defaultAssetFetcher, // live fetch; omit ⇒ no metrics
  assetSampleSize: 8,              // distinct thumbnails to sample (default 8)
});

report.metrics?.bytes;      // { min, max, avg, median, total }
report.metrics?.dimensions; // { avgWidth, avgHeight, maxWidth, maxHeight }
```

### 4. Tolerate flaky / blocked sites (don't go red on Cloudflare)

Against real backends, some sites Cloudflare-wall or rate-limit datacenter (CI runner) IPs even
though they work from a phone. `evaluateBridge` already downgrades a **transient** throw to `warn`
(via `isTransientError`) so a blocked capability reads ⚠, not ✗ — a real parse/logic error still
`fail`s. For a per-bridge "known flaky, tolerate even hard failures" policy, keep a small config in
your own repo and decide the run's exit code from the report:

```ts
const flaky = new Set(["some-source", "other-source"]); // bridge ids known to block runner IPs
const hardFail = report.summary.verdict === "fail" && !flaky.has(report.bridgeId);
process.exit(hardFail ? 1 : 0);
```

A complete, working example of a live nightly audit — loading built bundles, measuring covers,
rendering a status table into a README, and tagging flaky bridges — lives in the **`comical-bridges`**
repo as `audit.ts` + `audit.config.ts`. It's the canonical reference for pattern 3 + 4.

### 5. Record once, replay forever (cassettes)

Wrap a live network capability with `recordingNetwork` to capture traffic into a cassette, then
commit it and replay with `replayNetwork` so the test is deterministic and offline:

```ts
import { recordingNetwork, replayNetwork } from "@comical/testkit";

// record (once, against live):
const sink = [];
const liveNet = recordingNetwork(realNetwork, sink);
// … drive the bridge … then persist `{ entries: sink }` to a .json cassette

// replay (in CI):
const net = replayNetwork(cassette);
```

---

## API reference

### `evaluateBridge(bridge, options?) → Promise<EvaluationReport>`
### `runConformance(bridge, options?) → Promise<ConformanceReport>` (throws on first `fail`)

```ts
interface ConformanceOptions {
  searchQuery?: string;      // a query expected to return ≥1 result from the wired backend
  fetchAsset?: AssetFetcher; // provide ⇒ report.metrics is populated (pass defaultAssetFetcher live)
  assetSampleSize?: number;  // distinct thumbnails to sample for metrics (default 8)
}

interface EvaluationReport {
  bridgeId: string;
  results: CheckResult[];          // { id, capability, severity, message }
  summary: EvaluationSummary;      // pass/warn/fail counts, capabilities*, verdict
  sampledSeriesId?: string;
  sampledChapterId?: string;
  metrics?: AssetMetrics;          // present only when fetchAsset was given
}
```

### `measureThumbnails(items, fetchAsset, { sampleSize? }) → Promise<AssetMetrics>`

```ts
type AssetFetcher = (url: string) => Promise<AssetSample | undefined>;

interface AssetMetrics {
  sampled: number;                 // fetched + measured
  failed: number;                  // failed to fetch
  bytes: { min: number; max: number; avg: number; median: number; total: number };
  dimensions?: { avgWidth: number; avgHeight: number; maxWidth: number; maxHeight: number };
  aspect?: { min: number; max: number; avg: number };
  samples: AssetSample[];
}
```

`parseImageSize(bytes)` reads JPEG/PNG/WebP/GIF headers → `{ width, height, format }` (or `undefined`),
without decoding the whole image.

### `isTransientError(e) → boolean`

`true` for blocked/transient network conditions (Cloudflare "just a moment", HTTP 403/429/503, `fetch
failed`, `ETIMEDOUT`, DNS `ENOTFOUND`, …); `false` for real logic/parse/assertion errors.

---

## Design notes

- **Failures are data, not exceptions.** `evaluateBridge` collects results; only `runConformance`
  throws. This is what lets a downstream audit surface warnings and decide its own exit policy.
- **Transport-agnostic metrics.** The evaluator never calls `fetch` itself — you inject an
  `AssetFetcher`. That keeps the harness usable in environments with no global `fetch` and makes the
  live-vs-offline choice explicit.
- **Warnings never fail a verdict.** `summary.verdict` is `fail` iff some check is `fail`; `warn`
  (including downgraded transient throws) is informational.
