/**
 * Browser demo: a thin REST client for a running `comical serve` instance.
 * The browser knows nothing about bridges or parsing — it just calls the server's API and
 * renders the JSON it gets back.
 *
 * Start everything with:
 *   bun run demo:server   — starts comical-server on :3100 (wired to the fixture backend)
 *   bun run demo:dev      — builds + serves this page on :3300
 * Then open http://localhost:3300
 */

const SERVER = (window as unknown as Record<string, string>).COMICAL_SERVER ?? "http://localhost:3100";
const BRIDGE = "example";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const status = (msg: string, isError = false) => {
  const el = $("#status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
};

// ── API client ─────────────────────────────────────────────────────────────────

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json() as Promise<T>;
}

interface SeriesEntry { id: string; title: string; thumbnailUrl?: string | undefined; subtitle?: string | undefined }
interface SeriesInfo { id: string; title: string; author?: string; status?: string; description?: string }
interface Chapter { id: string; name: string; number?: number }
interface Page { index: number; imageUrl: string }
interface PagedResults { items: SeriesEntry[]; page: number; hasNextPage: boolean }
interface HomeSection { type: string; id: string; title: string; items: SeriesEntry[] }

// ── UI helpers ─────────────────────────────────────────────────────────────────

function renderGrid(items: SeriesEntry[], onClick: (id: string) => void): void {
  const grid = $("#grid");
  grid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img src="${item.thumbnailUrl ?? ""}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="card-title">${esc(item.title)}</div>
      ${item.subtitle ? `<div class="card-sub">${esc(item.subtitle)}</div>` : ""}
    `;
    card.addEventListener("click", () => onClick(item.id));
    grid.append(card);
  }
}

async function showDetail(seriesId: string): Promise<void> {
  const detail = $("#detail");
  detail.style.display = "block";
  $("#detail-title").textContent = "Loading…";
  $("#chapters").innerHTML = "";
  $("#pages").innerHTML = "";

  const [info, chapters] = await Promise.all([
    api<SeriesInfo>(`/bridges/${BRIDGE}/series/${encodeURIComponent(seriesId)}`),
    api<Chapter[]>(`/bridges/${BRIDGE}/series/${encodeURIComponent(seriesId)}/chapters`),
  ]);

  $("#detail-title").textContent = info.title;
  $("#detail-meta").textContent = [
    info.author && `by ${info.author}`,
    info.status,
  ].filter(Boolean).join(" · ");

  const ul = $("#chapters");
  for (const ch of chapters) {
    const li = document.createElement("li");
    li.textContent = ch.name;
    li.addEventListener("click", async () => {
      const pagesEl = $("#pages");
      pagesEl.innerHTML = "<p>Loading pages…</p>";
      const pages = await api<Page[]>(
        `/bridges/${BRIDGE}/series/${encodeURIComponent(seriesId)}/chapters/${encodeURIComponent(ch.id)}/pages`
      );
      pagesEl.innerHTML = pages.map(p => `<img src="${p.imageUrl}" loading="lazy">`).join("");
    });
    ul.append(li);
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

// ── Main ───────────────────────────────────────────────────────────────────────

(async () => {
  status("Connecting to server…");

  try {
    await api<{ ok: boolean }>("/health");
  } catch (e) {
    status(`Cannot reach server at ${SERVER}. Is comical-server running? (bun run demo:server)`, true);
    return;
  }

  // Initial home load.
  try {
    const sections = await api<HomeSection[]>(`/bridges/${BRIDGE}/home`);
    const items = sections.flatMap(s => s.items);
    renderGrid(items, showDetail);
    status(`Home loaded — ${items.length} item(s). Click a title or search.`);
  } catch (e) {
    status(`Home load failed: ${e instanceof Error ? e.message : e}`, true);
  }

  // Search.
  const doSearch = async (): Promise<void> => {
    const q = ($<HTMLInputElement>("#query")).value;
    status("Searching…");
    try {
      const r = await api<PagedResults>(`/bridges/${BRIDGE}/search?q=${encodeURIComponent(q)}`);
      renderGrid(r.items, showDetail);
      status(`${r.items.length} result(s) for "${q}".`);
    } catch (e) {
      status(`Search failed: ${e instanceof Error ? e.message : e}`, true);
    }
  };

  $("#searchBtn").addEventListener("click", doSearch);
  ($<HTMLInputElement>("#query")).addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") doSearch();
  });
})();
