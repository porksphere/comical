# Comments — plan

Status: **phase 1 built** (2026-11-18): contract 2.2, the core, the host route, the testkit and the
example bridge. The code is the reference for exact shapes; where this plan and the code differ, the
code wins. Phases 2–3 (app, bridges) are next.

Read a source's comments in the app, reply, and vote. This adds an optional bridge capability,
`"comments"`. The source keeps its own accounts and its own moderation: Comical never hosts a
comment.

## What sources do (summary of the survey)

The bridge repos hold the per-site survey (`docs/comments.md` in each). In aggregate:

- **No source comments per page.** None of the ~55 surveyed sources attaches a comment to a page
  image. Comments hang off either the series or the chapter.
- **Most do both.** Most sources that have comments keep a series thread **and** a separate thread
  for each chapter. A few have chapter threads only, or a series thread only. A few series threads
  can also show the chapter comments mixed in, each one tagged with its chapter. Gallery-style
  sources with no chapters have one thread per gallery, which is the series scope.
- **Threading.** All three shapes appear: flat with quotes (forum style), one level of replies
  (the most common), and nesting several levels deep. Replies are usually lazy-loaded behind a
  reply count. Sometimes they come embedded in the parent.
- **Reactions.** Up and down votes, or likes and dislikes, are the common case. Some sources have
  only likes, a single score, or an emoji palette. A few have chapter-level emoji reactions that
  belong to no comment. Counts are almost always visible without logging in.
- **Bodies.** Plain text, a markdown-ish syntax with `||spoiler||`, sanitized HTML, or forum BBCode
  rendered to HTML. Some include GIFs, stickers and inline images. Many have a spoiler flag.
- **Reading is anonymous** nearly everywhere: JSON APIs, HTML fragments, or a third-party embed's
  public API. **Writing needs a site account** almost everywhere, as a cookie session plus CSRF, or
  a bearer token. One source requires a proof-of-work and a CAPTCHA to post, which we will not
  automate (same rule as anti-bot checks). A few queue posts for moderation.
- **Counts are often free.** Many sources already return a comment count with the series details or
  the chapter list, so a count badge costs nothing. Loading the thread itself always costs a request.

Other reader apps: mainstream source-extension apps rejected comment features, for moderation and
maintenance reasons, and point users to "open in WebView". One fork adds comment buttons on chapter
rows, the details header and the reader toolbar, and opens a web thread from each. Publisher apps
show comments at the end of each episode, with likes and replies. Lessons:

- Show the count before loading the thread.
- Give comments a real sheet or screen. Never draw them as fake reader pages: an extension that
  did this broke double-page spreads.
- Treat "no thread yet" as different from "zero comments".
- Always offer "open on the site" as a fallback.

## What we need to support

The minimum the design has to cover to serve every surveyed source. Anything less leaves a source
out; anything more has no source asking for it.

| Dimension | Must support | Not needed |
|---|---|---|
| Scope | series thread, chapter thread; a series thread that mixes in tagged chapter comments | page-level comments |
| Threading | flat (with quotes), one level of replies, nested several levels deep; replies embedded or lazy behind a count | — |
| Paging | cursor (opaque, as elsewhere in the contract), or page number encoded as a cursor; "everything in one response" | — |
| Sorting | source-defined sorts (newest / top / best / oldest…), or none | client-side sorting |
| Body | plain text, bold / italic / strike / code, links, mentions, inline images and GIFs, quotes, spoiler spans, line breaks; whole-comment spoiler flag | arbitrary HTML, embeds, video |
| Metadata | author name, avatar, profile link, role badge (creator / staff / mod); absolute **or** relative time; edited, pinned, "mine" flags; permalink | user profiles, follower counts |
| Votes | up only (likes), up + down, or a single score; the viewer's own vote | — |
| Reactions | display emoji counts per comment | setting emoji reactions (later), thread-level chapter reactions (later) |
| Counts | optional comment count on the series and on each chapter when free; "no thread yet" ≠ zero | an extra request just for a count |
| Auth | anonymous read; writes signal `loginRequired`; per-thread "can I post here" | captchas, proof-of-work, guest name/email posting |
| Writes (phase 4) | post, reply, vote, delete own; "pending moderation" result | edit, report, block (later) |
| Fallback | open the thread / comment on the site in the in-app WebView | — |

## Design

### Scope

