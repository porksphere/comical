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
import type { HttpRequest, HttpResponse } from "@comical/contract";

export interface FixtureChapter {
  id: string;
  name: string;
  number: number;
  pages: number;
}

export interface FixtureSeries {
  id: string;
  title: string;
  author: string;
  description: string;
  genres: string[];
  status: "ongoing" | "completed" | "hiatus";
  chapters: FixtureChapter[];
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
  { id: "dracula", title: "Dracula", author: "Bram Stoker", description: "A vampire count's move to England.", genres: ["Horror", "Gothic"], status: "completed", chapters: chaps("dracula", 3) },
  { id: "moby-dick", title: "Moby-Dick", author: "Herman Melville", description: "A captain's obsessive hunt for a white whale.", genres: ["Adventure"], status: "completed", chapters: chaps("moby-dick", 3) },
  { id: "treasure-island", title: "Treasure Island", author: "Robert Louis Stevenson", description: "A boy, a map, and buried pirate gold.", genres: ["Adventure"], status: "completed", chapters: chaps("treasure-island") },
  { id: "war-of-the-worlds", title: "The War of the Worlds", author: "H. G. Wells", description: "Martians invade Victorian England.", genres: ["Sci-Fi", "Horror"], status: "completed", chapters: chaps("war-of-the-worlds") },
  { id: "time-machine", title: "The Time Machine", author: "H. G. Wells", description: "A traveler journeys to the far future.", genres: ["Sci-Fi", "Adventure"], status: "completed", chapters: chaps("time-machine") },
  { id: "jekyll", title: "The Strange Case of Dr Jekyll and Mr Hyde", author: "Robert Louis Stevenson", description: "A doctor's dark experiment on his own nature.", genres: ["Horror", "Mystery"], status: "completed", chapters: chaps("jekyll") },
  { id: "tom-sawyer", title: "The Adventures of Tom Sawyer", author: "Mark Twain", description: "Mischief along the Mississippi.", genres: ["Adventure"], status: "completed", chapters: chaps("tom-sawyer", 3) },
  { id: "huck-finn", title: "Adventures of Huckleberry Finn", author: "Mark Twain", description: "A raft journey down the great river.", genres: ["Adventure"], status: "ongoing", chapters: chaps("huck-finn", 4) },
  { id: "wuthering", title: "Wuthering Heights", author: "Emily Bronte", description: "A doomed romance on the moors.", genres: ["Gothic", "Drama"], status: "completed", chapters: chaps("wuthering") },
  { id: "jane-eyre", title: "Jane Eyre", author: "Charlotte Bronte", description: "A governess and the secrets of Thornfield.", genres: ["Gothic", "Romance"], status: "completed", chapters: chaps("jane-eyre", 3) },
  { id: "odyssey", title: "The Odyssey", author: "Homer", description: "A hero's long voyage home from Troy.", genres: ["Adventure", "Fantasy"], status: "completed", chapters: chaps("odyssey", 4) },
  { id: "metamorphosis", title: "The Metamorphosis", author: "Franz Kafka", description: "A man wakes transformed into an insect.", genres: ["Horror", "Drama"], status: "completed", chapters: chaps("metamorphosis", 1) },
  { id: "raven", title: "The Raven and Other Poems", author: "Edgar Allan Poe", description: "Macabre verse and a midnight visitor.", genres: ["Horror", "Gothic"], status: "completed", chapters: chaps("raven") },
  { id: "peter-pan", title: "Peter Pan", author: "J. M. Barrie", description: "The boy who wouldn't grow up.", genres: ["Fantasy", "Adventure"], status: "ongoing", chapters: chaps("peter-pan", 3) },
  { id: "wizard-of-oz", title: "The Wonderful Wizard of Oz", author: "L. Frank Baum", description: "A Kansas girl swept to a magical land.", genres: ["Fantasy", "Adventure"], status: "hiatus", chapters: chaps("wizard-of-oz", 3) },
  { id: "gulliver", title: "Gulliver's Travels", author: "Jonathan Swift", description: "Voyages to strange and satirical lands.", genres: ["Adventure", "Fantasy"], status: "completed", chapters: chaps("gulliver", 4) },
  { id: "monte-cristo", title: "The Count of Monte Cristo", author: "Alexandre Dumas", description: "An innocent man's elaborate revenge.", genres: ["Adventure", "Drama"], status: "ongoing", chapters: chaps("monte-cristo", 4) },
  { id: "hound", title: "The Hound of the Baskervilles", author: "Arthur Conan Doyle", description: "A spectral hound stalks the moors.", genres: ["Mystery", "Crime"], status: "completed", chapters: chaps("hound", 3) },
  { id: "turn-of-the-screw", title: "The Turn of the Screw", author: "Henry James", description: "A governess and two unsettling children.", genres: ["Horror", "Gothic"], status: "hiatus", chapters: chaps("turn-of-the-screw") },
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

function seriesCard(s: FixtureSeries): string {
  return (
    `<div class="series-card" data-id="${esc(s.id)}">` +
    `<a class="title" href="/series/${esc(s.id)}">${esc(s.title)}</a>` +
    `<img class="cover" src="${esc(cover(s.id))}" alt="${esc(s.title)}">` +
    `<span class="author">${esc(s.author)}</span>` +
    `</div>`
  );
}

export class FixtureBackend {
  constructor(readonly catalog: FixtureSeries[] = DEFAULT_CATALOG) {}

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

