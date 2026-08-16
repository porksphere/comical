# Universal collections — design & implementation plan

Generalize page favorites into one grouping system: **any series, chapter, or page can be put in a
collection**, and the library's custom lists retire into collections. This replaces the
just-shipped page-favorites surface before anything consumes it (the app session has written zero
code against it) and eliminates the `LibraryList` / `FavoriteCollection` duplication outright —
including follow-ups §5's "fix reorder in both places or neither," which becomes "fix it once."

## Naming: collections, not tags

`tags` is already taken by content/genre tags — `getTags`, `excludedTags`, `TagLabelCache` are live
bridge-side concepts, and "tag a page" vs "exclude a tag" sharing a noun is the same trap
`favorites`/bridge-favorites almost was. **Collections** is already shipped, already the right word,
and carries no collision.

## Decisions (made; overridable before Phase 1 starts)

1. **Pivot confirmed.** The `/library/favorite-pages` family is replaced, not aliased — it shipped
   to no client, so it can be renamed outright with no migration.
2. **Core is uniform; policy lives in the app.** Any item type can exist as a bare anchor
   (favorited, in no collection). The app's policy: a bare heart is a **page-only** affordance;
   series and chapters enter the system through "add to collection." This keeps mechanism/policy
   split — a future "heart a series" feature is a UI change, not a runtime change.
   One asymmetry in core to prevent data litter: **deleting a collection prunes series/chapter
   items left with zero memberships** (they only existed as members), but never prunes bare pages
   (those are hearts the user set deliberately).
3. **Lists migrate at the store level, with deprecated aliases for one cycle.** Precedent: the
   categories→lists migration already lives in `FileLibraryStore`. Unlike that one, **this
   migration preserves memberships**.

## Data model — `@comical/library`

One discriminated union, house style (same pattern as `Page.thumbnail`):

```ts
type FavoriteItem =
  | { type: "series";  bridgeId; seriesId;
      id; favoritedAt; collectionIds;
      seriesTitle; thumbnailUrl?; author?; stale? }
  | { type: "chapter"; bridgeId; seriesId; chapterId;
      id; favoritedAt; collectionIds;
      seriesTitle; chapterName?;
      number?; languageCode?;          // logical-chapter identity — the chapter re-anchor key
      stale? }
  | { type: "page";    /* exactly the current FavoritePage, plus `type` */ };
```

- **Ids** stay derived and keyed, with a type prefix: `series:b:s`, `chapter:b:s:c`,
  `page:b:s:c:i` (components URL-encoded). `favoritePageId`/`parseFavoritePageId` become
  `favoriteItemId`/`parseFavoriteItemId`. Idempotent PUTs, O(1) lookups, and shard derivation all
  carry over.
- **Snapshots** per type: series mirrors `SeriesSnapshot` (title/thumb/author); chapter carries
  `number`/`languageCode` so a re-uploaded chapter can be re-anchored; page unchanged, including
  both re-anchor keys and the merge-on-PUT semantics.
- **Drift story per type** — this is why the union earns its keep:
  - *series*: stable coordinates, no drift, no machinery.
  - *chapter*: no index drift (chapters have ids). A chapter id vanishing from a fresh chapter
    list is detected **inside `syncChapters`**, which already receives that list for library
    series: re-anchor by logical chapter `(number, languageCode)` (re-keys the record), else mark
    `stale`. Zero new fetches. Chapter anchors on non-library series never sync and so only rot
    silently — accepted, noted.
  - *page*: the entire existing subsystem (reconcile ladder, sparse hashes, stale) moves over
    **unchanged**.
- `FavoriteCollection` unchanged: `{ id, name, order }`.
- `LibraryEntry.listIds` stays in the schema (additive rule — old documents must parse) but is
  **deprecated and no longer maintained** after migration.

## Store seam

The six methods generalize in place; the scope gains `type`:

```ts
listFavoriteItems(scope?: { type?; bridgeId?; seriesId?; chapterId? }): Promise<FavoriteItem[]>;
getFavoriteItem(id: string): Promise<FavoriteItem | undefined>;
putFavoriteItems(items: FavoriteItem[]): Promise<void>;    // one durable write per call
deleteFavoriteItems(ids: string[]): Promise<void>;         // one durable write per call
listFavoriteCollections(): Promise<FavoriteCollection[]>;
putFavoriteCollections(collections: FavoriteCollection[]): Promise<void>;
```

Same three load-bearing requirements as before: honour the scope, batch = one write, **shard per
series** — which works for all three types, since a series anchor lives in its own series' shard
(`favorite-items/{b:s}.json`; a bridge+series scope names exactly one shard).

