# Page favorites — handoff to `comical-app`

> **Transient document. Delete it when this branch merges.**
> It exists to brief the `comical-app` session building the client half, and its content is a
> snapshot of an API that lives in the code. Once the app half is written and the pin has moved, this
> file is a second source of truth with no reason to exist — remove it in the merge commit.
> (`docs/page-favorites-followups.md` is NOT transient; it records deferred decisions and stays.)

**Runtime half:** branch `claude/page-favorites-runtime-00agdx`, commit `ac554fd`.
**Pin this commit** in `external/comical` before starting; until then every route below 404s.

---

## ⚠️ Read this before anything else

`comical-app`'s own `docs/page-favorites-server-spec.md` (branch
`claude/page-favoriting-feature-yev9l6`) is **out of date and will actively mislead you.** The design
changed four times during review. That document still describes:

| It says | Reality |
|---|---|
| A thumbnail-capture subsystem, `favoritePages: { blobs, fetchPage }`, `GET /favorite-pages/{id}/thumb` | **Does not exist.** No page bytes are stored anywhere, on device or server. |
| `hasThumb` on `FavoritePage` | **Does not exist.** |
| `contentHash` computed host-side by fetching pages | Exists, but **the client computes it**, only for bytes it already holds. |
| Routes addressed by `{id}` | **No route takes an id.** Everything is coordinates. |
| `sort=added\|oldest\|series\|chapter` | `sort=added\|series\|chapter` **plus a separate `dir`**. |
| Store gains `putFavoriteCollections` and per-item put/delete | Different seam entirely — see below. |

Treat this file and the code as the source of truth. Where they disagree, the code wins.

---

## 1. Types — import type-only from `@comical/library`

Do not redeclare these in `src/data/types.ts`; re-export them, as the app already does for
`LibraryEntryView` / `LibraryList` / `HistoryItem`.

```ts
type FavoritePageCoord = {
  bridgeId: string;
  seriesId: string;
  chapterId: string;   // DIRECT_CHAPTER_ID ("__direct__", from @comical/downloads) for chapterless series
  pageIndex: number;   // 0-based
};

type FavoritePageSnapshot = {
  seriesTitle: string;      // required
  chapterName?: string;
  pageCount?: number;
  sourceUrl?: string;       // the page's image URL right now — a re-anchor key, see §4
  contentHash?: string;     // lowercase hex SHA-256 of the page bytes — the strong re-anchor key
};

type FavoritePage = FavoritePageCoord & {
  id: string;               // DERIVED from the coordinates; internal — see the warning in §3
  favoritedAt: number;      // epoch ms
  collectionIds: string[];  // [] = uncollected
  seriesTitle: string;
  chapterName?: string;
  pageCount?: number;
  sourceUrl?: string;
  contentHash?: string;
  stale?: boolean;          // set when a reconcile could no longer locate this page — see §4
};

type FavoriteCollection = { id: string; name: string; order: number };

type ChapterPageRef = { url?: string; contentHash?: string };  // reconcile payload element

type FavoritePagesQuery = {
  sort?: "added" | "series" | "chapter";   // default "added"
  dir?: "asc" | "desc";                    // default "desc" for added, "asc" otherwise
  collection?: string;                     // a collection id, or the literal "uncollected"
  series?: string;                         // `${bridgeId}:${seriesId}`
  q?: string;                              // matches seriesTitle / chapterName
};
```

Also exported and useful: `favoritePageId(coord)`, `parseFavoritePageId(id)`, `UNCOLLECTED`.

## 2. `AsyncStorageLibraryStore` must implement six new methods

```ts
listFavoritePages(scope?: { bridgeId?: string; seriesId?: string; chapterId?: string }): Promise<FavoritePage[]>;
getFavoritePage(id: string): Promise<FavoritePage | undefined>;
putFavoritePages(pages: FavoritePage[]): Promise<void>;
deleteFavoritePages(ids: string[]): Promise<void>;

listFavoriteCollections(): Promise<FavoriteCollection[]>;
putFavoriteCollections(collections: FavoriteCollection[]): Promise<void>;
```

**Three things this seam requires, not suggests.** Getting them wrong will not fail a test — it will
just make the reader slow in a way nobody notices until a user has a few thousand favorites.

1. **`scope` must actually be honoured.** It is what keeps opening a chapter off the whole-library
   path. Filter *before* deserialising/cloning wherever possible.
2. **A batch call must be ONE durable write**, however many records it carries. A reconcile repairs a
   whole chapter through `putFavoritePages`.
3. **Shard by series.** `FileLibraryStore` writes `favorite-pages/{bridgeId:seriesId}.json`; the
   AsyncStorage equivalent is a key per series, e.g. `comical:lib:favorite-pages:{bridgeId}:{seriesId}`,
   each holding `{ [id]: FavoritePage }`. As one document, every write re-serialises every favorite
   the user has — the difference measured 64ms → 3.4ms at 25k favorites.
   `getFavoritePage(id)` finds its shard via `parseFavoritePageId(id)`.

