/**
 * Browser demo: loads the example-bridge bundle, wires it to the web host (proxy-backed), and
 * renders a simple search/details/chapter UI.
 *
 * The demo uses a local proxy (http://localhost:3100) and the local fixture backend. Start them:
 *   bun run demo:proxy   — starts the proxy on :3100
 *   bun run demo:backend — starts the fixture backend on :3200
 *   bun run demo:dev     — builds app.ts and serves demo/ on :3300
 *
 * Or run all three: bun run demo
 */
import { loadBridge, type LoadedBridge } from "@comical/core";
import { FunctionEvaluator } from "@comical/host-web";
import { createWebHost } from "@comical/host-web";
import type { Chapter } from "@comical/contract";

const PROXY_URL = (window as unknown as Record<string, string>).COMICAL_PROXY_URL ?? "http://localhost:3100";
const BACKEND_URL = (window as unknown as Record<string, string>).COMICAL_BACKEND_URL ?? "http://localhost:3200";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const status = (msg: string, isError = false) => {
  const el = $("#status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
};

async function loadExampleBridge(): Promise<LoadedBridge> {
  const res = await fetch("./bridge.js");
  if (!res.ok) throw new Error(`failed to fetch bridge bundle: ${res.status}`);
  const code = await res.text();

  const host = createWebHost({
    bridgeId: "example",
    proxy: { proxyUrl: PROXY_URL },
    settings: { baseUrl: BACKEND_URL },
  });

  return loadBridge({ code, capabilities: host, evaluator: new FunctionEvaluator(), expectedId: "example" });
}

function renderGrid(items: Array<{ id: string; title: string; thumbnailUrl?: string | undefined; subtitle?: string | undefined }>, onClick: (id: string) => void) {
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

async function showDetail(bridge: LoadedBridge, seriesId: string) {
  const detail = $("#detail");
  detail.style.display = "block";
  $("#detail-title").textContent = "Loading…";
  $("#chapters").innerHTML = "";
  $("#pages").innerHTML = "";

  const [info, chapters] = await Promise.all([
    bridge.getSeriesDetails(seriesId),
    bridge.getChapters(seriesId),
  ]);

  $("#detail-title").textContent = info.title;
  $("#detail-meta").textContent = [
    info.author && `by ${info.author}`,
    info.status && info.status,
    info.genres?.join(", "),
  ].filter(Boolean).join(" · ");

  const ul = $("#chapters");
  for (const ch of chapters as Chapter[]) {
    const li = document.createElement("li");
    li.textContent = ch.name;
    li.addEventListener("click", async () => {
      const pagesEl = $("#pages");
      pagesEl.innerHTML = "<p>Loading pages…</p>";
      const pages = await bridge.getChapterPages(seriesId, ch.id);
      pagesEl.innerHTML = pages.map(p => `<img src="${p.imageUrl}" loading="lazy">`).join("");
    });
    ul.append(li);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

(async () => {
  let bridge: LoadedBridge;
  try {
    status("Loading bridge…");
    bridge = await loadExampleBridge();
    status(`Bridge "${bridge.info.name}" loaded. Fetching home…`);
  } catch (e) {
    status(`Failed to load bridge: ${e instanceof Error ? e.message : e}`, true);
    return;
  }

  // Initial home/popular load.
  try {
    if (bridge.getHomeSections) {
      const sections = await bridge.getHomeSections();
      const items = sections.flatMap(s => s.items);
      renderGrid(items, id => showDetail(bridge, id));
      status(`Home loaded — ${items.length} item(s). Click a title or search.`);
    } else {
      const popular = await bridge.getPopular!(1);
      renderGrid(popular.items, id => showDetail(bridge, id));
      status("Home loaded.");
    }
  } catch (e) {
    status(`Home load failed: ${e instanceof Error ? e.message : e}`, true);
  }

  // Search.
  const doSearch = async () => {
    const q = ($<HTMLInputElement>("#query")).value;
    status("Searching…");
    try {
      const r = await bridge.getSearchResults(q, 1);
      renderGrid(r.items, id => showDetail(bridge, id));
      status(`${r.items.length} result(s) for "${q}".`);
    } catch (e) {
      status(`Search failed: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  $("#searchBtn").addEventListener("click", doSearch);
  ($<HTMLInputElement>("#query")).addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
})();
