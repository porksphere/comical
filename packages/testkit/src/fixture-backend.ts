/**
 * A self-contained, legal demo backend: a tiny synthetic "comic library" website serving
 * public-domain titles. It is the reference backend the `example-bridge` parses, and the
 * deterministic fixture the test suite runs against.
 *
 * `handle(req)` answers requests in-process (no socket) for fast, deterministic conformance and
 * snapshot tests. `serve()` exposes the same routes over real HTTP for host-adapter integration.
 *
 * The HTML shape here is the de-facto contract between this backend and `example-bridge`.
 */
import type { HttpMethod, HttpRequest, HttpResponse } from "@comical/contract";

export interface FixtureChapter {
  id: string;
  name: string;
  number: number;
  pages: number;
  /** Scanlation group, for series with multiple copies of a chapter (optional). */
  group?: string;
  /** BCP-47-ish language code (e.g. "en", "es"); defaults to the bridge's language (optional). */
  languageCode?: string;
}

export interface FixtureSeries {
  id: string;
  title: string;
  /** Other names the series goes by (optional). */
  altTitles?: string[];
  author: string;
  description: string;
  genres: string[];
  /** Other taxonomies beyond genres — each a labeled group (optional). */
  tagGroups?: Array<{ label: string; kind?: string; tags: string[] }>;
  /**
   * Related-series rails surfaced on the detail page — each a labeled group referencing other
   * catalog series by id (sequels, "same universe", similar, recommended, …). Optional.
   */
  related?: Array<{ label: string; kind?: string; ids: string[] }>;
  status: "ongoing" | "completed" | "hiatus";
  /** Reader score in this site's own unit — stars out of five — so a bridge has a scale to convert (optional). */
  rating?: { stars: number; votes?: number };
  /** Label/value facts the site lists on the detail page, verbatim (optional). */
  facts?: Array<{ label: string; value: string }>;
  chapters: FixtureChapter[];
}

/** One comment as the fixture's comment API serves it. */
export interface FixtureComment {
  id: string;
  user: string;
  avatar: string;
  text: string;
  up: number;
  down: number;
  /** Epoch ms. */
  at: number;
  pinned: boolean;
  spoiler: boolean;
  /** How many replies it has (fetch them with `?parent=`). */
  replies: number;
}

/** A page of the fixture's comment API. */
export interface FixtureCommentPage {
  total: number;
  comments: FixtureComment[];
  next: number | null;
}

const COMMENT_EPOCH = Date.UTC(2026, 0, 1);
const COMMENT_PAGE_SIZE = 10;

/**
 * A synthetic thread for `key` (a series id, or `seriesId/chapterId`), deterministic so snapshots
 * hold: `size` top-level comments, the first pinned, every fifth from the second with three replies.
 */
export function fixtureComments(
  key: string,
  opts: { parent?: string | null; sort: "new" | "top"; page: number; size: number },
): FixtureCommentPage {
  const make = (id: string, i: number, replies: number): FixtureComment => ({
    id,
    user: `reader${(i * 7 + key.length) % 13}`,
    avatar: `https://picsum.photos/seed/avatar-${(i * 7 + key.length) % 13}/64`,
    text: i % 6 === 3 ? `Comment ${i + 1} on ${key}.\n\nIt has a second paragraph.` : `Comment ${i + 1} on ${key}.`,
    up: (i * 37 + key.length) % 100,
    down: (i * 11) % 20,
    at: COMMENT_EPOCH - i * 3_600_000,
    pinned: false,
    spoiler: i % 9 === 4,
    replies,
  });
  let all: FixtureComment[];
  if (opts.parent) {
    const match = /^c(\d+)$/.exec(opts.parent.split(":").pop() ?? "");
    const parentIndex = match ? Number(match[1]) : -1;
    if (parentIndex < 0 || parentIndex >= opts.size || parentIndex % 5 !== 1) return { total: 0, comments: [], next: null };
    all = Array.from({ length: 3 }, (_, j) => make(`${opts.parent}:r${j}`, parentIndex * 10 + j, 0));
  } else {
    all = Array.from({ length: opts.size }, (_, i) => make(`${key}:c${i}`, i, i % 5 === 1 ? 3 : 0));
    if (all[0]) all[0].pinned = true;
    if (opts.sort === "top") {
      const [pinned, ...rest] = all;
      all = [...(pinned ? [pinned] : []), ...rest.sort((a, b) => b.up - b.down - (a.up - a.down))];
    }
  }
  const start = (opts.page - 1) * COMMENT_PAGE_SIZE;
  return {
    total: all.length,
    comments: all.slice(start, start + COMMENT_PAGE_SIZE),
    next: start + COMMENT_PAGE_SIZE < all.length ? opts.page + 1 : null,
  };
}