Collections stay a single document: `comical:lib:favorite-collections` → `FavoriteCollection[]`.

Everything goes through `serializeAsyncMethods`, same as the existing methods — concurrent
read-modify-write on a shared document silently drops records. `diskUsage()` already sums
`comical:lib:*`, so the Storage screen accounts for these with no extra work.

## 3. HTTP routes

```
GET    /library/favorite-pages?sort=&dir=&collection=&series=&q=      → FavoritePage[]
GET    /library/favorite-pages/chapter/{b}/{s}/{c}                    → number[]
POST   /library/favorite-pages/chapter/{b}/{s}/{c}/reconcile          ← { pages: ChapterPageRef[] }
                                                                      → { indices, repaired, stale }
PUT    /library/favorite-pages/{b}/{s}/{c}/{pageIndex}                ← FavoritePageSnapshot → FavoritePage
DELETE /library/favorite-pages/{b}/{s}/{c}/{pageIndex}                → { ok: true }
PUT    /library/favorite-pages/{b}/{s}/{c}/{pageIndex}/collections    ← { collectionIds } → FavoritePage
GET    /library/favorite-pages/collections                            → FavoriteCollection[]
POST   /library/favorite-pages/collections                            ← { name } → FavoriteCollection (201)
PATCH  /library/favorite-pages/collections/{id}                       ← { name } → { ok: true }
DELETE /library/favorite-pages/collections/{id}                       → { ok: true }
POST   /library/favorite-pages/collections/reorder                    ← { orderedIds } → { ok: true }
```

All id segments are URL-encoded as usual; `{c}` carries `__direct__` for chapterless series.
Every route 404s when no library store is mounted, so the existing "this server has no library" empty
state applies unchanged.

> **Never put a favorite's `id` in a URL.** It is derived from the coordinates, so a reconcile that
> relocates a page *changes it*, and a held id will 404. That is exactly why no route accepts one.
> Address favorites by coordinates — you always have them.

**`PUT` is idempotent.** Re-favoriting the same page refreshes the display snapshot but keeps the
original `favoritedAt`, its collection memberships, and its `contentHash`.

## 4. What the client actually has to do

### Favorite button

`PUT` with the snapshot. You are rendering the page, so **hash the bytes you already have** and send
`contentHash` — lowercase hex SHA-256, no extra fetch. This is the single highest-value thing the
client does; everything in §4's repair story gets weaker without it.

### Reader: opening a chapter

You already fetch the page list to display the chapter. Two options:

- **`POST …/reconcile`** with that list — preferred. Returns the indices to trust, repairs favorites
  the source shifted, and flags ones it can't place. Fill in `contentHash` for any page you happen to
  hold bytes for and leave the rest blank; **sparse is expected and safe**, and never fetch a page in
  order to hash it.
- **`GET …/chapter/{b}/{s}/{c}`** — the cheap path when you don't have the list. Returns stored
  indices with no verification.

Then keep that set in memory and drive the favorite button from it. **Do not add a per-page status
check** — it would fire a request per page turn, which is the entire reason the indices route exists.

### Why favorites drift, and what `stale` means

A favorite is a *position*. Sources insert and remove pages, so `pageIndex` rots. Reconcile matches
on hash first, then URL, then falls back to page count. A favorite it can't place is marked
`stale: true` — **never deleted** — and drops out of the reported indices, so the reader must not
highlight it or offer to jump to it. Render it in the grid with a "may no longer be available"
affordance. It un-stales itself if a later reconcile finds the page.

Favorites also *adopt* hashes they're handed, so anchoring gets stronger the more the user reads.

### Grid

`GET /library/favorite-pages` with the query. **There is no thumbnail endpoint** — resolve the page
URL to draw a tile (batch per chapter; don't resolve per tile). Consequences to design around:

- the grid needs the network;
- a favorite whose bridge is uninstalled or whose source is dead has no image, permanently. The
  `seriesTitle` / `chapterName` snapshot still renders, so show a text tile rather than a blank.

### Collections

Straight CRUD, deliberately shaped like `LibraryList` so the existing list UI patterns port over.
Deleting a collection strips it from its members but **never deletes the favorites** — they become
uncollected. Send the whole list to `reorder`, not a partial one.

## 5. Definition of done, app side

- `AsyncStorageLibraryStore` implements the six methods, sharded per series, all wrapped in
  `serializeAsyncMethods`.
- Reader: favorite button driven by the chapter indices set, one call per chapter open, `contentHash`
  sent on favorite.
- Library tab: grid with sort/dir, collection and series filters, search, stale affordance.
- Collections management UI.
- Submodule pin bumped to `ac554fd` (or later) and committed.

## 6. Known gaps, already decided — see `docs/page-favorites-followups.md`

No offline rendering; the full grid scales with total favorites (~5.5ms at 25k, fix is cursor paging
if it matters); re-anchoring strength is a function of how much the user has read; partial collection
reorder can tie `order` values, matching `reorderLists`. Don't re-derive these — the reasoning is
recorded there.
