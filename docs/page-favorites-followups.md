# Page favorites — deferred work

Things knowingly left undone when page favorites landed in this repo
(`claude/page-favorites-runtime-00agdx`). Each is a decision, not an oversight — the reasoning is
recorded so a later pass can re-weigh it rather than rediscover it.

## 1. The `comical-app` spec doc is stale — update it before the app half starts

`comical-app`'s `docs/page-favorites-server-spec.md` (branch `claude/page-favoriting-feature-yev9l6`)
describes the design as first written, and the implementation moved twice after review. It still
documents:

- the thumbnail-capture subsystem, `favoritePages: { blobs, fetchPage }`, and
  `GET /library/favorite-pages/{id}/thumb` — **all removed**, no page bytes are stored;
- `hasThumb` on `FavoritePage` — **removed**;
- `contentHash` re-anchoring — **removed** (see §4);
- `putFavoriteCollections` as the only store addition — the favorites seam is now
  `listFavoritePages(scope?)` / `getFavoritePage` / `putFavoritePages` / `deleteFavoritePages`,
  alongside the collections pair.

The route table also moved after an API review. As shipped:

```
GET    /library/favorite-pages?sort=&dir=&collection=&series=&q=
GET    /library/favorite-pages/chapter/{b}/{s}/{c}                  → number[]
POST   /library/favorite-pages/chapter/{b}/{s}/{c}/reconcile        ← { pages: [{ url? }] }
PUT    /library/favorite-pages/{b}/{s}/{c}/{pageIndex}              ← snapshot
DELETE /library/favorite-pages/{b}/{s}/{c}/{pageIndex}
PUT    /library/favorite-pages/{b}/{s}/{c}/{pageIndex}/collections  ← { collectionIds }
GET    /library/favorite-pages/collections
POST   /library/favorite-pages/collections                          ← { name }
PATCH  /library/favorite-pages/collections/{id}                     ← { name }
DELETE /library/favorite-pages/collections/{id}
POST   /library/favorite-pages/collections/reorder                  ← { orderedIds }
```

Differences from the spec worth reading twice: **no `{id}` appears in any path** (favorites are
addressed by coordinates throughout — see §6), `sort` and `dir` are separate as on `/library` (there
is no `oldest` key), reconcile has its own `/reconcile` path, and reorder takes `orderedIds` to match
`/library/lists/reorder`.

The app's `AsyncStorageLibraryStore` must implement the store seam, so that section of the doc is the
part most likely to mislead. This repo is the source of truth; the doc is not.

## 2. Favorites don't render offline

Dropping byte capture means a grid tile re-resolves its page URL to draw. Consequences accepted at
the time:

- the grid needs the network;
- a favorite whose bridge is uninstalled, or whose source is dead, becomes a text-only tile
  permanently (the `seriesTitle` / `chapterName` snapshot still renders, so nothing goes blank).

If this bites, the fix is a **bounded LRU cache of downscaled tiles**, not reinstating full-page
capture — the original version stored the fetched page verbatim (~200KB–1.5MB each), which is what
made it untenable. Downscaling needs an image dependency this repo does not have (no sharp/jimp
here; no `expo-image-manipulator` app-side).

## 3. The full favorites grid still scales with total favorites

Per-chapter work is flat (see the sharding commit's measurements), but an unscoped
`getFavoritePages()` reads every shard: ~5.5ms at 25,000 favorites on `FileLibraryStore`. That's
inherent — the grid renders everything — and fine at realistic sizes. If it becomes a problem, the
answer is cursor paging on the list route, matching how `/library` and bridge listings already page.

Scoped paths are already cheap and covered by tests that assert **call counts and records touched**
(`packages/library/test/favorite-pages.test.ts`, "scaling" describe), so a regression to
list-everything fails loudly rather than just slowing down.

## 4. Re-anchoring cannot catch a same-length re-upload behind rotating URLs

`reconcileChapterFavorites` matches on `sourceUrl`, asymmetrically: a hit relocates the favorite, a
miss proves nothing (sources that sign or expire page URLs miss constantly on untouched chapters).
A miss therefore falls back to the page count, so:

- **caught:** indices shifted by an inserted or removed page — the case it exists for;
- **caught:** a page deleted from the chapter (count changes, URL gone) → marked `stale`;
- **not caught:** a chapter re-uploaded at the *same length* by a source with rotating URLs. The
  favorite keeps pointing at its old index, now possibly the wrong page.

A content hash would catch it. It was deliberately removed: matching on one means hashing the
**fresh** page list, and a client only holds bytes for the page or two it has rendered — so a
hash-matched reconcile would turn opening a chapter into downloading it. If this case turns out to
matter, the affordable shape is **opportunistic** hashing (the reader reports `(index, hash)` only
for pages it actually displays, costing no extra download and improving as the user reads), not a
bulk hash of the list.

## 5. Partial collection reorder can leave tied `order` values

`reorderFavoriteCollections` only repositions the ids it is given; an omitted collection keeps its
existing `order` and can end up tied with another. This is deliberate **parity with
`reorderLists`**, which behaves identically, and clients send the whole list. Worth fixing in both
places at once, or in neither.

## 6. The favorite id is derived from `pageIndex`, which a reconcile can change

`favoritePageId` encodes `(bridgeId, seriesId, chapterId, pageIndex)`. That is what makes favoriting
idempotent and "is this page favorited" a keyed lookup rather than a scan — but it also means
relocating a favorite **re-keys the record**, so an id captured before a reconcile no longer resolves
afterwards.

Mitigated rather than documented: **no route takes an id**. Every favorite route is addressed by
coordinates, including collections assignment, so a client never holds an id that can go stale. The
id stays an internal storage key.

If a future surface genuinely needs a stable external handle (sharing a favorite, say), the choice is
between a random UUID — which costs the keyed lookup and the idempotency — and a separate stable
alias alongside the derived key. Don't reintroduce ids into paths without picking one.
