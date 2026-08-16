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
- `contentHash` as the spec described it — a signal the host computes by fetching pages. It exists,
  but the CLIENT supplies it and only for pages it already holds bytes for (see §4);
- `putFavoriteCollections` as the only store addition — the favorites seam is now
  `listFavoritePages(scope?)` / `getFavoritePage` / `putFavoritePages` / `deleteFavoritePages`,
  alongside the collections pair.

The route table also moved after an API review. As shipped:

```
GET    /library/favorite-pages?sort=&dir=&collection=&series=&q=
GET    /library/favorite-pages/chapter/{b}/{s}/{c}                  → number[]
POST   /library/favorite-pages/chapter/{b}/{s}/{c}/reconcile        ← { pages: [{ url?, contentHash? }] }
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

## 4. Re-anchoring strength depends on how much of a chapter the reader has actually seen

`reconcileChapterFavorites` runs a ladder of signals, ordered so each can only ever HELP. Both
inputs are unreliable in opposite ways — `contentHash` is sparse, `sourceUrl` rotates — so misses are
not treated as evidence and only hits are acted on:

1. **hash hit** anywhere in the list → relocate. Survives URL rot and a re-upload under a new id.
2. **URL hit** → relocate. Free, and covers the common case.
3. **hash present at the favorite's own index and different** → the saved page is provably not
   there, and 1–2 already failed to find it: `stale`.
4. **page count** → unchanged means assume unchanged; changed means unplaceable, so `stale`.

**Nothing ever asks a caller to hash a whole chapter** — that would mean downloading it just to open
it. Clients send whatever hashes they hold (typically the page or two the reader displayed), and
favorites **adopt** hashes they are handed, so a chapter becomes more rot-proof the more of it the
user actually reads. No extra fetch is ever involved.

What this means in practice: a favorite the user has revisited is strongly anchored; one saved long
ago and never reopened has only its URL, and on a rotating-URL source will fall through to the page
count. That is the intended trade, not a defect — but it does mean **coverage is a function of
reading behaviour**, which is worth remembering before blaming the matcher for a miss.

The remaining true gap is narrow: a same-length re-upload, on a rotating-URL source, of a page the
reader has never had bytes for. Rule 3 catches it the moment the reader opens that page. Closing it
without reading would need a perceptual hash (to survive re-encoding) plus a full chapter fetch —
both far more than the problem is worth.

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
