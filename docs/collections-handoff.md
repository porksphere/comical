# Universal collections — migration handoff to `comical-app`

> **Transient document. Delete it when this branch merges.**
> It briefs the `comical-app` session migrating the client from the page-favorites API to the
> universal-collections API. The code is the source of truth on any disagreement.
> (`docs/collections-plan.md` is the design rationale; `docs/page-favorites-followups.md` records
> deferred decisions and stays.)

**Runtime half:** branch `claude/page-favorites-runtime-00agdx`. **Pin the branch head.**

## What happened and what it means for your existing code

You implemented the client against the `/library/favorite-pages` API. That surface is **replaced**,
not extended, twice over:

1. **Generalized**: a collection can now hold **series, chapter, or page items**, and the library's
   custom **lists are deleted** — collections are the one grouping system.
2. **Pure collections**: there is **no local "favorites" concept any more.** An item exists only as
   a member of collections; emptying its memberships removes it, pages included — no bare hearts.
   The word "favorites" now belongs exclusively to the bridge-account capability
   (`/bridges/:id/favorites`), which is untouched. The local vocabulary is *collect / collected /
   collection item* throughout.

No aliases, no compat, no data migration anywhere (single-user decision; existing lists data and
any favorites data your build wrote are abandoned).

The good news: **your logic mostly survives — this is largely a rename migration.** Everything
behavioural you built against is unchanged: merge-on-PUT (the two-PUT hash flow stays safe), the
reconcile request/response shapes, indices-excludes-stale, sort/dir semantics, `__direct__`,
coordinates-never-ids, 404-when-no-library. What changed is names, paths, one new `type` dimension,
the lists feature folding in — and one real semantic change: **zero memberships = the item is
removed** (so the `UNCOLLECTED` sentinel is gone too).

Your app-side `docs/page-favorites-plan.md` is stale again — rewrite or delete it against this.

## 1. Route migration table

| You call today | Call instead | Notes |
|---|---|---|
| `GET /library/favorite-pages?…` | `GET /library/collected?type=page&…` | Same query params plus `type`. **Omitting `type` returns the mixed union** (series/chapter items too) — pass `type=page` anywhere your grid expects pages only. |
| `GET /library/favorite-pages/chapter/{b}/{s}/{c}` | `GET /library/collected/page/{b}/{s}/{c}/indices` | Response unchanged (`number[]`). |
| `POST …/favorite-pages/chapter/{b}/{s}/{c}/reconcile` | `POST /library/collected/page/{b}/{s}/{c}/reconcile` | Body and response **unchanged**. |
| `PUT/DELETE /library/favorite-pages/{b}/{s}/{c}/{i}` | `PUT/DELETE /library/collected/page/{b}/{s}/{c}/{i}` | Body unchanged. Response now carries `type: "page"` and a `page:`-prefixed id. |
| `PUT …/favorite-pages/{b}/{s}/{c}/{i}/collections` | `PUT /library/collected/page/{b}/{s}/{c}/{i}/collections` | Unchanged body. |
| `GET/POST /library/favorite-pages/collections` | `GET/POST /library/collections` | Promoted to top level. |
| `PATCH/DELETE …/favorite-pages/collections/{id}` | `PATCH/DELETE /library/collections/{id}` | |
| `POST …/favorite-pages/collections/reorder` | `POST /library/collections/reorder` | Still `{ orderedIds }`. |
| `GET /library?list=` / `?lists=` / `?unlisted=` | `?collection=` / `?collections=` / `?uncollected=` | |
| `GET/POST /library/lists`, `PATCH/DELETE /library/lists/{id}`, `POST /library/lists/reorder` | `/library/collections` equivalents | **Lists routes are gone.** Same CRUD shapes throughout. |
| `PUT /library/entries/{b}/{s}/lists` | see §4 — series items | **Gone.** Filing a series is now a series item + memberships. |

New routes you did not have before:

```
PUT    /library/collected/series/{b}/{s}              ← { seriesTitle, thumbnailUrl?, author? }
DELETE /library/collected/series/{b}/{s}
PUT    /library/collected/series/{b}/{s}/collections  ← { collectionIds }
PUT    /library/collected/chapter/{b}/{s}/{c}         ← { seriesTitle, chapterName?, number?, languageCode? }
DELETE /library/collected/chapter/{b}/{s}/{c}
PUT    /library/collected/chapter/{b}/{s}/{c}/collections ← { collectionIds }
```

Send `number`/`languageCode` on chapter PUTs when you have them — they are the chapter's re-anchor
identity (§5).

## 2. Type migration table (`@comical/library`, type-only imports)