A thread is addressed by `{ seriesId, chapterId? }`, so there are two scopes: series and chapter.
No page scope, since no source has one. The target is an object rather than two parameters, so a
scope added later is a new field, not a new method.

### Contract (`@comical/contract`)

Every change below is additive.

**Capability** `"comments"` in `bridgeCapabilitySchema`. It is also added to
`host-rn/src/capabilities.ts` (a test enforces that) and to the testkit's `CAPABILITY_METHOD`.

**`BridgeInfo.comments`** is an optional, static description, declared up front like `ratings`, so a
client knows what UI to reserve before any request:

```ts
comments?: {
  scopes: ("series" | "chapter")[];          // where threads exist
  sorts?: { id: string; label: string }[];   // first = default; omitted = source order
  votes?: "up" | "up-down" | "score";        // how comment votes read; omitted = none
  reactions?: { id: string; emoji: string; label?: string }[]; // emoji palette, if any
  maxDepth?: number;                          // 1 = flat; replies deeper than this are flattened
}
```

**Optional count fields**: `Chapter.commentCount?` and `SeriesInfo.commentCount?`. A bridge fills
them only when the source already returned the number, and never makes an extra request for them.

**Methods** on `Bridge`. `getComments` alone is enough to advertise the capability, and each write is
optional on its own, as with favorites:

```ts
getComments?(req: CommentsRequest): Promise<CommentPage>;
postComment?(req: PostCommentRequest): Promise<CommentPostResult>;
setCommentVote?(req: CommentVoteRequest): Promise<CommentVotes>;           // "up" | "down" | null
setCommentReaction?(req: CommentReactionRequest): Promise<CommentReaction[]>; // emoji id | null
deleteComment?(req: CommentRef): Promise<void>;                             // own comments
```

`CommentsRequest` is `{ target, sort?, cursor?, parentId? }`. With `parentId` it lists that
comment's replies, so lazy replies and "continue this thread" need no second method.

**Models**. The body is data, never HTML, per "presentation is data":

```ts
Comment {
  id; parentId?; url?;                        // url = permalink, for "open on site"
  author: { name; avatar?; url?; role?: "creator" | "staff" | "moderator"; badges?: string[] };
  body: CommentNode[];
  createdAt?: number;                         // epoch ms; when the source gives only "3 hours ago":
  createdLabel?: string;                      //   pass it through as a label
  edited?: boolean; pinned?: boolean; spoiler?: boolean; mine?: boolean;
  labels?: string[];                          // the source's own comment chips, e.g. "Top"
  replyTo?: { name; excerpt? };               // who a reply answers, kept when depth is flattened
  chapter?: { id; name };                     // a chapter comment shown in a series thread
  votes?: { up?: number; down?: number; score?: number; mine?: "up" | "down" };
  reactions?: { id; count; mine? }[];
  replyCount?: number;
  replies?: Comment[];                        // when the source embeds them
}
CommentNode =
  | { type: "text"; text; bold?; italic?; strike?; code?; spoiler? }
  | { type: "link"; text; url }
  | { type: "mention"; name; url? }
  | { type: "image"; url; width?; height?; animated? }   // GIFs, stickers, inline images
  | { type: "quote"; author?; children: CommentNode[] }
  | { type: "break" }                                     // paragraph / line break
CommentPage {
  items: Comment[]; nextCursor?; total?;
  viewer?: { canPost: boolean; loginKey?: string };      // phase 4 only — not in contract 2.2
  webUrl?: string;                                        // the thread on the site
  closed?: boolean;
}
CommentPostResult = { comment: Comment } | { pending: true; message?: string }  // moderation queue
```

Limits are enforced in the schemas: body length, node count, nesting depth, and how deep `replies`
can go.

### Core (`loader.ts`)

Wrap each method like the favorites block:

- `validateInput`: the target, a body length cap of about 10k characters, and the cursor length.
- Output validation.
- Image URLs (avatars, image nodes) are routed through the image router, the same way series
  thumbnails are, so headers, interception and host allowlists apply. Bridges add GIF/sticker CDNs
  to `info.images.hosts`.

Clients never parse HTML.

**Capabilities and the contract version (built).** `capabilities` parsing now drops values the
runtime doesn't know and logs them, instead of failing `bridgeInfoSchema` and with it the whole
bridge. That protects future capabilities. It can't help apps already installed, so comments also
bump the contract to 2.2.0: a bridge that adopts comments declares 2.2.0, and an app older than that
refuses it with a clear "incompatible contract" message. Publish a bridge's comments only after the
app with contract 2.2 has shipped.

