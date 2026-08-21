# Universal collections — migration handoff to `comical-app`

> **Transient document. Delete it when this branch merges.**
> It briefs the `comical-app` session migrating the client from the page-favorites API to the
> universal-collections API. The code is the source of truth on any disagreement.
> (`docs/collections-plan.md` is the design rationale; `docs/page-favorites-followups.md` records
> deferred decisions and stays.)

**Runtime half:** branch `claude/page-favorites-runtime-00agdx`. **Pin the branch head.**

## What happened and what it means for your existing code

You implemented the client against the `/library/favorite-pages` API. That surface is **replaced**,
not extended, three times over:

1. **Generalized**: a collection can hold **series, chapter, or page items**, and the library's
   custom **lists are deleted** — collections are the one grouping system.
2. **Pure collections**: there is **no local "favorites" concept any more.** An item exists only as
   a member of collections; emptying its memberships removes it, pages included — no bare hearts.
   The word "favorites" now belongs exclusively to the bridge-account capability
   (`/bridges/:id/favorites`), which is untouched. The local vocabulary is *collect / collected /
   collection item* throughout.
3. **The library itself dissolved into collections** (newest, and the one with real UX
   consequences). There is no `LibraryEntry` any more: a tracked series **is** a
   `CollectionSeriesItem`, sitting in the same document as its chapter and page items. "In the
   library" now means "in at least one collection". `/library/entries/*` is gone as a path prefix —
   the whole family moved under `/library/collected/series/{b}/{s}/*`.

No aliases, no compat — and no data migration except **one**: the user's library, which you MUST
migrate rather than wipe. See §0; do it before anything else. Lists data and any favorites data your
build wrote are still abandoned.

Most of your behavioural logic still survives: merge-on-PUT (the two-PUT hash flow stays safe),
reconcile request/response shapes, indices-excludes-stale, sort/dir semantics, `__direct__`,
coordinates-never-ids, 404-when-no-library. What changed is names, paths, one new `type` dimension,
the lists feature folding in, the library entry becoming a series item — and two real semantic
changes: **zero memberships removes the item**, and **removing a series item cascades** (§6).

Your app-side `docs/page-favorites-plan.md` is stale again — rewrite or delete it against this.

## 0. Migrate the user's library FIRST — do not wipe it

Everything else in this document is a rename. This is the one thing that destroys user data if you
skip it.

Your `AsyncStorageLibraryStore` has an entries document holding the user's tracked series. Under the
new model that document is dead, and a naive "wipe and start clean" leaves the user opening the app
to an **empty library** — no series, no unread counts, no resume points.

It does not have to. Everything a series owns *other than* the entry row — chapter progress, tracker
links, the cached detail and chapter list, group membership — is keyed by `entryKey`
(`{bridgeId}:{seriesId}`) in its **own** document, exactly as before. The dissolution orphaned those;
it did not delete them. Rebuild the series items and every one of them reattaches automatically.

The runtime does the work; you only have to find your own legacy document and hand the rows over:

```ts
import { Library } from "@comical/library";

// On startup, once, before the library screen reads anything.
const raw = await AsyncStorage.getItem("comical:lib:entries");   // whatever your key was
if (raw) {
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const { imported, skipped } = await library.importLegacyEntries(rows);   // → files into "Default"
  await AsyncStorage.setItem("comical:lib:entries.migrated", raw);          // keep it until you're sure
  await AsyncStorage.removeItem("comical:lib:entries");
}
```

`importLegacyEntries(rows, collectionName = "Default")`:

- **Idempotent.** Coordinates already collected are skipped, never overwritten — safe to re-run after
  a crash, and it can't clobber anything written post-migration.
- **Row-by-row validation.** A malformed entry is skipped and counted in `skipped`; a bad *optional
  field* (say a thumbnail URL that no longer parses) costs that field, not the entry.
- **Files everything into one collection**, created if absent. It has to: under pure collections an
  unfiled series is swept by the next thing that touches it. That collection is the obvious
  candidate for the "default" collection §5 tells you to pick — reuse it rather than making a second.
- Carries `knownChapters`, `revision`, `lastRead*`, `chaptersSyncedAt`, `seriesGroupId` and
  `externalIds` across, so unread counts, resume points, tracker auto-linking and cross-source groups
  all come back intact.