  /** The backend's self-defined lists. `popular` = all; `completed` = finished series. */
  private lists(): Array<{ id: string; name: string; series: FixtureSeries[] }> {
    return [
      { id: "popular", name: "Popular", series: this.catalog },
      {
        id: "completed",
        name: "Completed",
        series: this.catalog.filter((s) => s.status === "completed"),
      },
    ];
  }

  private renderLists(): string {
    const items = this.lists()
      .map(
        (l) =>
          `<li class="list-card" data-id="${esc(l.id)}" data-layout="carousel">` +
          `<a class="list-name" href="/list/${esc(l.id)}">${esc(l.name)}</a></li>`,
      )
      .join("");
    return layout("Demo Comic Library", `<ul class="lists">${items}</ul>`);
  }

  private renderList(
    id: string,
    opts: { query?: string; sort?: string; ascending?: boolean } = {},
  ): string | undefined {
    const list = this.lists().find((l) => l.id === id);
    if (!list) return undefined;

    let series = [...list.series];
    const q = opts.query?.trim().toLowerCase();
    if (q) series = series.filter((s) => s.title.toLowerCase().includes(q) || s.author.toLowerCase().includes(q));
    if (opts.sort === "title" || opts.sort === "author") {
      const key = opts.sort;
      series.sort((a, b) => a[key].localeCompare(b[key]));
      if (opts.ascending === false) series.reverse();
    }

    return layout(
      list.name,
      `<section class="list-items" data-id="${esc(list.id)}">${series.map(seriesCard).join("")}</section>`,
    );
  }

  private renderSearch(
    query: string,
    opts: { genres?: string[]; sort?: string; ascending?: boolean } = {},
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
          `<li class="chapter" data-id="${esc(c.id)}" data-number="${c.number}">` +
          `<a href="/series/${esc(s.id)}/chapter/${esc(c.id)}">${esc(c.name)}</a></li>`,
      )
      .join("");
    return layout(
      s.title,
      `<article class="series" data-id="${esc(s.id)}">` +
        `<h1 class="title">${esc(s.title)}</h1>` +
        `<img class="cover" src="${esc(cover(s.id))}">` +
        `<div class="author">${esc(s.author)}</div>` +
        `<div class="status">${esc(s.status)}</div>` +
        `<p class="description">${esc(s.description)}</p>` +
        `<ul class="genres">${s.genres.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` +
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
      const html = this.renderList(decodeURIComponent(listMatch[1]!), {
        ...(lp.get("q") ? { query: lp.get("q")! } : {}),
        ...(lp.get("sort") ? { sort: lp.get("sort")! } : {}),
        ascending: lp.get("dir") !== "desc",
      });
      return html ? this.html(html) : this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    if (path === "/search") {
      const p = url.searchParams;
      const genres = p.get("genre")?.split(",").map((g) => g.trim()).filter(Boolean);
      const sort = p.get("sort") ?? undefined;
      const ascending = p.get("dir") !== "desc";
      return this.html(
        this.renderSearch(p.get("q") ?? "", {
          ...(genres && genres.length ? { genres } : {}),
          ...(sort ? { sort } : {}),
          ascending,
        }),
      );
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
        const res = backend.handle({ url: new URL(request.url).pathname + new URL(request.url).search });
        return new Response(res.body, { status: res.status, headers: res.headers });
      },
    });
    return {
      url: `http://localhost:${server.port}`,
      stop: () => server.stop(true),
    };
  }
}