**Migrations:**
- `favorite-pages/` shards → dropped without migration; no client ever produced them.
- **Lists → collections** (the real one), one-time in `FileLibraryStore` on first favorites or
  collections access: each `LibraryList` becomes a `FavoriteCollection` **keeping its id**; each
  entry's `listIds` become a `series` FavoriteItem with those `collectionIds`, snapshot from the
  entry (title/thumbnailUrl/author), `favoritedAt = entry.addedAt`. `lists.json` is then removed
  and entries' `listIds` cleared, so the migration cannot re-run. The app's
  `AsyncStorageLibraryStore` mirrors this against its own keys (spec'd in the rewritten handoff).

## Routes

The type segment disambiguates everything — the old literal-vs-`{id}` route-ordering tension is
gone structurally, and collections get promoted out of the favorites path:

```
GET    /library/favorites?type=&sort=&dir=&collection=&series=&q=   → FavoriteItem[] (mixed union)
GET    /library/favorites/page/{b}/{s}/{c}/indices                  → number[]        (reader path)
POST   /library/favorites/page/{b}/{s}/{c}/reconcile                ← { pages } → { indices, repaired, stale }
PUT    /library/favorites/series/{b}/{s}                            ← snapshot → item
DELETE /library/favorites/series/{b}/{s}
PUT    /library/favorites/series/{b}/{s}/collections                ← { collectionIds } → item
PUT    /library/favorites/chapter/{b}/{s}/{c}                       ← snapshot → item
DELETE /library/favorites/chapter/{b}/{s}/{c}
PUT    /library/favorites/chapter/{b}/{s}/{c}/collections           ← { collectionIds } → item
PUT    /library/favorites/page/{b}/{s}/{c}/{i}                      ← snapshot → item
DELETE /library/favorites/page/{b}/{s}/{c}/{i}
PUT    /library/favorites/page/{b}/{s}/{c}/{i}/collections          ← { collectionIds } → item

GET    /library/collections                                         → FavoriteCollection[]
POST   /library/collections                                         ← { name } → collection (201)
PATCH  /library/collections/{id}                                    ← { name }
DELETE /library/collections/{id}                                    (prunes uncollected series/chapter items)
POST   /library/collections/reorder                                 ← { orderedIds }
```

Everything else carries over: coordinates everywhere (no item id in any path — the re-key hazard
still exists and is still mitigated the same way), `__direct__` for chapterless series, merge
semantics on PUT (the two-PUT hash flow stays safe), 404 when no library is mounted.

**Deprecated aliases, one cycle:** `/library/lists*` and
`PUT /library/entries/{b}/{s}/lists` delegate to collections / series-item membership, since the
lists UI is live in the shipped app. Removal goes in the follow-ups doc.

## `getLibrary` rewiring

The list filter (`listId`/`listIds`/`unlisted`) now reads through series favorites: fetch
`listFavoriteItems({ type: "series" })` (small — bounded by library size, and scoped reads keep it
off the page shards), build `entryKey → collectionIds`, filter as before. `unlisted` means "no
series item, or empty memberships." Query params keep working; `list=` becomes an alias for
`collection=` on this route.

## Phases (this repo)

1. **Model + seam.** `FavoriteItem` union, prefixed ids, `scope.type`; memory + file stores with
   the `favorite-items/` shard layout. Generalize the existing tests' counting-store scaling
   assertions to the union.
2. **Service.** `favoriteItem`/`unfavoriteItem`/`getFavoriteItems`/`setFavoriteItemCollections`
   generalized; reconcile untouched (page-only); chapter re-anchor wired into `syncChapters`;
   collection-delete prune semantics.
3. **Router.** New `/library/favorites` + `/library/collections` families; delete the
   `/library/favorite-pages` family. Full HTTP integration tests, host-rn transport tests.
4. **Lists retirement.** Store migration (file), `getLibrary` rewiring, deprecated aliases,
   `listIds` deprecation. This phase is the risk concentration — it touches live data and the
   hottest existing query, and gets the densest tests (migration idempotency, memberships
   preserved, alias parity with old behaviour).
5. **Docs + coordination.** Rewrite `page-favorites-handoff.md` → `collections-handoff.md`
   (app store migration spec included), update follow-ups (§5 resolved by unification; add alias
   removal), message to the app session. App stays held until Phase 3 lands; their Phase 1 (store
   seam + reader toggle) maps almost one-to-one onto the generalized seam.

Rough size: Phases 1–3 are mostly mechanical generalization of code that exists and is tested —
comparable to the API-tightening commit. Phase 4 is the genuinely new work.

## Risks / accepted costs

- **Lists migration is the one irreversible step** — it rewrites live user documents. Mitigation:
  memberships-preserving by construction, idempotent by construction (source documents removed),
  and tested against a fixture of the current on-disk layout.
- Chapter anchors on non-library series have no drift detection (nothing ever fetches their
  chapter lists). Accepted; recorded in follow-ups.
- Mixed-type collection browsing pushes rendering variety to the client — which is the
  contract's stated philosophy (presentation is data; the client renders each union variant with
  native primitives).