Keep the old document around (renamed, as above) until you've confirmed a real device migrated
cleanly. `host-server` does the same thing with `entries.json` → `entries.migrated.json`, so you can
cross-check the behaviour against `packages/host-server/src/legacy-entries.ts`.

**What is NOT migrated, deliberately:** lists (`lists.json` / `listIds`) and anything your build
wrote under the `favorite-pages` keys. Those never carried real user data; collections start empty
apart from the imported library.

## 1. Route migration table

### Items and collections

| You call today | Call instead | Notes |
|---|---|---|
| `GET /library/favorite-pages?…` | `GET /library/collected?type=page&…` | Same query params plus `type`. **Omitting `type` returns the mixed union** — pass `type=page` anywhere your grid expects pages only. |
| `GET /library/favorite-pages/chapter/{b}/{s}/{c}` | `GET /library/collected/page/{b}/{s}/{c}/indices` | Response unchanged (`number[]`). |
| `POST …/favorite-pages/chapter/{b}/{s}/{c}/reconcile` | `POST /library/collected/page/{b}/{s}/{c}/reconcile` | Body and response **unchanged**. |
| `PUT/DELETE /library/favorite-pages/{b}/{s}/{c}/{i}` | `PUT/DELETE /library/collected/page/{b}/{s}/{c}/{i}` | Body unchanged. Response carries `type: "page"` and a `page:`-prefixed id. |
| `PUT …/favorite-pages/{b}/{s}/{c}/{i}/collections` | `PUT /library/collected/page/{b}/{s}/{c}/{i}/collections` | Unchanged body. |
| `GET/POST /library/favorite-pages/collections` | `GET/POST /library/collections` | Promoted to top level. |
| `PATCH/DELETE …/favorite-pages/collections/{id}` | `PATCH/DELETE /library/collections/{id}` | |
| `POST …/favorite-pages/collections/reorder` | `POST /library/collections/reorder` | Still `{ orderedIds }`. |
| `GET /library?list=` / `?lists=` / `?unlisted=` | `?collection=` / `?collections=` / `?uncollected=` | |
| `GET/POST /library/lists`, `PATCH/DELETE /library/lists/{id}`, `POST /library/lists/reorder` | `/library/collections` equivalents | **Lists routes are gone.** Same CRUD shapes. |

New item routes:

```
PUT    /library/collected/chapter/{b}/{s}/{c}             ← { seriesTitle, chapterName?, number?, languageCode? }
DELETE /library/collected/chapter/{b}/{s}/{c}
PUT    /library/collected/chapter/{b}/{s}/{c}/collections ← { collectionIds }
PUT    /library/collected/series/{b}/{s}/collections      ← { collectionIds }
```

Send `number`/`languageCode` on chapter PUTs when you have them — they are the chapter's re-anchor
identity (§7).

### The library entry family (all of it moved)

Every `/library/entries/...` path is now `/library/collected/series/...`. Mechanically it is a
prefix swap, except for the two rows called out below.

| You call today | Call instead |
|---|---|
| `POST /library/entries` (body carries `bridgeId`/`seriesId`) | **`PUT /library/collected/series/{b}/{s}`** — coordinates move into the path; see below |
| `GET /library/entries/{b}/{s}` | `GET /library/collected/series/{b}/{s}` — **response key `entry` is now `series`** |
| `DELETE /library/entries/{b}/{s}` | `DELETE /library/collected/series/{b}/{s}` |
| `GET /library/entries/{b}/{s}/cover` | `GET /library/collected/series/{b}/{s}/cover` |
| `POST /library/entries/{b}/{s}/sync` | `POST /library/collected/series/{b}/{s}/sync` |
| `GET /library/entries/{b}/{s}/progress` | `GET /library/collected/series/{b}/{s}/progress` (and a new `DELETE` on the same path — §6) |
| `PUT /library/entries/{b}/{s}/progress/{chapterId}` | `PUT /library/collected/series/{b}/{s}/progress/{chapterId}` |
| `POST /library/entries/{b}/{s}/read-up-to` | `POST /library/collected/series/{b}/{s}/read-up-to` |
| `POST /library/entries/{b}/{s}/join-group` | `POST /library/collected/series/{b}/{s}/join-group` |
| `DELETE /library/entries/{b}/{s}/leave-group` | `DELETE /library/collected/series/{b}/{s}/leave-group` |
| `GET/POST /library/entries/{b}/{s}/tracker-links` | `GET/POST /library/collected/series/{b}/{s}/tracker-links` |
| `DELETE …/tracker-links/{trackerId}` and `POST …/tracker-links/{trackerId}/sync` | same under the new prefix |

