# Comical

A configurable, **content-neutral bridge runtime** for serialized content (comics, manga,
books, and the like). The same TypeScript core runs on desktop, web, iOS, and Android.
Connection behaviour is supplied by swappable **bridges** — each bridge talks to a
**user-supplied backend** such as a self-hosted [Komga](https://komga.org),
[Kavita](https://www.kavitareader.com), or [OPDS](https://opds.io) library, or any site
the user is authorized to use.

> **Legal posture:** Comical ships no content and no backends, and operates no central
> bridge registry. It is infrastructure in the same category as a web browser or an official
> Komga client. You bring your own bridge and your own backend.

---

## Table of contents

- [Vocabulary](#vocabulary)
- [Architecture](#architecture)
  - [Layered model](#layered-model)
  - [The bridge contract](#the-bridge-contract)
  - [Host capability API](#host-capability-api)
  - [Sandboxing](#sandboxing)
  - [HTTP and CORS](#http-and-cors)
- [Package reference](#package-reference)
- [Platform support](#platform-support)
- [Quick start](#quick-start)
  - [Running the server](#running-the-server)
  - [Using the CLI](#using-the-cli)
  - [Running the browser demo](#running-the-browser-demo)
- [Writing a bridge](#writing-a-bridge)
- [Registry](#registry)
  - [Publishing a registry](#publishing-a-registry)
  - [Adding a registry](#adding-a-registry)
- [Testing](#testing)
- [Development](#development)

---

## Vocabulary

| Term | Meaning |
|------|---------|
| **Runtime** | The content-neutral engine — `@comical/core`. Ships no backends, no content. |
| **Bridge** | A TypeScript/JS plugin that implements the `Bridge` interface, translating one backend's API or HTML into the neutral data model. What Tachiyomi/Paperback call a "source." |
| **Backend** | The user-supplied server or site a bridge talks to — a Komga instance, a Kavita library, an OPDS feed, or a site the user is authorized to use. URL and credentials are always user-configured, never baked into a bridge. |
| **Host adapter** | The per-platform layer that provides real capabilities (HTTP, storage, logging) to the core. One adapter per runtime environment. |
| **Host capability API** | The interface a host adapter implements (`network.request`, `storage`, `log`). The only contact surface between the sandbox and the outside world. |
| **Registry** | An optional, user-added catalog of bridges (`index.json` + bundle files on any static host). The project operates none. |

---

## Architecture

### Layered model

```
┌──────────────────────────────────────────────────────────────────────┐
│  Bridges (TS/JS CJS bundles)                                          │
│  example-bridge · komga-bridge · opds-bridge · …                     │
│  authored with @comical/sdk · user-supplied · hot-updatable           │
├──────────────────────────────────────────────────────────────────────┤
│  Bridge Contract  @comical/contract                                   │
│  versioned TS interfaces + zod schemas · the stable boundary         │
├──────────────────────────────────────────────────────────────────────┤
│  Core Runtime  @comical/core                                          │
│  loader · sandbox · BundleEvaluator · capability gate                 │
│  rate-limiter · response cache · zod boundary validation              │
├──────────────────────────────────────────────────────────────────────┤
│  Host Adapters  (one per platform)                                    │
│  host-bun · host-web · host-server · host-ios · host-android         │
│  implement HostCapabilities: network · storage · log                  │
└──────────────────────────────────────────────────────────────────────┘
```

The core never imports platform APIs (`fs`, `process`, sockets). It only calls the **host
capability API**, which each host adapter satisfies. Porting Comical to a new platform means
writing one adapter — nothing else changes.

### The bridge contract

Every bridge default-exports a factory `(host: HostCapabilities) => Bridge`. The `Bridge`
interface (from `@comical/contract`) defines:

| Method | Required | Capability | Description |
|--------|----------|-----------|-------------|
| `getSeriesDetails(seriesId)` | ✓ | — | Full metadata for a series |
| `getChapters(seriesId)` | ✓ | — | Ordered chapter list |
| `getChapterPages(seriesId, chapterId)` | ✓ | — | Absolute image URLs for a chapter |
| `getLists(query?)` | optional | `lists` | The bridge's self-defined browsable collections |
| `getListItems(listId, page)` | optional | `lists` | Paginated entries within a list |
| `getSearchResults(query, page, filters?)` | optional | `search` | Paginated text search |
| `getFilters()` | optional | `filters` | Declarative search filter descriptors |
| `getTags()` | optional | `tags` | Tag/genre catalog |
| `getSettings()` | optional | `settings` | Declarative settings (backend URL, credentials) |

Only the read path (details/chapters/pages) is mandatory. **Browse** and **search** are separate
optional capabilities — a bridge may offer lists, search, both, or neither.

Core data models: `SeriesEntry`, `SeriesInfo`, `Chapter`, `Page`, `PagedResults<T>`,
`SeriesList`, `Filter`, `BridgeInfo`. All are zod-validated at the bridge boundary — a
misbehaving bridge cannot inject malformed data into the host.

**Lists, not prescribed sections.** Rather than hardcoded `popular`/`latest`/`home` methods, a
bridge declares its *own* lists via `getLists()` (Trending, Recently Updated, a genre, Staff
Picks, …). Each `SeriesList` is `{ id, name, description?, layout?, featured?, searchable? }` where
`layout` is `carousel | grid | ranked | hero`. Home becomes "render the featured lists" —
presentation is always *data*, never bridge-rendered UI, keeping bridges portable across headless
and UI environments.

**Searching within a list.** `getListItems(listId, page, options?)` takes a `ListOptions` bag —
`{ query?, filters?, sort? }` — so a host can search/filter/sort *inside* one list. A list opts in
by setting `searchable: true` (the `query` is only honored for those); a list whose backend can't
be queried (e.g. an infinite "trending" feed) simply omits the flag and ignores `options`. Over
REST it's `?q=&filters=&sort=&dir=` on the list-items route; via the CLI, `comical lists <listId>
--query Q [--filter k=v] [--sort key]`.

### Settings

Settings are declared by **value kind**, not UI widget — `getSettings()` returns
`SettingDescriptor[]`:

| `type` | Value | Extras |
|--------|-------|--------|
| `string` | `string` | `secret?` (API key / token / cookie / password — masked), `placeholder?`, `default?` |
| `number` | `number` | `min?`, `max?`, `default?` |
| `boolean` | `boolean` | `default?` |
| `enum` | one of `options[].value` (or `string[]` if `multiple`) | `options: {value,label}[]`, `default?` |

All share `key`, `label`, `description?`, `required?`. There is no `password` type — any `string`
sets `secret: true`; the host masks it. An `enum` carries the expected-values list so a UI can
render a picker.

**Strict typing:** wrap descriptors in `defineSettings([...])` and `InferSettings<typeof SETTINGS>`
to derive the typed settings shape, then `extends BridgeBase<Settings>` — `this.settings.baseUrl`
is `string`, an enum is its literal union, required vs optional is enforced.

**Host enforcement:** the runtime applies declared `default`s, coerces simple inputs
(`"40"→40`, `"true"→true`), and validates submitted values (type + enum membership) — an invalid
value throws `BridgeSettingsError`. The host won't dispatch content calls to a bridge whose
**required** settings are unset (`GET /bridges/:id` reports `missingRequired`); `PUT
/bridges/:id/settings` rejects unknown keys / wrong types with `400`.

### Search filters and sort

Filters and sort are **distinct concerns** — filters *narrow* a result set, sort *orders* it —
and a search receives both in an options bag: `getSearchResults(query, page, { filters?, sort? })`.

A bridge with the `filters` capability advertises filters via `getFilters()`:

| `Filter.type` | `FilterValue.value` |
|---------------|---------------------|
| `text` | `string` |
| `toggle` | `boolean` |
| `number` (`min?`, `max?`) | `number` |
| `select` (`options[]`) | `string` (one option value) |
| `multiselect` (`options[]`) | `string[]` |

`FilterValue` is `{ key, value }`; options are `{ value, label }` (same shape as settings `enum`).

A bridge with the `sort` capability advertises sort fields via `getSortOptions()` →
`SortOption[]` (`{ key, label }`); the search receives a `SortSelection` (`{ key, ascending }`).

The core validates both inputs at the boundary. Over REST:
`GET /bridges/:id/search?filters=<url-encoded JSON FilterValue[]>&sort=<key>&dir=asc|desc`, with
`GET /bridges/:id/filters` and `GET /bridges/:id/sort` returning the descriptors. Via the CLI:
`--filter key=value` (repeatable; comma → `string[]`) and `--sort key [--desc]`.

### Favorites

A bridge with the `favorites` capability syncs with the **backend's own account bookmarks/follows**
(not a local library). Three methods — `getFavorites(page)` (the minimum), plus the optional mutations
`addFavorite(seriesId)` / `removeFavorite(seriesId)`. These are the contract's only **write** methods.

Favorites need **auth**, but browsing is anonymous — so auth is *not* all-or-nothing gating. The
bridge declares optional `secret` settings (a token, or a username + password) and the favorites
methods throw a clear error when they're absent; everything else keeps working logged-out. (No OAuth.)

**Cookie sessions are a core concern.** A bridge can `POST` a login and the runtime holds the session
for it: core's gated network keeps a per-bridge **cookie jar** (attaches `Cookie`, stores
`Set-Cookie`), and hosts merely *report* `Set-Cookie` via `HttpResponse.setCookies`. So a
login-then-reuse flow works identically on every host that runs core (token/bearer auth needs no jar —
the bridge keeps the token in `host.storage`).

Over REST: `GET /bridges/:id/favorites?page=`, `PUT /bridges/:id/favorites/:seriesId` (add),
`DELETE /bridges/:id/favorites/:seriesId` (remove). Via the CLI: `comical favorites`,
`comical favorite <id>`, `comical unfavorite <id>` (with `--set sessionToken=…`). The evaluator probes
`getFavorites` read-only and **never** auto-calls the mutations (they hit a real account).

### Host capability API

The **only** things a bridge can do:

```ts
interface HostCapabilities {
  network: {
    // The sole HTTP path. Host applies rate-limiting, caching, cookies.
    request(req: HttpRequest): Promise<HttpResponse>;
  };
  storage: {
    // Namespaced per-bridge key/value (tokens, ETags, session state).
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  log: { debug | info | warn | error };
  // User-supplied settings (backend URL, credentials). Never baked into the bridge.
  settings: Readonly<Record<string, string | boolean>>;
}
```

Bridges never open sockets, read the filesystem, or see `fetch`, `process`, or `require`.
They receive a `HostCapabilities` object and work exclusively through it.

### Sandboxing

Bridge bundles are pre-compiled to self-contained **CJS** (`bun build --format=cjs`). Each
platform evaluates the bundle in isolation via a `BundleEvaluator` — the one platform-specific
seam inside the loader:

| Platform | Evaluator | Isolation |
|----------|-----------|-----------|
| Bun/Node | `NodeVmEvaluator` (`node:vm` createContext) | Cross-realm — `require`, `process`, `fetch`, `Bun` absent from the new realm |
| Browser | `FunctionEvaluator` (Function constructor + explicit global shadowing) | Function-scope — `fetch`, `XHR`, `WebSocket`, `localStorage`, etc. passed as `undefined` |
| iOS | JSC `JSContext` (in `host-ios`) | Cross-realm — fresh JSContext with only injected globals |
| Android | QuickJS runtime (in `host-android`) | Cross-realm — fresh QuickJS context |

Swapping the evaluator is the only change needed to port the loader to a new engine.

The rate-limiter and response cache sit **between** the evaluator and the raw host network,
so every bridge on every platform benefits uniformly without any per-bridge code.

### HTTP and CORS

| Deployment | How `network.request` is fulfilled |
|------------|-----------------------------------|
| `host-bun` (desktop/CLI) | Native Bun `fetch` + cookie jar. Direct to backend, no infrastructure. |
| `host-server` (LAN server) | Native Bun `fetch` on the server. Browser/app calls the server's REST API instead of fetching directly. |
| `host-web` (browser, no server) | Routes through a self-hosted `@comical/proxy` instance that adds CORS headers and fetches server-side. |
| `host-ios` | `URLSession`. Direct to backend. |
| `host-android` | OkHttp. Direct to backend. |

The **recommended** browser deployment is `host-server` — run `comical serve` on any machine
on your network and point your browser at `http://host:3100`. The browser never loads bridge
bundles or needs CORS at all.

---

## Package reference

### Core packages

| Package | Description |
|---------|-------------|
| `@comical/contract` | Versioned `Bridge` interface, `HostCapabilities`, zod data models, `contractVersion`. The stable boundary — everything else builds on this. |
| `@comical/core` | Sandboxed bridge loader, `BundleEvaluator` interface, `NodeVmEvaluator`, gated network (rate-limit + cache), zod boundary validation, typed errors, call timeouts. Pure TS — no platform APIs. |
| `@comical/sdk` | `BridgeBase` class, cheerio-backed HTML helpers (`fetchHtml`, `parse`), URL resolver, re-exports contract types. What bridge authors import. |
| `@comical/testkit` | `FixtureBackend` (public-domain demo library), `MockHost`, network record/replay cassettes, the `evaluateBridge` coverage report + `runConformance` strict gate. |
| `@comical/registry` | Registry index schema + zod validation, GitHub URL auto-resolution, SHA-256 integrity + Ed25519 signature verification, `ManifestStore`, `RegistryManager` (add/remove/browse/install/update/uninstall). |
| `@comical/library` | **Optional** local, cross-bridge reading library + tracking: collection, read/unread state, per-page resume, history, lists, new-chapter detection. Platform-agnostic `Library` service over a `LibraryStore` seam (in-memory store included). `host-server` mounts `/library` only when enabled. |

### Host adapters

| Package | Platform | Key capabilities |
|---------|----------|-----------------|
| `@comical/host-bun` | Desktop / CLI | Bun `fetch` + cookie jar, `FileStorage` / `MemoryStorage`, `node:vm` loader |
| `@comical/host-server` | LAN / home server | Hono REST API, `BridgeManager` (load on demand, cache, orphan detection), `SettingsStore`, registry-aware |
| `@comical/host-web` | Browser (no server) | `FunctionEvaluator`, proxy-backed `ProxyNetworkCapability`, `LocalStorageCapability` |
| `@comical/proxy` | CORS relay | Hono, SSRF guard, optional Ed25519 bearer auth, 10 MB cap. Deployed independently. |
| `host-ios` (Swift Package) | iOS / macOS | `JSContext` evaluator, `URLSession`, `FileManager`, on-device `ComicalServer` |
| `host-android` (Kotlin library) | Android | QuickJS (~1 MB), OkHttp, DataStore, on-device `ComicalServer` |

### Applications

| Package | Description |
|---------|-------------|
| `@comical/cli` | `comical` command-line host. Commands: `list`, `serve`, `search`, `details`, `chapters`, `pages`, `test`, `record`, `registry ...` |
| `demo/` | Minimal browser UI — thin REST client for a running `comical serve` instance. |

### Bridges

| Directory | Description |
|-----------|-------------|
| `bridges/example-bridge/` | Reference HTML bridge. Targets a user-supplied backend (URL via settings). Tested against the `FixtureBackend` public-domain library. |

---

## Platform support

| Platform | Status | How it runs |
|----------|--------|-------------|
| Desktop (Windows/macOS/Linux) | ✅ M1 | `comical serve` or direct CLI — `host-bun` |
| Web browser | ✅ M2 | REST client → `host-server` (recommended) or `host-web` + proxy (no server) |
| iOS | ✅ M3 | Native Swift app via `ComicalBridgeContext` (JSC) + optional `ComicalServer` |
| Android | ✅ M3 | Native Kotlin app via `ComicalBridgeContext` (QuickJS) + optional `ComicalServer` |
| Bridge registries | ✅ M4 | `comical registry add/install/publish` + `RegistryManager` in `host-server` |

---

## Quick start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.3.

```sh
git clone <repo>
cd comical
bun install          # install workspace dependencies
bun run build        # compile bridges → bridges/<id>/dist/bridge.js
bun test             # run the full offline test suite (63 tests)
```

### Running the server

The recommended way to use Comical — runs on any machine on your network, browser and app
clients just call the REST API.

```sh
# Start the server wired to the built-in public-domain demo library
bun run demo:server        # server on :3100, fixture backend pre-configured

# Or start a bare server and configure a bridge's backend yourself
bun run serve              # server on :3100

# Then configure the example bridge's backend URL
curl -X PUT http://localhost:3100/bridges/example/settings \
  -H "Content-Type: application/json" \
  -d '{"baseUrl": "https://your-komga-instance.example.com"}'
```

Key REST endpoints:

```
GET  /health
GET  /bridges                                      → list of bridges + update badges
GET  /bridges/:id                                  → bridge info + settings descriptors
PUT  /bridges/:id/settings                         → configure backend URL / credentials
GET  /bridges/:id/lists?q=                          → the bridge's list catalog
GET  /bridges/:id/lists/:listId?page=&q=&filters=&sort=&dir=   → entries within a list (q/filters/sort if searchable)
GET  /bridges/:id/search?q=&page=&filters=   → filters is URL-encoded JSON FilterValue[]
GET  /bridges/:id/filters                    → Filter[] descriptors for the search UI
GET  /bridges/:id/series/:seriesId
GET  /bridges/:id/series/:seriesId/chapters
GET  /bridges/:id/series/:seriesId/chapters/:chapterId/pages

GET  /registries                                   → user's added registries
POST /registries                                   → add a registry
GET  /registry/bridges                             → browse all available bridges
POST /registries/:url/bridges/:id/install          → install a bridge
GET  /registry/updates                             → available update versions
```

### Using the CLI

```sh
# List built bridges
bun run cli list

# One-off queries (without the server)
bun run cli search "alice" --bridge example --fixture
bun run cli details alice --bridge example --fixture
bun run cli chapters alice --bridge example --fixture
bun run cli pages alice alice-1 --bridge example --fixture

# Strict conformance gate (throws on the first failure)
bun run cli test --bridge example --fixture

# Coverage report — what works, what's missing (see "Evaluating a bridge")
bun run cli evaluate --bridge example --fixture

# Start the server
bun run cli serve --port 3100 --data-dir ./.comical
```

### Running the browser demo

```sh
# Terminal 1 — server + fixture backend
bun run demo:server

# Terminal 2 — browser UI on :3300
bun run demo:dev
```

Open `http://localhost:3300`. The demo is a thin REST client — the browser makes no direct
network requests to backends, has no bridge bundles, and runs no bridge code.

---

## Writing a bridge

Install the SDK and create a bridge file:

```ts
// bridges/my-bridge/src/index.ts
import {
  BridgeBase,
  type BridgeInfo,
  type InferSettings,
  type PagedResults,
  type SeriesEntry,
  type SeriesList,
  type SettingDescriptor,
  defineBridge,
  defineSettings,
} from "@comical/sdk";

// Strictly-typed settings: `InferSettings` derives the value shape from the descriptors.
const SETTINGS = defineSettings([
  { type: "string", key: "baseUrl", label: "Backend URL", required: true },
  { type: "string", key: "apiKey",  label: "API key", secret: true },        // any string can be secret
  { type: "enum",   key: "region",  label: "Region",
    options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }], default: "us" },
]);
type Settings = InferSettings<typeof SETTINGS>;
// → { baseUrl: string; apiKey?: string; region?: "us" | "eu" }

class MyBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo = {
    id: "my-bridge",
    name: "My Bridge",
    version: "0.1.0",
    contractVersion: "1.0.0",
    languages: ["en"],
    nsfw: false,
    capabilities: ["lists", "settings"],
  };

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  // this.settings.baseUrl is typed `string`; this.settings.region is `"us" | "eu" | undefined`.
  private base() { return this.requireSetting("baseUrl"); }

  // Browse — declare your own lists (capability "lists")
  async getLists(): Promise<SeriesList[]> {
    return [
      { id: "popular", name: "Popular", layout: "carousel", featured: true },
      { id: "new",     name: "New",     layout: "grid" },
    ];
  }

  async getListItems(listId: string, page: number): Promise<PagedResults<SeriesEntry>> {
    const $ = await this.fetchHtml(`${this.base()}/${listId}?page=${page}`);
    const items = $(".item").toArray().map(el => ({
      id: $(el).attr("data-id") ?? "",
      title: $(el).find(".title").text().trim(),
    }));
    return { items, page, hasNextPage: false };
  }

  // ... implement getSeriesDetails, getChapters, getChapterPages
  // ... optionally add getSearchResults for the "search" capability
}

export default defineBridge(host => new MyBridge(host));
```

Bridge rules:
- **Never** use `fetch`, `XMLHttpRequest`, or any platform API directly. Only `this.request()` / `this.fetchHtml()` / `this.fetchJson()`.
- **Never** hardcode a backend URL. Read it from `this.requireSetting("baseUrl")`.
- All image URLs in `Page.imageUrl` must be absolute.
- Declare every capability you implement in `info.capabilities`.

Build and test:

```sh
bun run build                              # compile to bridges/my-bridge/dist/bridge.js
bun run cli test --bridge my-bridge --set baseUrl=https://your-backend.example.com
```

---

## Evaluating a bridge

`comical evaluate` runs your built bridge against a backend and prints a **coverage report** —
which declared capabilities actually work, plus behavioral probes and data-quality checks. It's
the developer-facing companion to `comical test` (which is a strict pass/fail gate).

```sh
bun run cli evaluate --bridge my-bridge --set baseUrl=https://your-backend.example.com
bun run cli evaluate --bridge my-bridge --fixture --json     # machine-readable for CI
```

```
Evaluating my-bridge …

core
  ✓ details round-trip the sampled id
  ⚠ series details have no genres
search
  ✓ search returned 22 item(s)
filters
  ✓ filter "genre" changed results (22→5)
sort
  ✓ sort "title" reorders results (asc ≠ desc)

Summary: 14 pass · 1 warn · 0 fail — PASS
Coverage: 5/5 declared capabilities exercised, 5 passing  [lists, search, filters, sort, settings]
```

What it checks: capability↔method agreement, the `details → chapters → pages` round trip (id
stability, chapter ordering/uniqueness), and behavioral probes — **filters narrow** results,
**sort reorders** them, **in-list search** narrows a searchable list, and **settings** descriptors
are well-formed. Missing-but-optional data (covers, authors, genres) is a `warn`, not a `fail`.

- **Coverage here means contract/capability coverage + data-quality heuristics** — not code
  coverage, and not semantic correctness (it can't tell if a title is *right*, only that it's present).
- **Severities:** hard contract violations `fail` (non-zero exit); quality/behavioral-no-effect
  `warn`. Use `--strict` to fail the run on warnings too. `--query Q` seeds the search probe.

### In CI

Bridges run against a **live** backend, so this is non-deterministic — best as a scheduled job
(catches site drift) and/or a non-blocking PR check, rather than a hard gate:

```yaml
# .github/workflows/bridges.yml
on:
  pull_request:
  schedule: [{ cron: "0 6 * * *" }]   # daily — catch upstream site changes
jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install && bun run build
      - run: bun run cli evaluate --bridge my-bridge --set baseUrl=${{ secrets.BACKEND_URL }} --json
```

The JSON report (`{ bridgeId, results[], summary }`) is stable to aggregate into a per-bridge
status table or badge across a repo of bridges.

---

## Registry

A registry is a static `index.json` + bridge bundle files on any static host (GitHub Pages,
Cloudflare Pages, S3, self-hosted). The project operates no central registry.

### Publishing a registry

```sh
# 1. Generate a signing keypair (keep the private key secret — never commit it)
bun run cli registry keygen --out registry.key.json

# 2. Build bridges and publish
bun run build
bun run cli registry publish \
  --base-url https://my-github-user.github.io/my-bridges \
  --out ./dist \
  --key registry.key.json   # optional; unsigned registries are also valid

# 3. Deploy ./dist/ to GitHub Pages, Cloudflare Pages, S3, etc.
#    The index.json is at the root of the deployed URL.
```

The published `index.json` shape:

```json
{
  "registryVersion": "1",
  "updated": "2026-06-01T00:00:00Z",
  "publicKey": "<base64url Ed25519 public key — omit for unsigned>",
  "bridges": [
    {
      "id": "my-bridge",
      "name": "My Bridge",
      "version": "0.1.0",
      "contractVersion": "1.0.0",
      "languages": ["en"],
      "nsfw": false,
      "capabilities": ["search", "settings"],
      "url": "https://my-github-user.github.io/my-bridges/bridges/my-bridge/0.1.0/bridge.js",
      "sha256": "<lowercase hex SHA-256 of the bundle>",
      "signature": "<base64url Ed25519 sig over the sha256 hex — omit for unsigned>"
    }
  ]
}
```

### Adding a registry

Via the CLI:

```sh
# GitHub repo URL is auto-resolved to raw.githubusercontent.com/…/main/index.json
bun run cli registry add github.com/someone/their-bridges
bun run cli registry browse github.com/someone/their-bridges
bun run cli registry install github.com/someone/their-bridges my-bridge
bun run cli registry updates   # check for newer versions (never installs automatically)
bun run cli registry update my-bridge
```

Via the REST API (same operations, for the browser/app UI):

```sh
curl -X POST http://localhost:3100/registries \
  -H "Content-Type: application/json" \
  -d '{"url": "github.com/someone/their-bridges"}'

curl http://localhost:3100/registry/bridges
curl http://localhost:3100/registry/updates
```

**Integrity + trust model:**
- SHA-256 checksum is always verified before a bundle is evaluated. Prevents corruption and transit tampering.
- Ed25519 signature verification is optional — present when the registry operator has generated a keypair. Trust is established when you add the registry (HTTPS identity + the registry operator's identity on GitHub).
- Updates are **always manual**. `checkUpdates()` / `GET /registry/updates` reports available versions; nothing installs without explicit user action.
- Removing a registry **orphans** its installed bridges (they are blocked from loading). Re-add the registry or reinstall the bridges to restore them.

---

## Testing

```sh
bun test                # full offline test suite (63 tests across 10 files)
bun test ./packages/core/         # core unit + sandbox tests
bun test ./packages/registry/     # registry: URL resolution, checksums, signing, install cycle
bun test ./packages/host-bun/     # host-bun integration (real HTTP via fixture backend)
bun test ./packages/host-server/  # host-server REST API integration
bun test ./bridges/example-bridge/ # bridge conformance + snapshot tests
```

**iOS tests** (requires Xcode on macOS):
```sh
cd packages/host-ios && swift test
```

**Android tests** (requires Android SDK):
```sh
cd packages/host-android && ./gradlew test
```

### Test pyramid

| Layer | What it covers | Network |
|-------|---------------|---------|
| Unit (core/sdk) | Loader, sandbox, rate-limiter, cache, version compat | None |
| Bridge conformance | All `Bridge` methods, id round-trips, invariants, against cassettes | None (replay) |
| Snapshot | Parsed output pinned per bridge | None (replay) |
| Sandbox/security | `require`/`process`/`fetch` absent, resource guards, eval disabled | None |
| Robustness/fuzz | Truncated HTML, 5xx, empty bodies, malformed JSON | None |
| Host-adapter integration | Real fetch + storage + cookie jar against local fixture server | Localhost only |
| Registry | Checksum, signature, install/orphan/update cycle, URL resolution | Localhost only |
| Live canary (CI, non-gating) | Real backends, cassette refresh | Live |

---

## Development

### Repo layout

```
comical/
├── packages/
│   ├── contract/      @comical/contract  — versioned interfaces + zod models
│   ├── core/          @comical/core      — sandboxed loader, BundleEvaluator, gated network
│   ├── sdk/           @comical/sdk       — BridgeBase, cheerio helpers
│   ├── testkit/       @comical/testkit   — fixture backend, conformance suite, cassettes
│   ├── registry/      @comical/registry  — index schema, URL resolution, signing, manager
│   ├── host-bun/      @comical/host-bun  — desktop/CLI adapter
│   ├── host-server/   @comical/host-server — REST API server
│   ├── host-web/      @comical/host-web  — browser adapter (FunctionEvaluator + proxy)
│   ├── proxy/         @comical/proxy     — self-hostable CORS relay (Hono)
│   └── cli/           @comical/cli       — comical command-line tool
├── bridges/
│   └── example-bridge/                  — reference bridge (public-domain demo backend)
├── packages/host-ios/                   — Swift Package (JSC evaluator + URLSession)
├── packages/host-android/               — Kotlin library (QuickJS + OkHttp)
├── demo/                                — browser demo UI
├── scripts/build.ts                     — bundles bridges to CJS
├── package.json                         — Bun workspace root
├── tsconfig.base.json                   — shared TS config
└── tsconfig.json                        — root typecheck (all packages)
```

### Key commands

```sh
bun install              # install all workspace deps
bun run build            # bundle bridges → bridges/<id>/dist/bridge.js
bun test                 # run all tests
bun run typecheck        # tsc --noEmit across all packages
bun run serve            # start comical-server on :3100
bun run demo:server      # start server wired to fixture backend
bun run demo:dev         # start browser demo UI on :3300
bun run cli -- --help    # CLI help
```

### Adding a new host adapter

1. Create `packages/host-<name>/`.
2. Implement `HostCapabilities` using your platform's HTTP/storage/log APIs.
3. Implement `BundleEvaluator` using your platform's JS engine (JSC, QuickJS, V8, etc.).
4. Pass your evaluator to `loadBridge({ ..., evaluator: yourEvaluator })`.
5. Add a test that loads `example-bridge` and calls `runConformance`.

### Updating the contract

The bridge contract (`@comical/contract`) is semver-versioned. A breaking change to the
`Bridge` interface or data models would normally bump `CONTRACT_VERSION` in `version.ts`, and the
runtime rejects bridges targeting an incompatible major version at load time. **During local
development (pre-deployment) we change the contract in place without bumping** — there are no
external bridges to migrate yet.

Additive changes (new optional methods, new `SeriesList` layouts, new `BridgeCapability` values)
are non-breaking.
