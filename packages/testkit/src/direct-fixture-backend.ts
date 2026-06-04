/**
 * A fixture backend for the "direct-read" demo bridge. Serves complete illustrated works
 * (one-shots, short stories, anthologies) as flat page sequences — no chapter structure.
 *
 * Routes:
 *   GET /              → gallery catalog (list of works)
 *   GET /gallery/:id   → work metadata (title, artist, description, genres, status)
 *   GET /gallery/:id/pages → page image list for direct reading
 *
 * The HTML shapes here are the implicit contract with `direct-example` bridge.
 */
import type { HttpMethod, HttpRequest, HttpResponse } from "@comical/contract";

export interface DirectFixtureSeries {
  id: string;
  title: string;
  artist: string;
  description: string;
  genres: string[];
  status: "ongoing" | "completed" | "hiatus";
  pages: number;
}

export const DIRECT_CATALOG: DirectFixtureSeries[] = [
  {
    id: "raven",
    title: "The Raven",
    artist: "Edgar Allan Poe",
    description: "A haunted man is visited by a talking raven that speaks one word: Nevermore.",
    genres: ["Horror", "Poetry"],
    status: "completed",
    pages: 6,
  },
  {
    id: "yellow-wallpaper",
    title: "The Yellow Wallpaper",
    artist: "Charlotte Perkins Gilman",
    description: "A woman confined to her room becomes obsessed with the pattern in the wallpaper.",
    genres: ["Horror", "Gothic"],
    status: "completed",
    pages: 8,
  },
  {
    id: "tell-tale-heart",
    title: "The Tell-Tale Heart",
    artist: "Edgar Allan Poe",
    description: "A murderer's guilty conscience drives him to hear a dead man's heartbeat.",
    genres: ["Horror", "Thriller"],
    status: "completed",
    pages: 5,
  },
  {
    id: "gift-of-magi",
    title: "The Gift of the Magi",
    artist: "O. Henry",
    description: "A young couple each secretly sells their most prized possession to buy the other a gift.",
    genres: ["Drama", "Romance"],
    status: "completed",
    pages: 6,
  },
  {
    id: "metamorphosis",
    title: "The Metamorphosis",
    artist: "Franz Kafka",
    description: "Gregor Samsa wakes one morning to find himself transformed into a giant insect.",
    genres: ["Drama", "Horror"],
    status: "completed",
    pages: 10,
  },
  {
    id: "lottery",
    title: "The Lottery",
    artist: "Shirley Jackson",
    description: "Every summer a small village gathers for its annual tradition.",
    genres: ["Horror", "Drama"],
    status: "completed",
    pages: 7,
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cover = (id: string): string =>
  `https://picsum.photos/seed/${encodeURIComponent(`direct-${id}`)}/300/450`;

const pageImg = (id: string, n: number): string =>
  `https://picsum.photos/seed/${encodeURIComponent(`direct-${id}-${n}`)}/700/1000`;

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

function galleryCard(s: DirectFixtureSeries): string {
  return (
    `<div class="gallery-card" data-id="${esc(s.id)}">` +
    `<a class="title" href="/gallery/${esc(s.id)}">${esc(s.title)}</a>` +
    `<img class="cover" src="${esc(cover(s.id))}" alt="${esc(s.title)}">` +
    `<span class="artist">${esc(s.artist)}</span>` +
    `</div>`
  );
}

export class DirectFixtureBackend {
  constructor(readonly catalog: DirectFixtureSeries[] = DIRECT_CATALOG) {}

  private find(id: string): DirectFixtureSeries | undefined {
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

  private renderCatalog(): string {
    const cards = this.catalog.map(galleryCard).join("");
    return layout("Illustration Gallery", `<ul class="gallery-catalog">${cards}</ul>`);
  }

  private renderSeries(s: DirectFixtureSeries): string {
    return layout(
      s.title,
      `<article class="gallery">` +
        `<h1 class="title">${esc(s.title)}</h1>` +
        `<img class="cover" src="${esc(cover(s.id))}">` +
        `<div class="artist">${esc(s.artist)}</div>` +
        `<div class="status">${esc(s.status)}</div>` +
        `<p class="description">${esc(s.description)}</p>` +
        `<ul class="genres">${s.genres.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` +
        `<div class="page-count" data-count="${s.pages}"></div>` +
        `</article>`,
    );
  }

  private renderPages(s: DirectFixtureSeries): string {
    const imgs = Array.from(
      { length: s.pages },
      (_, i) => `<img class="page" src="${esc(pageImg(s.id, i + 1))}">`,
    ).join("");
    return layout(`${s.title} — Pages`, `<div class="reader">${imgs}</div>`);
  }

  handle(req: HttpRequest): HttpResponse {
    const url = new URL(req.url, "http://fixture.local");
    const path = url.pathname;

    if (path === "/" || path === "") return this.html(this.renderCatalog());

    const pagesMatch = /^\/gallery\/([^/]+)\/pages$/.exec(path);
    if (pagesMatch) {
      const s = this.find(decodeURIComponent(pagesMatch[1]!));
      if (s) return this.html(this.renderPages(s));
      return this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    const galleryMatch = /^\/gallery\/([^/]+)$/.exec(path);
    if (galleryMatch) {
      const s = this.find(decodeURIComponent(galleryMatch[1]!));
      if (s) return this.html(this.renderSeries(s));
      return this.html(layout("Not Found", "<p>not found</p>"), 404);
    }

    return this.html(layout("Not Found", "<p>not found</p>"), 404);
  }

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