The offline-details fallback also points `thumbnailUrl` at the new cover path, so a cached detail
you render from now yields `/library/collected/series/{b}/{s}/cover`. If you special-case that
string anywhere, update it.

### Collecting a series (the old `POST /library/entries`)

```
PUT /library/collected/series/{b}/{s}
    ← { seriesTitle?, thumbnailUrl?, author?, externalIds?, collectionIds? }   (body optional)
    → 200 { item, autoLinked?, trackerSuggestions? }
```

Four things changed beyond the path:

- **Coordinates are in the path**, not the body — consistent with every other item PUT.
- **`title` is now `seriesTitle`**, matching the item field.
- **`201` became `200`.** The route is an idempotent PUT; re-collecting merges (supplied field
  wins, omitted field preserved) exactly like page PUTs, so there is no "created" distinction to
  report.
- **`collectionIds` files in the same call.** Under pure collections a series nobody filed is only
  transiently collected, so pass whichever collection your UI treats as the default at add time
  rather than following up with a second request. Unknown ids are dropped; a list that resolves to
  nothing leaves existing memberships alone (it will not delete the series you just collected —
  emptying memberships stays an explicit `collections: []` call).

The response is the runtime envelope, not the bare item: `item` plus `autoLinked` when matching
`externalIds` joined it to an existing series, plus `trackerSuggestions` when no tracker could be
auto-linked. Chapter and page PUTs have nothing to add, so those still answer with the item itself.

Behaviour that carried over unchanged: with a runtime attached, an omitted `seriesTitle` is
resolved from the bridge along with the thumbnail, author and external ids, and the offline detail,
chapter seed and cover bytes are captured. On a library-only host (no runtime — the RN in-process
router when you wire it without one) there is no bridge to ask, so an omitted `seriesTitle` is a
`400`.

## 2. Type migration table (`@comical/library`, type-only imports)