/** Public-domain works, presented as a small comic library. */
/** Two generic chapters for a series id (keeps the catalog terse without hand-writing each). */
function chaps(id: string, n = 2): FixtureChapter[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${id}-${i + 1}`,
    name: `Chapter ${i + 1}`,
    number: i + 1,
    pages: 2 + ((i + id.length) % 4),
  }));
}

export const DEFAULT_CATALOG: FixtureSeries[] = [
  // — kept verbatim so the example-bridge snapshots stay stable —
  {
    id: "alice",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    description: "A girl named Alice falls through a rabbit hole into a fantasy world.",
    genres: ["Fantasy", "Adventure"],
    status: "completed",
    chapters: [
      { id: "alice-1", name: "Down the Rabbit-Hole", number: 1, pages: 3 },
      { id: "alice-2", name: "The Pool of Tears", number: 2, pages: 2 },
    ],
  },
  {
    id: "sherlock",
    title: "The Adventures of Sherlock Holmes",
    author: "Arthur Conan Doyle",
    description: "Twelve cases solved by the consulting detective Sherlock Holmes.",
    genres: ["Mystery", "Crime"],
    status: "completed",
    chapters: [
      { id: "sherlock-1", name: "A Scandal in Bohemia", number: 1, pages: 4 },
      { id: "sherlock-2", name: "The Red-Headed League", number: 2, pages: 3 },
      { id: "sherlock-3", name: "A Case of Identity", number: 3, pages: 2 },
    ],
  },
  {
    id: "frankenstein",
    title: "Frankenstein",
    author: "Mary Shelley",
    description: "Victor Frankenstein creates life and reaps the consequences.",
    genres: ["Horror", "Gothic"],
    status: "completed",
    chapters: [{ id: "frankenstein-1", name: "Letters", number: 1, pages: 2 }],
  },
  // — additional public-domain titles for a fuller demo —
  { id: "dracula", title: "Dracula", author: "Bram Stoker", description: "A vampire count's move to England.", genres: ["Horror", "Gothic"], tagGroups: [{ label: "Themes", kind: "theme", tags: ["vampire", "epistolary"] }, { label: "Setting", tags: ["Victorian England"] }], related: [{ label: "Gothic Horror", kind: "similar", ids: ["frankenstein", "jekyll", "wuthering"] }, { label: "Recommended", kind: "recommended", ids: ["raven", "turn-of-the-screw", "metamorphosis"] }], status: "completed", chapters: chaps("dracula", 3) },
  { id: "moby-dick", title: "Moby-Dick", author: "Herman Melville", description: "A captain's obsessive hunt for a white whale.", genres: ["Adventure"], status: "completed", chapters: chaps("moby-dick", 3) },
  { id: "treasure-island", title: "Treasure Island", author: "Robert Louis Stevenson", description: "A boy, a map, and buried pirate gold.", genres: ["Adventure"], status: "completed", chapters: chaps("treasure-island") },
  { id: "war-of-the-worlds", title: "The War of the Worlds", author: "H. G. Wells", description: "Martians invade Victorian England.", genres: ["Sci-Fi", "Horror"], status: "completed", chapters: chaps("war-of-the-worlds") },
  { id: "time-machine", title: "The Time Machine", author: "H. G. Wells", description: "A traveler journeys to the far future.", genres: ["Sci-Fi", "Adventure"], status: "completed", chapters: chaps("time-machine") },
  { id: "jekyll", title: "The Strange Case of Dr Jekyll and Mr Hyde", author: "Robert Louis Stevenson", description: "A doctor's dark experiment on his own nature.", genres: ["Horror", "Mystery"], tagGroups: [{ label: "Themes", kind: "theme", tags: ["dual-identity", "science-gone-wrong"] }], status: "completed", chapters: chaps("jekyll") },
  { id: "tom-sawyer", title: "The Adventures of Tom Sawyer", author: "Mark Twain", description: "Mischief along the Mississippi.", genres: ["Adventure"], status: "completed", chapters: chaps("tom-sawyer", 3) },
  { id: "huck-finn", title: "Adventures of Huckleberry Finn", author: "Mark Twain", description: "A raft journey down the great river.", genres: ["Adventure"], status: "ongoing", chapters: chaps("huck-finn", 4) },
  { id: "wuthering", title: "Wuthering Heights", author: "Emily Bronte", description: "A doomed romance on the moors.", genres: ["Gothic", "Drama"], status: "completed", chapters: chaps("wuthering") },
  { id: "jane-eyre", title: "Jane Eyre", author: "Charlotte Bronte", description: "A governess and the secrets of Thornfield.", genres: ["Gothic", "Romance"], status: "completed", chapters: chaps("jane-eyre", 3) },
  { id: "odyssey", title: "The Odyssey", altTitles: ["Odysseia", "Ὀδύσσεια", "L'Odyssée"], author: "Homer", description: "A hero's long voyage home from Troy.", genres: ["Adventure", "Fantasy"], status: "completed", rating: { stars: 4.5, votes: 1280 }, facts: [{ label: "Year", value: "-700" }, { label: "Views", value: "48.2K" }], chapters: chaps("odyssey", 4) },
  { id: "metamorphosis", title: "The Metamorphosis", author: "Franz Kafka", description: "A man wakes transformed into an insect.", genres: ["Horror", "Drama"], status: "completed", chapters: chaps("metamorphosis", 1) },
  { id: "raven", title: "The Raven and Other Poems", author: "Edgar Allan Poe", description: "Macabre verse and a midnight visitor.", genres: ["Horror", "Gothic"], status: "completed", chapters: chaps("raven") },
  { id: "peter-pan", title: "Peter Pan", author: "J. M. Barrie", description: "The boy who wouldn't grow up.", genres: ["Fantasy", "Adventure"], status: "ongoing", chapters: chaps("peter-pan", 3) },
  { id: "wizard-of-oz", title: "The Wonderful Wizard of Oz", author: "L. Frank Baum", description: "A Kansas girl swept to a magical land.", genres: ["Fantasy", "Adventure"], status: "hiatus", chapters: chaps("wizard-of-oz", 3) },
  { id: "gulliver", title: "Gulliver's Travels", author: "Jonathan Swift", description: "Voyages to strange and satirical lands.", genres: ["Adventure", "Fantasy"], status: "completed", chapters: chaps("gulliver", 4) },
  { id: "monte-cristo", title: "The Count of Monte Cristo", author: "Alexandre Dumas", description: "An innocent man's elaborate revenge.", genres: ["Adventure", "Drama"], status: "ongoing", chapters: chaps("monte-cristo", 4) },
  { id: "hound", title: "The Hound of the Baskervilles", author: "Arthur Conan Doyle", description: "A spectral hound stalks the moors.", genres: ["Mystery", "Crime"], tagGroups: [{ label: "Themes", kind: "theme", tags: ["detective", "moors"] }, { label: "Audience", kind: "demographic", tags: ["Adult"] }], status: "completed", chapters: chaps("hound", 3) },
  { id: "turn-of-the-screw", title: "The Turn of the Screw", author: "Henry James", description: "A governess and two unsettling children.", genres: ["Horror", "Gothic"], status: "hiatus", chapters: chaps("turn-of-the-screw") },
  // — multi-scanlator / multi-language title: exercises chapter grouping + language-aware navigation —
  {
    id: "beowulf",
    title: "Beowulf",
    author: "Anonymous",
    description: "An epic of the hero Beowulf, fan-translated by several groups.",
    genres: ["Adventure", "Fantasy"],
    status: "ongoing",
    chapters: [
      { id: "beowulf-1-scriptorium", name: "Grendel [Scriptorium]", number: 1, pages: 3, group: "Scriptorium", languageCode: "en" },
      { id: "beowulf-1-meadhall", name: "Grendel [MeadHall]", number: 1, pages: 4, group: "MeadHall", languageCode: "en" },
      { id: "beowulf-1-runas", name: "Grendel [Runas]", number: 1, pages: 3, group: "Runas", languageCode: "es" },
      { id: "beowulf-2-scriptorium", name: "Grendel's Mother [Scriptorium]", number: 2, pages: 3, group: "Scriptorium", languageCode: "en" },
      { id: "beowulf-2-meadhall", name: "Grendel's Mother [MeadHall]", number: 2, pages: 2, group: "MeadHall", languageCode: "en" },
      { id: "beowulf-3-scriptorium", name: "The Dragon [Scriptorium]", number: 3, pages: 4, group: "Scriptorium", languageCode: "en" },
      { id: "beowulf-3-runas", name: "The Dragon [Runas]", number: 3, pages: 3, group: "Runas", languageCode: "es" },
    ],
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

/**
 * Deterministic placeholder image URLs. Real, loadable images (so a browser/phone renders covers
 * and pages), seeded by id so snapshots stay stable. `/img/...` (below) still answers for any
 * client that requests the legacy path.
 */
const cover = (id: string): string => `https://picsum.photos/seed/${encodeURIComponent(id)}/300/450`;
const pageImg = (seriesId: string, chapterId: string, n: number): string =>
  `https://picsum.photos/seed/${encodeURIComponent(`${seriesId}-${chapterId}-${n}`)}/700/1000`;

/**
 * Bridge-defined card badges (see `seriesEntrySchema.badges`): every card carries a language tag,
 * and still-running series additionally get a "NEW" flag — exercising multiple badges + positions so
 * clients have something to render in the demo.
 */
function cardBadges(s: FixtureSeries): string {
  const badges = [`<span class="card-badge" data-pos="top-right" data-tone="info">EN</span>`];
  if (s.status === "ongoing") {
    badges.push(`<span class="card-badge" data-pos="top-left" data-tone="success">NEW</span>`);
  }
  return badges.join("");
}

function seriesCard(s: FixtureSeries): string {
  return (
    `<div class="series-card" data-id="${esc(s.id)}" data-status="${esc(s.status)}">` +
    `<a class="title" href="/series/${esc(s.id)}">${esc(s.title)}</a>` +
    `<img class="cover" src="${esc(cover(s.id))}" alt="${esc(s.title)}">` +
    `<span class="author">${esc(s.author)}</span>` +
    cardBadges(s) +
    `</div>`
  );
}

export class FixtureBackend {
  constructor(readonly catalog: FixtureSeries[] = DEFAULT_CATALOG) {}

  /** In-memory per-instance "account" favorites (exercises the backend-synced favorites capability). */
  private readonly favorites = new Set<string>();

  private find(id: string): FixtureSeries | undefined {
    return this.catalog.find((s) => s.id === id);
  }

  private html(body: string, status = 200): HttpResponse {
    return {
      url: "",
      status,
      statusText: status === 200 ? "OK" : "Not Found",
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
    };
  }

  private json(value: unknown, status = 200): HttpResponse {
    return {
      url: "",
      status,
      statusText: status === 200 ? "OK" : "Not Found",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(value),
    };
  }

  /**
   * The backend's self-defined lists, in home-stack order. Each carries a presentation `layout`
   * the example-bridge surfaces verbatim, so the demo home shows the full spread: a `carousel`
   * preview row, a non-terminal `grid` (pages with "load more"), and a terminal `grid` (the last
   * section, which the host renders as infinite-scroll). `popular`/`latest` = all; `completed` =
   * finished series.
   */
  private lists(): Array<{
    id: string;
    name: string;
    layout: "carousel" | "grid" | "ranked" | "hero";
    series: FixtureSeries[];
  }> {
    return [
      { id: "popular", name: "Popular", layout: "carousel", series: this.catalog },
      {
        id: "completed",
        name: "Completed",
        layout: "grid",
        series: this.catalog.filter((s) => s.status === "completed"),
      },
      { id: "latest", name: "Latest", layout: "grid", series: [...this.catalog].reverse() },
    ];
  }

  private renderLists(): string {
    const items = this.lists()
      .map(
        (l) =>
          `<li class="list-card" data-id="${esc(l.id)}" data-layout="${esc(l.layout)}">` +
          `<a class="list-name" href="/list/${esc(l.id)}">${esc(l.name)}</a></li>`,
      )
      .join("");
    return layout("Demo Comic Library", `<ul class="lists">${items}</ul>`);
  }

  /** Page size for list pagination — small so the modest fixture catalog spans several pages. */
  private static readonly LIST_PAGE_SIZE = 6;

  private renderList(
    id: string,
    opts: { query?: string; sort?: string; ascending?: boolean; page?: number; excludeGenres?: string[] } = {},
  ): string | undefined {
    const list = this.lists().find((l) => l.id === id);
    if (!list) return undefined;

    let series = [...list.series];
    const q = opts.query?.trim().toLowerCase();
    if (q) series = series.filter((s) => s.title.toLowerCase().includes(q) || s.author.toLowerCase().includes(q));
    if (opts.excludeGenres && opts.excludeGenres.length > 0) {
      const banned = new Set(opts.excludeGenres.map((g) => g.toLowerCase()));
      series = series.filter((s) => !s.genres.some((g) => banned.has(g.toLowerCase())));
    }
    if (opts.sort === "title" || opts.sort === "author") {
      const key = opts.sort;
      series.sort((a, b) => a[key].localeCompare(b[key]));
      if (opts.ascending === false) series.reverse();
    }

    const size = FixtureBackend.LIST_PAGE_SIZE;
    const page = Math.max(1, opts.page ?? 1);
    const start = (page - 1) * size;
    const pageItems = series.slice(start, start + size);
    const hasNext = start + size < series.length;

    return layout(
      list.name,
      `<section class="list-items" data-id="${esc(list.id)}" data-has-next="${hasNext}">` +
        `${pageItems.map(seriesCard).join("")}</section>`,
    );
  }

  private renderSearch(
    query: string,
    opts: { genres?: string[]; sort?: string; ascending?: boolean; author?: string; excludeGenres?: string[] } = {},
  ): string {
    const q = query.trim().toLowerCase();
    let matches = q
      ? this.catalog.filter(
          (s) => s.title.toLowerCase().includes(q) || s.author.toLowerCase().includes(q),
        )
      : [...this.catalog];

    if (opts.genres && opts.genres.length > 0) {
      const wanted = new Set(opts.genres.map((g) => g.toLowerCase()));
      matches = matches.filter((s) => s.genres.some((g) => wanted.has(g.toLowerCase())));
    }

    if (opts.excludeGenres && opts.excludeGenres.length > 0) {
      const banned = new Set(opts.excludeGenres.map((g) => g.toLowerCase()));
      matches = matches.filter((s) => !s.genres.some((g) => banned.has(g.toLowerCase())));
    }

    if (opts.author) {
      const a = opts.author.trim().toLowerCase();
      matches = matches.filter((s) => s.author.toLowerCase().includes(a));
    }

    if (opts.sort === "title" || opts.sort === "author") {
      const key = opts.sort;
      matches.sort((a, b) => a[key].localeCompare(b[key]));
      if (opts.ascending === false) matches.reverse();
    }

    return layout(
      `Search: ${query}`,
      `<section class="results">${matches.map(seriesCard).join("")}</section>`,
    );
  }

  private renderSeries(s: FixtureSeries): string {
    const chapters = s.chapters
      .map(
        (c) =>
          `<li class="chapter" data-id="${esc(c.id)}" data-number="${c.number}" data-pages="${c.pages}"` +
          `${c.group ? ` data-group="${esc(c.group)}"` : ""}${c.languageCode ? ` data-lang="${esc(c.languageCode)}"` : ""}>` +
          `<a href="/series/${esc(s.id)}/chapter/${esc(c.id)}">${esc(c.name)}</a></li>`,
      )
      .join("");
    return layout(
      s.title,
      `<article class="series" data-id="${esc(s.id)}">` +
        `<h1 class="title">${esc(s.title)}</h1>` +
        (s.altTitles?.length
          ? `<ul class="alt-titles">${s.altTitles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
          : "") +
        `<img class="cover" src="${esc(cover(s.id))}">` +
        `<div class="author">${esc(s.author)}</div>` +
        `<div class="status">${esc(s.status)}</div>` +
        `<p class="description">${esc(s.description)}</p>` +
        (s.rating
          ? `<div class="rating" data-stars="${s.rating.stars}"` +
            `${s.rating.votes === undefined ? "" : ` data-votes="${s.rating.votes}"`}></div>`
          : "") +
        (s.facts?.length
          ? `<dl class="facts">${s.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl>`
          : "") +
        `<ul class="genres">${s.genres.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` +
        (s.tagGroups ?? [])
          .map(
            (grp) =>
              `<ul class="tag-group" data-label="${esc(grp.label)}"${grp.kind ? ` data-kind="${esc(grp.kind)}"` : ""}>` +
              grp.tags.map((t) => `<li>${esc(t)}</li>`).join("") +
              `</ul>`,
          )
          .join("") +
        (s.related ?? [])
          .map((grp) => {
            const items = grp.ids
              .map((id) => this.find(id))
              .filter((r): r is FixtureSeries => !!r)
              .map(
                (r) =>
                  `<li class="related-item" data-id="${esc(r.id)}">` +
                  `<a href="/series/${esc(r.id)}"><img class="cover" src="${esc(cover(r.id))}"><span class="title">${esc(r.title)}</span></a>` +
                  `</li>`,
              )
              .join("");
            return items
              ? `<ul class="related-group" data-label="${esc(grp.label)}"${grp.kind ? ` data-kind="${esc(grp.kind)}"` : ""}>${items}</ul>`
              : "";
          })
          .join("") +
        `<ul class="chapters">${chapters}</ul>` +
        `</article>`,
    );
  }

  private renderChapter(s: FixtureSeries, c: FixtureChapter): string {
    const pages = Array.from(
      { length: c.pages },
      (_, i) => `<img class="page" src="${esc(pageImg(s.id, c.id, i + 1))}">`,
    ).join("");
    return layout(`${s.title} — ${c.name}`, `<div class="reader">${pages}</div>`);
  }

  /** Answer a request in-process. `req.url` may be absolute or path-only. */
  handle(req: HttpRequest): HttpResponse {
    const url = new URL(req.url, "http://fixture.local");
    const path = url.pathname;

    if (path === "/" || path === "" || path === "/lists") return this.html(this.renderLists());

    const listMatch = /^\/list\/([^/]+)$/.exec(path);
    if (listMatch) {
      const lp = url.searchParams;
      const excludeGenres = lp.get("excludeGenre")?.split(",").map((g) => g.trim()).filter(Boolean);
      const html = this.renderList(decodeURIComponent(listMatch[1]!), {
        ...(lp.get("q") ? { query: lp.get("q")! } : {}),
        ...(lp.get("sort") ? { sort: lp.get("sort")! } : {}),
        ascending: lp.get("dir") !== "desc",
        page: Math.max(1, Number(lp.get("page") ?? "1") || 1),
        ...(excludeGenres && excludeGenres.length ? { excludeGenres } : {}),
      });
      return html ? this.html(html) : this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    if (path === "/search") {
      const p = url.searchParams;
      const genres = p.get("genre")?.split(",").map((g) => g.trim()).filter(Boolean);
      const excludeGenres = p.get("excludeGenre")?.split(",").map((g) => g.trim()).filter(Boolean);
      const sort = p.get("sort") ?? undefined;
      const ascending = p.get("dir") !== "desc";
      const author = p.get("author") ?? undefined;
      return this.html(
        this.renderSearch(p.get("q") ?? "", {
          ...(genres && genres.length ? { genres } : {}),
          ...(excludeGenres && excludeGenres.length ? { excludeGenres } : {}),
          ...(sort ? { sort } : {}),
          ascending,
          ...(author ? { author } : {}),
        }),
      );
    }

    // Favorites (capability "favorites") — require any non-empty Authorization, like a logged-in API.
    if (path === "/favorites" || path.startsWith("/favorites/")) {
      const auth = req.headers?.Authorization ?? req.headers?.authorization;
      if (!auth) return this.html(layout("Unauthorized", "<p>auth required</p>"), 401);
      const method = (req.method ?? "GET").toUpperCase();
      const idMatch = /^\/favorites\/([^/]+)$/.exec(path);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]!);
        if (method === "PUT") {
          if (this.find(id)) this.favorites.add(id);
          return this.html(layout("ok", "<p>ok</p>"));
        }
        if (method === "DELETE") {
          this.favorites.delete(id);
          return this.html(layout("ok", "<p>ok</p>"));
        }
        return this.html(layout("Not Found", "<p>not found</p>"), 404);
      }
      const series = [...this.favorites]
        .map((id) => this.find(id))
        .filter((s): s is FixtureSeries => s !== undefined);
      return this.html(
        layout("Favorites", `<section class="favorites">${series.map(seriesCard).join("")}</section>`),
      );
    }

    // Comment threads (capability "comments") — public JSON, like most sources' comment APIs:
    // `/series/:id/comments` is the series thread, `?chapter=` a chapter's, `?parent=` one comment's
    // replies; `?sort=new|top`, 10 per `?page=`. Threads are synthesized deterministically from the id.
    const commentsMatch = /^\/series\/([^/]+)\/comments$/.exec(path);
    if (commentsMatch) {
      const s = this.find(decodeURIComponent(commentsMatch[1]!));
      const chapterId = url.searchParams.get("chapter");
      if (!s || (chapterId && !s.chapters.some((ch) => ch.id === chapterId))) {
        return this.json({ error: "not found" }, 404);
      }
      return this.json(
        fixtureComments(chapterId ? `${s.id}/${chapterId}` : s.id, {
          parent: url.searchParams.get("parent"),
          sort: url.searchParams.get("sort") === "top" ? "top" : "new",
          page: Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1),
          size: chapterId ? 4 : 25,
        }),
      );
    }

    // Bulk "what changed?" endpoint — the shape a real source exposes for cheap update checks:
    // many ids in, a small fingerprint per id out, so a library check costs one request instead of
    // one series page each. Ids it doesn't recognise are simply absent from the answer (the "don't
    // know" signal the contract asks bridges to preserve), which is what `example-bridge`'s
    // `checkForUpdates` relies on.
    if (path === "/updates") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const out: Record<string, { latest: string; count: number }> = {};
      for (const id of ids) {
        const s = this.find(id);
        const last = s?.chapters[s.chapters.length - 1];
        if (s && last) out[id] = { latest: last.id, count: s.chapters.length };
      }
      return this.json(out);
    }

    const chapterMatch = /^\/series\/([^/]+)\/chapter\/([^/]+)$/.exec(path);
    if (chapterMatch) {
      const s = this.find(decodeURIComponent(chapterMatch[1]!));
      const c = s?.chapters.find((ch) => ch.id === decodeURIComponent(chapterMatch[2]!));
      if (s && c) return this.html(this.renderChapter(s, c));
      return this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    const seriesMatch = /^\/series\/([^/]+)$/.exec(path);
    if (seriesMatch) {
      const s = this.find(decodeURIComponent(seriesMatch[1]!));
      if (s) return this.html(this.renderSeries(s));
      return this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    if (path.startsWith("/img/")) {
      // A 1x1 transparent PNG stand-in; pages are referenced by URL, never inlined.
      return {
        url: req.url,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
        body: "PNG\r\n",
      };
    }

    return this.html(layout("Not Found", "<p>not found</p>"), 404);
  }

  /** Start a real HTTP server (for host-adapter integration tests). Returns base URL + stop(). */
  serve(): { url: string; stop: () => void } {
    const backend = this;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const headers: Record<string, string> = {};
        request.headers.forEach((v, k) => { headers[k] = v; });
        const req: HttpRequest = {
          url: new URL(request.url).pathname + new URL(request.url).search,
          method: request.method as HttpMethod,
          headers,
        };
        if (request.method !== "GET" && request.method !== "HEAD") req.body = await request.text();
        const res = backend.handle(req);
        return new Response(res.body, { status: res.status, headers: res.headers });
      },
    });
    return {
      url: `http://localhost:${server.port}`,
      stop: () => server.stop(true),
    };
  }
}
