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
export const DEFAULT_CATALOG: FixtureSeries[] = [
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
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

function seriesCard(s: FixtureSeries): string {
  return (
    `<div class="series-card" data-id="${esc(s.id)}">` +
    `<a class="title" href="/series/${esc(s.id)}">${esc(s.title)}</a>` +
    `<img class="cover" src="/img/${esc(s.id)}/cover.png" alt="${esc(s.title)}">` +
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

  private renderList(id: string): string | undefined {
    const list = this.lists().find((l) => l.id === id);
    if (!list) return undefined;
    return layout(
      list.name,
      `<section class="list-items" data-id="${esc(list.id)}">${list.series.map(seriesCard).join("")}</section>`,
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
        `<img class="cover" src="/img/${esc(s.id)}/cover.png">` +
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
      (_, i) => `<img class="page" src="/img/${esc(s.id)}/${esc(c.id)}/${i + 1}.png">`,
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
      const html = this.renderList(decodeURIComponent(listMatch[1]!));
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