| You import today | Import instead | Notes |
|---|---|---|
| `FavoritePage` | `CollectionPageItem` | Same fields plus `type: "page"`; `favoritedAt` is now `collectedAt`. Union: `CollectionItem`. |
| `FavoritePagesQuery` / `FavoritePagesSort` | `CollectionItemsQuery` / `CollectionItemsSort` | Query gains `type?`; no `uncollected` sentinel. |
| `FavoritePageScope` | `CollectionItemScope` | Gains `type?`. |
| `favoritePageId` / `parseFavoritePageId` | `collectionItemId` / `parseCollectionItemId` | Coord carries `type`; ids are prefixed: `page:b:s:c:i`, `chapter:b:s:c`, `series:b:s`. |
| `FavoritePageSnapshot` | `PageItemSnapshot` | Same fields. |
| `FavoriteCollection` | `Collection` | Same fields. |
| `LibraryEntry` | `CollectionSeriesItem` | See the field renames below. |
| `LibraryEntryView` | `CollectionSeriesItemView` | Still just the item plus `unreadCount`. |
| `libraryEntrySchema` | `collectionSeriesItemSchema` | |
| `SeriesSnapshot` | `SeriesItemSnapshot` | No longer carries `bridgeId`/`seriesId` (they're the coord); `title` → `seriesTitle`; gains `collectionIds?`. |
| `ChapterPageRef` | unchanged | |
| `UNCOLLECTED` | **gone** | Zero memberships removes the item, so nothing is durably uncollected. |
| `LibraryList`, `LibraryEntry.listIds` | **gone** | Memberships live on the series item's `collectionIds`. |

New: `CollectionItem`, `CollectionSeriesItem`, `CollectionChapterItem`, `SeriesItemSnapshot`,
`ChapterItemSnapshot`, `CollectionItemCoord`, `CollectionItemType`, `CollectSeriesResult`.

### Field renames on the series record — check every library screen

`CollectionSeriesItem` keeps everything `LibraryEntry` had (`knownChapters`, `revision`,
`lastReadChapterId`, `lastReadChapterName`, `lastReadAt`, `chaptersSyncedAt`, `seriesGroupId`,
`externalIds`, `thumbnailUrl`, `author`, `updatedAt`), so your derivations port directly. Three
things moved:

| Was | Now |
|---|---|
| `entry.title` | `item.seriesTitle` |
| `entry.addedAt` | `item.collectedAt` |
| `entry.listIds` | `item.collectionIds` |
| — | `item.id` (`series:{b}:{s}`), `item.type: "series"` |

**`GET /library` returns these**, so the library grid's title binding is a breaking rename —
`seriesTitle`, not `title`. Its query params are otherwise unchanged (`collection`, `collections`,
`uncollected`, `q`, `unreadOnly`, `sort` ∈ `added|title|lastRead|unread`, `dir`); `sort=title`
still sorts on the title, whatever the field is called.

If you kept `Library`-service calls anywhere rather than going through HTTP: `addSeries` →
`collectSeries(coord, snapshot)`, `isInLibrary` → `isCollected`, `getEntry` → `getSeries`,
`getEntryCompletion` → `getSeriesCompletion`. `removeSeries(key)` keeps its name and its cascade.

## 3. `AsyncStorageLibraryStore` migration

Renames — same contracts you already implemented (honour the scope; batch = one durable write;
shard per series):

| Your method | Becomes |
|---|---|
| `listFavoritePages(scope?)` | `listCollectionItems(scope?)` — scope gains `type?` |
| `getFavoritePage(id)` | `getCollectionItem(id)` |
| `putFavoritePages(pages)` | `putCollectionItems(items)` |
| `deleteFavoritePages(ids)` | `deleteCollectionItems(ids)` |
| `listFavoriteCollections` / `putFavoriteCollections` | `listCollections` / `putCollections` |
| `listEntries` / `getEntry` / `putEntry` / `deleteEntry` | **delete these** and the entries document |
| `listLists` / `putList` / `deleteList` | **delete these** and their documents |

Details that matter:

- **Sharding carries over as-is**: a series item lives in its own series' shard, so one layout
  covers all three types — and the series record now shares a shard with its chapters and pages,
  which is what makes a per-series read one document. Rename keys to
  `comical:lib:collection-items:{bridgeId}:{seriesId}` and drop any old `favorite-pages` keys —
  those record ids changed prefix, so old records are invalid anyway; wipe, don't migrate. The
  **entries** key is the exception: read it once through `importLegacyEntries` (§0) before dropping
  it.
- `getCollectionItem(id)` still finds its shard via `parseCollectionItemId(id)` — every coordinate
  type carries bridge+series.
- **One subtle scope rule**: a `chapterId`-scoped listing must exclude series items (they have no
  `chapterId`) — i.e. `scope.chapterId` set ⇒ skip `type === "series"` and skip non-matching
  chapterIds. Both reference stores do exactly this; copy them.
- Old `lists.json`- and `entries.json`-equivalent keys, and `listIds` in stored entries: abandon in
  place, never read.

## 4. The lists UI becomes the collections UI

- **CRUD/reorder screens**: point at `/library/collections*`. Shapes are identical to lists
  (`{id, name, order}`, `{orderedIds}`), so the UI logic ports directly.
- **Filing a series** (the old "add to list"): one call — `PUT /library/collected/series/{b}/{s}`
  with `{ seriesTitle, collectionIds }`. Use `PUT …/series/{b}/{s}/collections` when you are
  re-filing an already-collected series and have nothing new to say about its metadata.
- **Reading a series' memberships** (the old `entry.listIds`): `item.collectionIds`, straight off
  anything that returns the series item (`GET /library`, `GET /library/collected?type=series`,
  `GET /library/collected/series/{b}/{s}`). For the library screen's filter chips, `?collection=`
  on `/library` filters server-side.
- **Un-filing to zero**: PUT `collections: []` — the server removes the item and returns
  `{ removed: true }` instead of the item. A DELETE on the coordinates does the same. This applies
  to **every type, pages included**. For series, read §6 first — the blast radius is larger now.
- **Collection browse**: `GET /library/collected?collection={id}` returns the mixed union — switch
  on `type` and render each variant natively (series tiles have `thumbnailUrl`; page tiles
  re-resolve the page URL as you already do; chapter rows from `seriesTitle`/`chapterName`).
  `sort=chapter` interleaves sensibly (series lead their chapters, chapters lead their pages).
- **The reader's heart**: with no bare page hearts, the one-tap heart = membership in a lazily
  created, ordinary "Favorites"-style collection (create it on first heart; the user can rename or
  delete it like any other). A freshly-PUT page item with no memberships is allowed transiently
  (the two-PUT hash flow depends on it) — file it promptly after the tap.
- **Chapter filing** is the same pair of routes with `chapter` in the path.

## 5. There is no "add to library" separate from filing

The add-to-library button and the add-to-collection button are now the same action at different
granularity. Concretely:

- **Adding to "the library"** = collecting the series into whatever collection your UI treats as
  the default. Pick one (create it lazily like the heart collection), and pass its id as
  `collectionIds` on the collect PUT. A series collected with no memberships is legal but
  transient — it will be swept the moment anything re-files it to zero, and it shows up under
  `GET /library?uncollected=true` in the meantime.
- **"Is this in my library?"** = does a series item exist for these coordinates.
  `GET /library/collected/series/{b}/{s}` answers 200/404; `GET /library` returns them all.
- **The library screen** is `GET /library` with no collection filter — every collected series
  regardless of which collections hold it. Filter chips are `?collection=`. That is unchanged in
  shape from what you have; only the title field renamed.

## 6. Removing a series cascades — but NOT to read state

Three different actions can now remove a series, where before there was only one:

1. `DELETE /library/collected/series/{b}/{s}` — the explicit remove.
2. `PUT …/series/{b}/{s}/collections` with `[]` — un-filing the last collection.
3. `DELETE /library/collections/{id}` — deleting a collection that was some series' only one.

All three run the same cascade, which takes the **offline series detail, cached chapter list, cover
blob, activity feed and group membership**. Those are all caches or derived state; the next sync
refills them.

**Read progress and tracker links survive.** This is deliberate and it is the thing to internalize:
since deleting a collection can now remove a series, letting the cascade reach read state would
mean tidying your shelves silently destroys where you were up to. It doesn't. Uncollect a series
and re-collect it later and the reader is back exactly where it was, chapter read flags intact —
the behaviour you'd expect from Mihon, where the `favorite` bit and chapter read state are
independent.

So the collection-delete confirmation does **not** need to warn about losing progress. It should
still say the series leave the library (they vanish from the grid), which you can count with
`GET /library?collection={id}` filtered on `collectionIds.length === 1`.

Destroying read state is now only ever explicit:

```
DELETE /library/collected/series/{b}/{s}/progress    → { ok: true }
```

New route. Clears every chapter's read state and the resume point. It deliberately works on a
series that is **no longer collected**, which is how progress left behind by an uncollect gets
reclaimed — worth wiring into a storage/maintenance screen if you have one, since nothing sweeps
those automatically (runtime followups §9).

Chapter and page items are **not** taken by the cascade either. Their memberships are their own, so
un-collecting a series leaves its collected pages intact and browsable — collecting a panel from a
series you never tracked still works exactly as before.

## 7. Behaviour you get for free (nothing to build)

`syncChapters` — which the host already runs for collected series — re-anchors chapter AND page
items when a source re-uploads a chapter under a new id with the same `(number, languageCode)`, and
marks unmatched ones `stale` (they un-stale if the id returns). Two client implications only: ids
and indices you hold can be re-keyed by a sync, so refetch rather than cache across sync events
(you already must, since page reconcile re-keys too); and `stale` can appear on chapter items —
give it the same "may no longer be available" affordance as stale pages. Items on series that
aren't collected get no such detection (followups §7).

## 8. Definition of done, app side

- **Library migrated via `importLegacyEntries` (§0), verified on a device with a real library** —
  series, unread counts and resume points all present afterwards. This one is not optional.
- Item client migrated per §§1–3 (mechanical renames; old stored favorites and lists wiped).
- Every `/library/entries/*` call repointed at `/library/collected/series/*`; the collect call
  moved to a coordinate-addressed PUT with `seriesTitle`, expecting `200` and `{ item, … }`.
- `entry.title` → `seriesTitle` and `entry.addedAt` → `collectedAt` swept through the library
  screens.
- Lists UI replaced by collections UI per §4; add-to-library files into a default collection per
  §5; reader heart backed by a lazily-created ordinary collection.
- Collection-delete confirmation says series leave the library — and does NOT claim progress is
  lost, because it isn't (§6). Optionally expose `DELETE …/progress` as an explicit "reset read
  state" action.
- Reader flow unchanged in shape: reconcile on chapter open, `contentHash` on collect (from bytes
  already held — `Image.getCachePathAsync`), indices drive the button.
- Stale affordance extended to chapter items.
- `docs/page-favorites-plan.md` replaced; pin bumped to this branch's head.