| You import today | Import instead | Notes |
|---|---|---|
| `FavoritePage` | `CollectionPageItem` | Same fields plus `type: "page"`; `favoritedAt` is now `collectedAt`. Union: `CollectionItem`. |
| `FavoritePagesQuery` / `FavoritePagesSort` | `CollectionItemsQuery` / `CollectionItemsSort` | Query gains `type?`; no `uncollected` sentinel. |
| `FavoritePageScope` | `CollectionItemScope` | Gains `type?`. |
| `favoritePageId` / `parseFavoritePageId` | `collectionItemId` / `parseCollectionItemId` | Coord now carries `type`; ids are prefixed: `page:b:s:c:i`, `chapter:b:s:c`, `series:b:s`. |
| `FavoritePageSnapshot` | `PageItemSnapshot` | Same fields. |
| `FavoriteCollection` | `Collection` | Same fields. |
| `ChapterPageRef` | unchanged | |
| `UNCOLLECTED` | **gone** | Zero memberships removes the item, so nothing is durably uncollected. |
| `LibraryList`, `LibraryEntry.listIds` | **gone** | Nothing replaces `listIds` on the entry — memberships live on series items (§4). |

New: `CollectionItem`, `CollectionSeriesItem`, `CollectionChapterItem`, `SeriesItemSnapshot`,
`ChapterItemSnapshot`, `CollectionItemCoord`, `CollectionItemType`.

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
| `listLists` / `putList` / `deleteList` | **delete these** and their documents |

Details that matter:

- **Sharding carries over as-is**: a series ANCHOR lives in its own series' shard, so one layout
  covers all three types. Rename keys to `comical:lib:collection-items:{bridgeId}:{seriesId}` and
  drop any old `favorite-pages` keys — record ids changed prefix, so old records are invalid
  anyway; wipe, don't migrate.
- `getCollectionItem(id)` still finds its shard via `parseCollectionItemId(id)` — every coordinate
  type carries bridge+series.
- **One subtle scope rule**: a `chapterId`-scoped listing must exclude series items (they have no
  `chapterId`) — i.e. `scope.chapterId` set ⇒ skip `type === "series"` and skip non-matching
  chapterIds. Both reference stores do exactly this; copy them.
- Old `lists.json`-equivalent keys and `listIds` in stored entries: abandon in place, never read.

## 4. The lists UI becomes the collections UI

This is the real new work; the item migration above is mechanical.

- **CRUD/reorder screens**: point at `/library/collections*`. Shapes are identical to lists
  (`{id, name, order}`, `{orderedIds}`), so the UI logic ports directly.
- **Filing a series** (the old "add to list"):
  1. `PUT /library/collected/series/{b}/{s}` with `{ seriesTitle, thumbnailUrl?, author? }` (you
     have all three on the entry) — idempotent, safe to repeat;
  2. `PUT /library/collected/series/{b}/{s}/collections` with the full membership array.
- **Reading a series' memberships** (the old `entry.listIds`):
  `GET /library/collected?type=series&series={b}:{s}` → `item.collectionIds` (empty result =
  unfiled). For the library screen's filter chips, the `?collection=` param on `/library` does the
  join server-side — you don't need memberships client-side to filter.
- **Un-filing to zero**: just PUT `collections: []` — the server removes the item and returns
  `{ removed: true }` instead of the item. (A DELETE on the coordinates does the same; both are
  fine.) This applies to **every type, pages included** — pure collections, no bare hearts.
- **Collection delete** strips survivors and removes any item — every type — whose last membership
  it was, server-side. Your UI needn't strip members itself, and should expect pages in a deleted
  collection to be gone unless they were also filed elsewhere.
- **The reader's heart**: with no bare page hearts, the one-tap heart = membership in a lazily
  created, ordinary "Favorites"-style collection (create it on first heart; the user can rename or
  delete it like any other — deleting it deletes the hearts in it, which is the consistent
  behaviour). A freshly-PUT page item with no memberships is allowed transiently (the two-PUT hash
  flow depends on it) — file it promptly after the tap.
- **Chapter filing** is the same pair of routes with `chapter` in the path — an "add chapter to
  collection" affordance wherever you want it.
- **Collection browse**: `GET /library/collected?collection={id}` returns the mixed union — switch
  on `type` and render each variant natively (series tiles have `thumbnailUrl`; page tiles
  re-resolve the page URL as you already do; chapter rows from `seriesTitle`/`chapterName`).
  `sort=chapter` interleaves sensibly (series lead their chapters, chapters lead their pages).

## 5. Behaviour you get for free (nothing to build)

`syncChapters` — which the host already runs for library series — now re-anchors chapter AND page
favorites when a source re-uploads a chapter under a new id with the same `(number, languageCode)`,
and marks unmatched ones `stale` (they un-stale if the id returns). Two client implications only:
ids and indices you hold can be re-keyed by a sync, so refetch rather than cache across sync
events (you already must, since page reconcile re-keys too); and `stale` can now appear on chapter
items — give it the same "may no longer be available" affordance as stale pages. Items on
non-library series get no such detection (followups §7).

## 6. Definition of done, app side

- Item client migrated per §§1–3 (mechanical renames; old stored favorites wiped).
- Lists UI replaced by collections UI per §4; reader heart backed by a lazily-created ordinary
  collection; un-filing via `collections: []` (server removes and reports `{ removed: true }`).
- Reader flow unchanged in shape: reconcile on chapter open, `contentHash` on collect (from bytes
  already held — `Image.getCachePathAsync`), indices drive the button.
- Stale affordance extended to chapter items.
- `docs/page-favorites-plan.md` replaced; pin bumped to this branch's head.
