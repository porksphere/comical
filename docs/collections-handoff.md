# Universal collections — handoff to `comical-app`

> **Transient document. Delete it when this branch merges.**
> It briefs the `comical-app` session building the client half; the API it snapshots lives in the
> code, which wins on any disagreement. (`docs/page-favorites-followups.md` records deferred
> decisions and stays; `docs/collections-plan.md` is the design rationale.)

**Runtime half:** branch `claude/page-favorites-runtime-00agdx`. **Pin the branch head.**

## ⚠️ This supersedes the page-favorites design entirely

If you built or planned against `page-favorites-handoff.md` or any `/library/favorite-pages` route:
that surface is **gone**. The feature generalized into one system — favoriting a **series, chapter,
or page** into user **collections** — and the library's custom **lists are deleted with no
migration** (existing lists data is abandoned; single-user decision). Also gone:
`LibraryList`, `LibraryEntry.listIds`, `/library/lists*`, `PUT /library/entries/{b}/{s}/lists`, and
`/library?list=|lists=|unlisted=`. Nothing aliases them.

## 1. Types — import type-only from `@comical/library`

```ts
type FavoriteItemType = "series" | "chapter" | "page";

// Discriminated union; `type` is the discriminator. All items carry:
//   id            — DERIVED from type+coordinates (e.g. "page:b:s:c:3"). NEVER put one in a URL:
//                   re-anchoring re-keys records, so held ids go stale. Address by coordinates.
//   favoritedAt   — epoch ms
//   collectionIds — [] = uncollected
//   seriesTitle   — display snapshot (all snapshot fields render offline / after bridge removal)
//   stale?        — target could no longer be located; render with a "may be gone" affordance,
//                   never highlight/navigate from it, never delete it
type FavoriteItem =
  | { type: "series";  bridgeId; seriesId; thumbnailUrl?; author?; ... }
  | { type: "chapter"; bridgeId; seriesId; chapterId; chapterName?; number?; languageCode?; ... }
  | { type: "page";    bridgeId; seriesId; chapterId; pageIndex; chapterName?; pageCount?;
                       sourceUrl?; contentHash?; ... };

type FavoriteCollection = { id: string; name: string; order: number };
type ChapterPageRef = { url?: string; contentHash?: string };
```

Snapshot types for PUTs: `FavoriteSeriesSnapshot` (`seriesTitle`, `thumbnailUrl?`, `author?`),
`FavoriteChapterSnapshot` (`seriesTitle`, `chapterName?`, `number?`, `languageCode?` — send
number/language when you have them, they are the chapter's re-anchor identity),
`FavoritePageSnapshot` (`seriesTitle`, `chapterName?`, `pageCount?`, `sourceUrl?`, `contentHash?`).
Helpers: `favoriteItemId`, `parseFavoriteItemId`, `UNCOLLECTED`.

## 2. `AsyncStorageLibraryStore`: six methods change, three go

**Delete**: `listLists` / `putList` / `deleteList` (and any lists documents handling).

**Implement**:

```ts
listFavoriteItems(scope?: { type?; bridgeId?; seriesId?; chapterId? }): Promise<FavoriteItem[]>;
getFavoriteItem(id: string): Promise<FavoriteItem | undefined>;
putFavoriteItems(items: FavoriteItem[]): Promise<void>;
deleteFavoriteItems(ids: string[]): Promise<void>;
listFavoriteCollections(): Promise<FavoriteCollection[]>;
putFavoriteCollections(collections: FavoriteCollection[]): Promise<void>;
```

The three load-bearing requirements (violations won't fail tests, they make the reader slow at a
few thousand favorites):

1. **Honour `scope`** — it keeps a chapter open off the whole-library path. Filter before parsing
   where possible.
2. **Batch = ONE durable write** per call, however many records.
3. **Shard per series**: key per series (e.g. `comical:lib:favorite-items:{bridgeId}:{seriesId}`
   holding `{ [id]: FavoriteItem }`). A series ANCHOR lives in its own series' shard, so one layout
   covers all three types. `getFavoriteItem(id)` finds its shard via `parseFavoriteItemId(id)`
   (every coordinate type carries bridge+series). Measured on the file store: 64ms → 3.4ms per
   chapter-open reconcile at 25k favorites.

Collections stay one document. Everything through `serializeAsyncMethods` as usual.

## 3. HTTP routes

```
GET    /library/favorites?type=&sort=&dir=&collection=&series=&q=   → FavoriteItem[] (mixed union)
GET    /library/favorites/page/{b}/{s}/{c}/indices                  → number[]   (reader path)
POST   /library/favorites/page/{b}/{s}/{c}/reconcile                ← { pages: ChapterPageRef[] }
                                                                    → { indices, repaired, stale }
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
POST   /library/collections            ← { name } → collection (201)
PATCH  /library/collections/{id}       ← { name }
DELETE /library/collections/{id}       (see prune note below)
POST   /library/collections/reorder    ← { orderedIds }

GET    /library?collection=&collections=&uncollected=&q=&unreadOnly=&sort=&dir=
```

- Coordinates URL-encoded; `{c}` carries `__direct__` for chapterless series. All routes 404 with
  no library mounted.
- **Every item PUT is idempotent and MERGES**: supplied fields win, omitted fields are preserved
  (`favoritedAt`/`collectionIds` carry; `stale` clears). The page two-PUT flow (favorite on tap,
  send `contentHash` in a follow-up PUT — never block the tap on Hermes-shim hashing; hash from
  bytes you already hold, e.g. `Image.getCachePathAsync`) is safe by design and tested.
- **Collection delete prunes** series/chapter items left with zero memberships (they only existed
  as members — bare hearts are a page-only affordance, app policy). Bare pages survive.

## 4. Behaviour the client builds on

- **Reader (pages)**: on chapter open, `POST …/page/…/reconcile` with the page list you already
  fetched (`{url}` per page; add `contentHash` only for pages whose bytes you hold — sparse is
  expected). Drive the favorite button from the returned indices; no per-page checks. Fall back to
  `GET …/indices` when you don't have the list.
- **Chapters re-anchor themselves**: `syncChapters` (which the host already runs on library series)
  re-keys chapter favorites — and page favorites inside them — when a chapter is re-uploaded under
  a new id with the same `(number, languageCode)`; unmatched ones go `stale`. Favorites on
  non-library series get no such detection.
- **Library tab**: the lists UI re-points at collections. Filing a series =
  `PUT /library/favorites/series/{b}/{s}` + its `/collections` route; the library grid filters via
  `?collection=` / `?uncollected=`. Un-filing to zero collections prunes the series item (the
  LIBRARY entry is untouched).
- **Collection browse**: `GET /library/favorites?collection=X` returns the mixed union — render per
  `type` with native primitives. No thumbnail endpoint exists; resolve images client-side (series
  tiles have `thumbnailUrl`; page tiles re-resolve the page URL; text-only fallback when a source
  is gone).

## 5. Definition of done, app side

Store seam swapped (sharded, serialized); lists UI replaced by collections; reader toggle +
reconcile on chapter open with `contentHash` sent on favorite; collection browse with type filter;
stale affordance; pin bumped.