### SDK / bridge kit

The kit gets pure helpers to turn a source's body into `CommentNode[]`:

- `htmlToCommentBody` (cheerio is already bundled): an allowlist of tags, with everything else
  reduced to text;
- `markdownishToCommentBody`: `**`, `*`, `` ` ``, `||spoiler||`, links, image links;
- `textToCommentBody`.

It also gets `relativeTimeToIso` as a best effort, and a reply-tree helper that builds
`replies`/`parentId` from flat lists. One set of fixture tests covers all the shapes.

### host-server routes

| Route | Method |
|---|---|
| `GET /bridges/:id/series/:seriesId/comments?chapterId&sort&cursor&parentId` | getComments |
| `POST /bridges/:id/series/:seriesId/comments` `{chapterId?, parentId?, body, spoiler?}` | postComment |
| `PUT /bridges/:id/series/:seriesId/comments/:commentId/vote` `{chapterId?, vote}` | setCommentVote |
| `PUT /bridges/:id/series/:seriesId/comments/:commentId/reaction` `{chapterId?, reaction}` | setCommentReaction |
| `DELETE /bridges/:id/series/:seriesId/comments/:commentId?chapterId` | deleteComment |

- An absent method returns 400 `not supported`, as favorites does.
- Errors go through the existing `bridgeErrorResponse`. That includes 401 `loginRequired`, which
  writes use: the first shipping use of `loginRequiredMessage`.
- Content-rating redaction does not apply, because a comment is not a series entry.

Tests follow the HTTP integration pattern: happy path, absent method, `loginRequired` → 401, a
pending post, and an over-long body → 400.

### Testkit and example bridge

- `FixtureBackend` gets an in-memory thread: series and chapter scopes, one level of replies, votes,
  and writes gated on the Authorization header.
- The example bridge implements the full surface.
- The conformance probe is read-only: it calls `getComments` on a fixture series, and never writes.

### App (`comical-app`)

**Data.**

- `api.ts` wrappers, plus a `DataSource` method in both the real and the mock source.
- `queryKeys.comments(mock, bridgeId, target, sort, parentId)` drives a `useInfiniteQuery`, using
  the existing `NO_CURSOR`/`nextCursor` helpers.
- The key goes in `NO_PERSIST_KEYS`.
- Votes and reactions are optimistic mutations, copying `use-favorite.ts`: `onMutate` patches the
  cached page, `onError` rolls back.
- Posting appends on success. A `pending` result shows a "waiting for the site's moderators" toast.
- `commentsStatusOf(summary)` gates the UI, like `favoritesStatusOf`, and returns `unsupported |
  read-only | login | ready`.

**Entry points** (one per scope, as other apps do):

1. **Series details.** A "Comments · 787" row sits under the description and opens the thread
   screen. It shows only when `info.comments.scopes` includes `"series"`. The count is shown only
   when `SeriesInfo.commentCount` is set. Nothing loads until the row is tapped.
2. **Chapter rows.** The chapter menu gets a "Comments" item when `"chapter"` is a scope. Rows show a
   small count in `rowMeta` when `Chapter.commentCount` is set.
3. **Reader.** The webtoon reader's end-of-chapter footer (`ChapterSentinel`) gets a "Comments (N)"
   button. The toolbar gets a comments button for the current chapter, which covers paged mode
   too, since that mode has no end card. Both open a sheet over the reader, using the overlay
   system with `useSheetScroll`, so reading position is never lost.

**Thread UI.** One component, shown as a screen from details and as a sheet in the reader. Its
layout follows what the top sources converge on, from a read-only browser survey of ten of them on
2026-11-17:

- **Header.** "Comments" plus the count when the source gives one. Counts are abbreviated (1.2K,
  15.4K); with no count, the title stands alone.
- **Sort.** The options come from `info.comments.sorts`, and the first is the default. Most sources
  lead with Best/Top/Relevant; a minority lead with newest.
  - Three or fewer options: a segmented control.
  - More than three: a "Sort: Relevant ▾" button that opens a picker sheet. Sources offer up to five.
  - No sorts: no control at all.
  - The chosen sort is kept per bridge for the session.
- **Pinned and top comments** stay in the list, marked with a small chip ("Pinned", or the source's
  own label such as "Top"). They don't get a separate section.
- **Card.**
  - Avatar: a 32px circle, with an initials circle when there is none.
  - Then the name, then role chips (Creator / Staff / Mod) with an optional name tint.
  - Time: short relative ("16h", "3d", "2mo") under a week old, then an absolute date. Long-press
    shows the full date. Sources that give only a label ("3 hours ago") show that label.
  - "(edited)" when the comment was edited.
  - Body: clamped to about 6 lines with "Show more".
  - Images and GIFs: thumbnails capped at about 200px, tap for full screen.
  - Votes: a read-only row under the body (▲ 12 ▼ 3, or 👍 12, or emoji counts), with nothing
    tappable.
  - Overflow menu: "Open on site" and "Copy text".
- **Replies.**
  - Two visual levels: top level, plus one indented level with a thin left rule.
  - Replies start collapsed behind "View N replies", fetched with `parentId`. Embedded replies show
    the first 3, then "Show N more".
  - Deeper replies are flattened into the second level, each with a "↳ Name: quoted snippet" line
    (`replyTo`) so the context survives, instead of indenting further.
- **Paging.** Infinite scroll with a footer spinner, plus "Load N more replies" inside a thread.
  Sources that return everything at once are virtualized all the same.
- **Spoilers.** Inline spoilers are grey blocks you tap to reveal. A whole-comment spoiler collapses
  to a "Spoiler · tap to show" bar.
- **Empty and footer.** The empty state says "No comments yet". There is no composer; the footer has
  "Open on [bridge name]", which opens `webUrl` in the in-app WebView, for anyone who wants to post.
- **Chapter comments never open by themselves**: you have to tap through, which keeps them from
  spoiling the chapter. A series thread that includes chapter comments tags each one with a chapter
  chip.

`CommentNode` renders as nested `Text` spans and `expo-image`, with no HTML or WebView.

**Composer (phase 4, not in the read-only build)** at the bottom (`useKeyboardAvoidingInput`), with a "Replying to X" banner and a
spoiler toggle. Which version shows depends on `commentsStatusOf`:

- `login`: "Log in to comment". This goes to bridge settings, which is the existing favorites flow.
- `read-only` (no `postComment`): "Comment on the site". This opens `webUrl` in the in-app WebView
  the app already uses for web login, so the cookies are shared.

**Settings.** A toggle to hide comments everywhere, plus one per bridge. Comments follow the same
visibility rules as the bridge itself.

**Out of scope for now: report and block user.** Each comment's `url` already lets a user report it
on the site. Add these if the app ever ships through a store that reviews user-generated content
(the App Store's guideline 1.2, Google Play's UGC policy). That release would also hide comments with
a build-time flag in `commentsStatusOf`. It must not be a remote toggle, which stores count as a
hidden feature. Sideloaded and APK builds need neither.

## Phases

1. **Contract and host, read-only** (built). Tolerant capabilities and a 2.2.0 bump, the models and
   `getComments`, the count fields, loader wrapping, the GET route, the testkit and example bridge,
   kit body helpers, and README rows.
2. **App, read-only.** The data layer, the three entry points, the thread screen and sheet, the
   global and per-bridge toggles. Build it against the mock source
   and the example bridge, plus a Maestro flow.
3. **Bridges, read-only.** Start with sources that have clean JSON APIs and both scopes, then the
   shared engines (one engine covers several sites), then HTML-scraped sources. The bridge repos'
   survey lists the order.
4. **Votes and posting.** `setCommentVote`, `postComment` and `deleteComment` on the example
   bridge, then on bridges that already hold a login. Other bridges get a `web-login` setting
   (cookies captured in the WebView) as they adopt writes. Sources with deliberate posting barriers
   stay read-only.
5. **Later, only if asked:** emoji reactions you can set (show counts in phase 2), thread-level
   chapter reactions, editing, reply notifications, and report / block user.

## Decisions (2026-11-17)

- **Read-only first.** Build phases 1–3. Phase 4 (votes, posting) is deferred; its contract methods
  stay sketched here so the read models leave room for them, but none are built. Until then, threads
  offer "Open on the site" in place of a composer.
- **Series details: a plain "Comments" row** that opens the thread screen, with the bridge's own
  sort options (`info.comments.sorts`) on that screen. No inline preview, so nothing loads until it is
  tapped. The thread screen's layout follows how the top sources present comments (see "Thread UI").
- **On by default.** The global and per-bridge toggles exist to turn comments off.
- **No posting for now**, so no login or `web-login` work in this feature.
