/**
 * Browser console: a thin REST client for a running `comical serve` instance. It renders the
 * full host-server surface — bridge picker, settings form (typed descriptors + validation),
 * list tabs, search, series detail, filters/tags, and the M4 registry panel. The browser knows
 * nothing about bridges or parsing; it only calls the API and renders JSON.
 *
 *   bun run demo:server   — comical-server on :3100 (wired to the fixture backend)
 *   bun run demo:dev      — builds + serves this page on :3300
 */
import { createIcons, LayoutGrid, Library, History, Bell, Settings } from "lucide";
createIcons({ icons: { LayoutGrid, Library, History, Bell, Settings } });

// Default the API host to the same host the page was loaded from (so it works over LAN / from a
// phone), on the server port 3100. Override with window.COMICAL_SERVER if needed.
const SERVER =
  (window as unknown as Record<string, string>).COMICAL_SERVER ??
  `${location.protocol}//${location.hostname}:3100`;

// ── Types (subset of the contract, for the client's needs) ───────────────────────
interface Choice { value: string; label: string }
type SettingDescriptor =
  | { type: "string"; key: string; label: string; description?: string; required?: boolean; default?: string; placeholder?: string; secret?: boolean }
  | { type: "number"; key: string; label: string; description?: string; required?: boolean; default?: number; min?: number; max?: number }
  | { type: "boolean"; key: string; label: string; description?: string; required?: boolean; default?: boolean }
  | { type: "enum"; key: string; label: string; description?: string; required?: boolean; default?: string | string[]; options: Choice[]; multiple?: boolean };
interface BridgeInfo { id: string; name: string; capabilities: string[] }
interface BridgeDetail { info: BridgeInfo; settings: SettingDescriptor[]; values: Record<string, string | number | boolean | string[]>; secretsSet: string[]; missingRequired: string[]; configured: boolean }
interface BridgeSummary { info: BridgeInfo; missingRequired: string[]; source: string; availableVersion?: string }
interface SeriesEntry { id: string; title: string; thumbnailUrl?: string; subtitle?: string }
interface TagGroup { label: string; kind?: string; tags: string[]; tagIds?: string[] }
interface SeriesInfo { id: string; title: string; thumbnailUrl?: string; author?: string; authorId?: string; artist?: string; artistId?: string; status?: string; description?: string; genres?: string[]; tagGroups?: TagGroup[]; languages?: string[]; externalIds?: Record<string, string | number> }
interface Chapter { id: string; name: string; number?: number; pageCount?: number; group?: string; languageCode?: string; publishedAt?: number }
interface Page { index: number; imageUrl: string; thumbnailUrl?: string }
interface PagedResults { items: SeriesEntry[]; page: number; hasNextPage: boolean }
interface SeriesList { id: string; name: string; layout?: string; featured?: boolean; searchable?: boolean }
interface Filter { type: "text" | "toggle" | "number" | "select" | "multiselect" | "tag-multiselect"; key: string; label: string; options?: Choice[]; min?: number; max?: number }
interface FilterValue { key: string; value: string | string[] | number | boolean }
interface SortOption { key: string; label: string; directionless?: boolean }
interface Tag { id: string; label: string }
interface SavedRegistry { url: string; name: string }
interface AvailableBridge { entry: { id: string; name: string; version: string }; registryUrl: string; installedVersion: string | null; updateAvailable: boolean }
// Library (optional /library module)
interface ProgressItem { chapterId: string; read: boolean; lastPage?: number; pageCount?: number }
interface LibraryList { id: string; name: string; order: number }
interface LibEntry { bridgeId: string; seriesId: string; title: string; thumbnailUrl?: string; author?: string; listIds: string[]; seriesGroupId?: string; externalIds?: Record<string, string | number>; lastReadChapterId?: string; lastReadChapterName?: string; lastReadAt?: number }
interface LibEntryView extends LibEntry { unreadCount: number }
interface HistoryItem { bridgeId: string; seriesId: string; title: string; thumbnailUrl?: string; lastReadChapterId?: string; lastReadChapterName?: string; lastPage?: number; pageCount?: number; lastReadAt: number }
interface ActivityItemView { bridgeId: string; seriesId: string; chapterId: string; title: string; thumbnailUrl?: string; chapterName?: string; number?: number; publishedAt?: number; detectedAt: number; read: boolean }
interface SeriesGroup { id: string; title: string; primaryKey: string; memberKeys: string[]; createdAt: number }
interface AddSeriesResult { entry: LibEntry; autoLinked?: { matchedKey: string; sharedId: { service: string; value: number | string } } }
// Trackers
interface TrackerSummary { info: { id: string; name: string; capabilities: string[] }; settings: SettingDescriptor[]; values: Record<string, string | number | boolean | string[]>; secretsSet: string[]; configured: boolean; missingRequired: string[] }
interface BridgePrefs { bridgeId: string; trackersDisabled: boolean; historyDisabled: boolean }
interface TrackerLink { trackerId: string; externalId: string | number; status?: string; chaptersRead?: number; lastSyncAt?: number }
interface TrackerSearchPageResult { items: Array<{ externalId: string | number; title: string; thumbnailUrl?: string }>; page: number; hasNextPage: boolean }
interface AvailableTracker { entry: { id: string; name: string; version: string; capabilities: string[] }; registryUrl: string; installedVersion: string | null; updateAvailable: boolean }

// ── DOM + API helpers ────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const enc = encodeURIComponent;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/** Title-case a free-form value (bridges report e.g. "ongoing"/"on hiatus" in arbitrary casing). */
const titleCase = (s: string): string =>
  s.replace(/\b\w/g, (c) => c.toUpperCase());

function status(msg: string, isError = false): void {
  // Informational chatter ("Loaded …", "Searching…", counts) is suppressed — the status bar only
  // surfaces for errors, and hides again on the next non-error message.
  const el = $("#status");
  el.textContent = isError ? msg : "";
  el.className = isError ? "error" : "";
  el.style.display = isError ? "" : "none";
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function send(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${SERVER}${path}`, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── State ──────────────────────────────────────────────────────────────────────
let activeBridge = "";
let activeCaps: string[] = [];
/** The bridge the browse view's filter/sort/tag controls were last rendered for (via {@link renderMeta}). */
let browseBridge = "";
/** Display name of the active bridge, shown as the browse-view title. */
let activeBridgeName = "";
let currentFilters: Filter[] = [];
let currentLists: SeriesList[] = [];
let activeListId: string | null = null;
let currentView: "browse" | "library" | "history" | "activity" | "detail" | "reader" | "settings" = "browse";
let previousView: "browse" | "library" | "history" = "browse";
/** Which home page the browse view is on. Drill-downs (search/See all) don't change it; back returns here. */
let activeHomeTab: "home" | "favorites" = "home";
/** Set when a favorite is toggled in the detail view, so the favorites grid refetches on the way back. */
let favoritesDirty = false;
/** Accumulated favorites pages per bridge, so reopening the tab paints from memory instead of refetching. */
const favoritesCache = new Map<string, { items: SeriesEntry[]; nextPage: number | null }>();
let loadMoreFn: (() => Promise<void>) | null = null;
/** IntersectionObservers driving the home view's terminal infinite-scroll; disconnected on re-render. */
let homeObservers: IntersectionObserver[] = [];
let currentSortOptions: SortOption[] = [];
const filterTagSelections = new Map<string, Array<{ id: string; label: string }>>();
const tagIdToName = new Map<string, string>();

// ── URL routing ─────────────────────────────────────────────────────────────────
// Route scheme: #browse | #library | #history | #activity | #detail/{bridgeId}/{seriesId} | #reader/{bridgeId}/{seriesId}/{chapterId}
let initialized = false;
let isRestoringRoute = false;

function pushRoute(path: string): void {
  if (!initialized || isRestoringRoute) return;
  const hash = `#${path}`;
  if (window.location.hash !== hash) history.pushState(null, "", hash);
}

async function handleRoute(): Promise<void> {
  const hash = window.location.hash.slice(1) || "browse";
  const parts = hash.split("/");
  const view = parts[0];
  isRestoringRoute = true;
  try {
    if (view === "library") {
      switchView("library");
    } else if (view === "history") {
      switchView("history");
    } else if (view === "activity") {
      switchView("activity");
    } else if (view === "settings") {
      switchView("settings");
    } else if (view === "detail" && parts[1] && parts[2]) {
      const bridgeId = decodeURIComponent(parts[1]!);
      const seriesId = decodeURIComponent(parts[2]!);
      if (currentSeries?.bridgeId === bridgeId && currentSeries.seriesId === seriesId) {
        switchView("detail");
      } else {
        await ensureBridge(bridgeId);
        await showDetail(seriesId);
      }
    } else if (view === "reader" && parts[1] && parts[2] && parts[3]) {
      const bridgeId = decodeURIComponent(parts[1]!);
      const seriesId = decodeURIComponent(parts[2]!);
      const chapterId = decodeURIComponent(parts[3]!);
      if (!currentSeries || currentSeries.seriesId !== seriesId || currentSeries.bridgeId !== bridgeId) {
        await ensureBridge(bridgeId);
        await showDetail(seriesId);
      }
      if (currentSeries) {
        // Restoring the reader (reload / deep-link / back-forward) should resume at the
        // saved page, not jump to page 0. A direct series reads from the direct endpoint.
        if (chapterId === "__direct__") {
          await readDirect(seriesId, currentSeries.progress.get("__direct__")?.lastPage);
        } else {
          const ch = currentSeries.chapters.find((c) => c.id === chapterId);
          if (ch) await openChapter(ch, currentSeries.progress.get(ch.id)?.lastPage);
        }
      }
    } else {
      switchView("browse");
    }
  } finally {
    isRestoringRoute = false;
  }
}

/** Whether the results-grid sentinel is mid-load, guarding against overlapping page fetches. */
let loadingMore = false;
let resultsObserver: IntersectionObserver | null = null;

/**
 * Wire the next page of the shared results grid (search / list / favorites). A sentinel at the
 * grid's bottom auto-loads successive pages as it scrolls into view; `fn` is the page-(n+1) loader,
 * or pagination ends when `hasMore` is false.
 */
function setLoadMore(hasMore: boolean, fn: () => Promise<void>): void {
  loadMoreFn = hasMore ? fn : null;
  ensureResultsObserver();
}

/** Lazily create the single persistent observer driving the results grid's infinite scroll. */
function ensureResultsObserver(): void {
  if (resultsObserver) return;
  resultsObserver = new IntersectionObserver(
    async (entries) => {
      if (loadingMore || !loadMoreFn || !entries.some((e) => e.isIntersecting)) return;
      loadingMore = true;
      try {
        await loadMoreFn();
      } catch (e) {
        status(`Load more failed: ${e instanceof Error ? e.message : e}`, true);
      } finally {
        loadingMore = false;
      }
    },
    { rootMargin: "400px" },
  );
  resultsObserver.observe($("#results-sentinel"));
}

// ── Filter controls (rendered from getFilters, applied on Search) ────────────────
function renderFilterControls(filters: Filter[]): void {
  const host = $("#filters");
  host.innerHTML = "";
  for (const f of filters) {
    const label = document.createElement("label");
    label.textContent = f.label;
    if (f.type === "toggle") {
      const i = document.createElement("input");
      i.type = "checkbox"; i.dataset.key = f.key; i.dataset.kind = "toggle";
      label.append(i);
    } else if (f.type === "number") {
      const i = document.createElement("input");
      i.type = "number"; i.dataset.key = f.key; i.dataset.kind = "number";
      if (f.min !== undefined) i.min = String(f.min);
      if (f.max !== undefined) i.max = String(f.max);
      label.append(i);
    } else if (f.type === "select" || f.type === "multiselect") {
      const sel = document.createElement("select");
      sel.dataset.key = f.key; sel.dataset.kind = f.type;
      if (f.type === "multiselect") sel.multiple = true;
      else sel.append(new Option("— any —", ""));
      for (const o of f.options ?? []) sel.append(new Option(o.label, o.value));
      label.append(sel);
    } else if (f.type === "tag-multiselect") {
      const wrap = document.createElement("div");
      wrap.className = "tag-filter"; wrap.dataset.key = f.key; wrap.dataset.kind = "tag-multiselect";

      const pills = document.createElement("div");
      pills.className = "tag-filter-pills";

      const input = document.createElement("input");
      input.type = "text"; input.className = "tag-filter-input"; input.placeholder = "Search tags…";

      const dropdown = document.createElement("div");
      dropdown.className = "tag-filter-dropdown"; dropdown.style.display = "none";

      wrap.append(pills, input, dropdown);
      label.append(wrap);

      const fKey = f.key;
      function renderTagPills(): void {
        const sel = filterTagSelections.get(fKey) ?? [];
        pills.innerHTML = sel.map((t) =>
          `<span class="tag-pill" data-id="${esc(t.id)}">${esc(t.label)} <button type="button">×</button></span>`
        ).join("");
        pills.querySelectorAll<HTMLElement>(".tag-pill button").forEach((btn) => {
          btn.onclick = () => {
            const id = btn.closest<HTMLElement>(".tag-pill")!.dataset.id!;
            filterTagSelections.set(fKey, (filterTagSelections.get(fKey) ?? []).filter((t) => t.id !== id));
            renderTagPills();
          };
        });
      }
      renderTagPills();

      let tagDebounce: ReturnType<typeof setTimeout>;
      input.addEventListener("input", () => {
        clearTimeout(tagDebounce);
        tagDebounce = setTimeout(async () => {
          const q = input.value.trim();
          if (!q) { dropdown.style.display = "none"; return; }
          const tags = await api<Tag[]>(`/bridges/${activeBridge}/tags?q=${enc(q)}`).catch(() => []);
          const current = new Set((filterTagSelections.get(fKey) ?? []).map((t) => t.id));
          const opts = tags.filter((t) => !current.has(t.id));
          dropdown.innerHTML = opts.map((t) =>
            `<div class="tag-option" data-id="${esc(t.id)}" data-label="${esc(t.label)}">${esc(t.label)}</div>`
          ).join("") || `<div class="tag-option-empty">No results</div>`;
          dropdown.style.display = "block";
          dropdown.querySelectorAll<HTMLElement>(".tag-option[data-id]").forEach((opt) => {
            opt.onmousedown = (e) => {
              e.preventDefault(); // prevent blur from firing before we handle the selection
              const sel = filterTagSelections.get(fKey) ?? [];
              sel.push({ id: opt.dataset.id!, label: opt.dataset.label! });
              filterTagSelections.set(fKey, sel);
              input.value = ""; dropdown.style.display = "none";
              renderTagPills();
            };
          });
        }, 200);
      });
      input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 150));
    } else {
      const i = document.createElement("input");
      i.type = "text"; i.dataset.key = f.key; i.dataset.kind = "text";
      label.append(i);
    }
    host.append(label);
  }
}

function collectFilters(): FilterValue[] {
  const out: FilterValue[] = [];
  $("#filters").querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((el) => {
    const key = el.dataset.key!;
    const kind = el.dataset.kind!;
    if (kind === "toggle") { if ((el as HTMLInputElement).checked) out.push({ key, value: true }); }
    else if (kind === "number") { const v = (el as HTMLInputElement).value.trim(); if (v !== "") out.push({ key, value: Number(v) }); }
    else if (kind === "multiselect") {
      const vals = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value).filter(Boolean);
      if (vals.length) out.push({ key, value: vals });
    } else if (kind === "select") {
      const v = (el as HTMLSelectElement).value;
      if (v) out.push({ key, value: v });
    } else if (kind === "tag-multiselect") {
      const ids = (filterTagSelections.get(key) ?? []).map((t) => t.id);
      if (ids.length) out.push({ key, value: ids });
    } else if (kind === "text") {
      const v = (el as HTMLInputElement).value.trim();
      if (v) out.push({ key, value: v });
    }
  });
  return out;
}

/** The selected sort (field + direction), or undefined if the bridge has no sort options. */
function collectSort(): { key: string; ascending: boolean } | undefined {
  const field = $<HTMLSelectElement>("#sort-field");
  if (!field.value) return undefined;
  return { key: field.value, ascending: $<HTMLSelectElement>("#sort-dir").value !== "desc" };
}

function updateSortDirVisibility(): void {
  const key = $<HTMLSelectElement>("#sort-field").value;
  const opt = currentSortOptions.find((s) => s.key === key);
  $<HTMLElement>("#sort-dir").style.display = (key && opt?.directionless) ? "none" : "";
}

// ── Bridge picker ────────────────────────────────────────────────────────────────
/** bridgeId → friendly display name, cached on load for the Sources panel (falls back to the id). */
const bridgeNames = new Map<string, string>();

async function loadBridges(): Promise<void> {
  const bridges = await api<BridgeSummary[]>("/bridges");
  bridgeNames.clear();
  for (const b of bridges) bridgeNames.set(b.info.id, b.info.name);
  const list = $("#bridge-list");
  list.innerHTML = "";
  for (const b of bridges) {
    const btn = document.createElement("div");
    btn.className = "tab";
    btn.dataset.id = b.info.id;
    let label = b.info.name;
    if (b.missingRequired.length) label += " ⚠";
    if (b.availableVersion) label += " ↑";
    btn.textContent = label;
    if (b.missingRequired.length) btn.title = `Needs config: ${b.missingRequired.join(", ")}`;
    else if (b.availableVersion) btn.title = `Update available: ${b.availableVersion}`;
    btn.onclick = () => void selectBridge(b.info.id);
    list.append(btn);
  }
  const settingsList = $("#bridge-settings-list");
  settingsList.innerHTML = "";
  if (bridges.length > 0) {
    settingsList.style.display = "";
    for (const b of bridges) settingsList.append(buildBridgeSettingsEntry(b));
    const saved = localStorage.getItem("lastBridge");
    const initial = bridges.find((b) => b.info.id === saved) ? saved! : bridges[0]!.info.id;
    await selectBridge(initial);
  } else {
    settingsList.style.display = "none";
    status("No bridges installed. Add a registry below, or build one locally.");
  }
}

// ── Bridge dropdown (off the browse-view title) ──────────────────────────────────
function openBridgeDropdown(): void {
  // Only meaningful in the browse view, where the title shows the bridge name.
  if (currentView !== "browse") return;
  $("#app-header").classList.add("open");
  $("#bridge-dropdown").hidden = false;
}
function closeBridgeDropdown(): void {
  $("#app-header").classList.remove("open");
  $("#bridge-dropdown").hidden = true;
}
function toggleBridgeDropdown(): void {
  if ($("#bridge-dropdown").hidden) openBridgeDropdown();
  else closeBridgeDropdown();
}

/**
 * Sync the global title to the current view: the browse view shows the active bridge name with a
 * caret (a dropdown of other bridges); every other view keeps the "Comical" branding + tagline.
 */
function updateHeaderForView(view: string): void {
  // Only the browse view has a header: the bridge name + switcher. Every other view hides it.
  const interactive = view === "browse";
  $("#app-header").style.display = interactive ? "" : "none";
  $("#app-title").classList.toggle("interactive", interactive);
  $("#app-title-caret").hidden = !interactive;
  $("#app-subtitle").style.display = "none";
  if (interactive) $("#app-title-text").textContent = activeBridgeName || "Comical";
  else closeBridgeDropdown();
}

// ── Select a bridge: load info, settings, meta, lists ────────────────────────────
async function selectBridge(id: string): Promise<void> {
  activeBridge = id;
  localStorage.setItem("lastBridge", id);
  document.querySelectorAll<HTMLElement>("#bridge-list .tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
  closeBridgeDropdown();
  activeCaps = [];
  filterTagSelections.clear();
  switchView("browse");
  const detail = await api<BridgeDetail>(`/bridges/${id}`);
  activeCaps = detail.info.capabilities;
  activeBridgeName = detail.info.name;
  if (currentView === "browse") $("#app-title-text").textContent = detail.info.name;
  $("#caps").textContent = `[${detail.info.capabilities.join(", ")}]`;

  await renderMeta(detail.info.capabilities);

  const canSearch = detail.info.capabilities.includes("search");
  $("#query").style.display = canSearch ? "" : "none";
  $("#searchBtn").style.display = canSearch ? "" : "none";
  // Favorites is a home page only when the bridge supports it; otherwise fall back to Home.
  const hasFavorites = detail.info.capabilities.includes("favorites");
  $("#fav-tab").style.display = hasFavorites ? "" : "none";
  if (!hasFavorites && activeHomeTab === "favorites") activeHomeTab = "home";

  // Content needs the bridge configured.
  if (detail.missingRequired.length > 0) {
    clearHome();
    showBrowseMode("home");
    status(`"${detail.info.name}" needs configuration: ${detail.missingRequired.join(", ")}`, true);
    return;
  }

  await renderHome();
  void prefetchFavorites();

  status(`Loaded "${detail.info.name}".`);
}

/** Fetch the first favorites page in the background (no render) so the first tab open is instant. */
async function prefetchFavorites(): Promise<void> {
  const bridge = activeBridge;
  if (!activeCaps.includes("favorites") || favoritesCache.has(bridge)) return;
  try {
    const r = await api<PagedResults>(`/bridges/${bridge}/favorites?page=1`);
    favoritesCache.set(bridge, { items: [...r.items], nextPage: r.hasNextPage ? 2 : null });
  } catch { /* non-fatal — the tab fetches (and surfaces any error) on demand */ }
}

async function loadFavorites(page = 1): Promise<void> {
  const bridge = activeBridge;
  // Reopening the tab: repaint every page already loaded straight from cache, no network.
  const cached = favoritesCache.get(bridge);
  if (page === 1 && cached) {
    activeListId = null;
    renderGrid(cached.items);
    setLoadMore(cached.nextPage !== null, () => loadFavorites(cached.nextPage!));
    status(`Favorites: ${cached.items.length} item(s).`);
    return;
  }
  try {
    const r = await api<PagedResults>(`/bridges/${bridge}/favorites?page=${page}`);
    const entry = page === 1 || !cached ? { items: [] as SeriesEntry[], nextPage: null as number | null } : cached;
    entry.items.push(...r.items);
    entry.nextPage = r.hasNextPage ? page + 1 : null;
    favoritesCache.set(bridge, entry);
    if (page === 1) { activeListId = null; renderGrid(r.items); }
    else for (const item of r.items) $("#grid").append(makeCard(item));
    setLoadMore(entry.nextPage !== null, () => loadFavorites(entry.nextPage!));
    if (page === 1) status(`Favorites: ${entry.items.length} item(s).`);
  } catch (e) {
    if (page === 1) { $("#grid").innerHTML = ""; setLoadMore(false, async () => {}); }
    status(`Favorites unavailable — set a session token in settings? (${e instanceof Error ? e.message : String(e)})`, true);
  }
}

// ── Bridge settings list (Settings view) ─────────────────────────────────────────
function updateBridgeSummary(sumEl: HTMLElement, detail: BridgeDetail): void {
  sumEl.textContent = detail.info.name;
  if (detail.settings.length > 0) {
    const s = document.createElement("span");
    s.style.cssText = "margin-left:0.4rem;font-size:0.82rem;font-weight:normal";
    s.className = detail.missingRequired.length ? "warn" : "ok";
    s.textContent = detail.missingRequired.length ? `⚠ needs: ${detail.missingRequired.join(", ")}` : "✓";
    sumEl.append(" ", s);
  }
}

function buildBridgeSettingsEntry(b: BridgeSummary): HTMLElement {
  const det = document.createElement("details");
  det.className = "bridge-settings-entry";
  const sum = document.createElement("summary");
  sum.textContent = b.info.name;
  if (b.missingRequired.length) {
    const w = document.createElement("span");
    w.style.cssText = "margin-left:0.4rem;font-size:0.82rem;font-weight:normal";
    w.className = "warn";
    w.textContent = `⚠ needs: ${b.missingRequired.join(", ")}`;
    sum.append(" ", w);
  }
  const body = document.createElement("div");
  body.style.marginTop = "0.75rem";
  det.append(sum, body);
  let loaded = false;
  det.addEventListener("toggle", () => {
    if (!det.open || loaded) return;
    loaded = true;
    body.innerHTML = `<p class="muted" style="font-size:0.84rem">Loading…</p>`;
    api<BridgeDetail>(`/bridges/${b.info.id}`)
      .then((detail) => void renderBridgeSettingsBody(detail, body, sum))
      .catch((e) => { body.innerHTML = `<p class="err" style="font-size:0.84rem">Failed: ${esc(String(e))}</p>`; loaded = false; });
  });
  return det;
}

async function renderBridgeSettingsBody(detail: BridgeDetail, container: HTMLElement, sumEl: HTMLElement): Promise<void> {
  container.innerHTML = "";
  updateBridgeSummary(sumEl, detail);

  if (detail.settings.length > 0) {
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem;margin:0.5rem 0 0.75rem";
    for (const d of detail.settings) {
      const wrap = document.createElement("div");
      if (d.type === "string" && d.secret) wrap.className = "field-secret";
      const lbl = document.createElement("label");
      lbl.textContent = d.label + (d.required ? " *" : "");
      if (d.description) lbl.title = d.description;
      lbl.append(buildInput(d, detail.values[d.key], detail.secretsSet.includes(d.key)));
      wrap.append(lbl);
      grid.append(wrap);
    }
    container.append(grid);

    const row = document.createElement("div");
    row.className = "row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const msgEl = document.createElement("span");
    saveBtn.onclick = () => void saveBridgeSettings(detail.info.id, grid, msgEl, sumEl);
    row.append(saveBtn, msgEl);

    if (detail.info.capabilities.includes("favorites")) {
      const impBtn = document.createElement("button");
      impBtn.type = "button";
      impBtn.className = "secondary";
      impBtn.textContent = "Import favorites → Library";
      const impMsg = document.createElement("span");
      impMsg.className = "muted";
      impBtn.onclick = async () => {
        impBtn.disabled = true;
        impMsg.textContent = "Importing…";
        const res = await send("POST", `/library/import/bridges/${detail.info.id}/favorites`);
        impBtn.disabled = false;
        if (res.ok) {
          const { imported, skipped } = res.data as { imported: number; skipped: number };
          impMsg.textContent = `Done — ${imported} added, ${skipped} already in library.`;
          impMsg.className = "ok";
        } else {
          impMsg.textContent = (res.data as { error?: string })?.error ?? `error ${res.status}`;
          impMsg.className = "err";
        }
      };
      row.append(impBtn, impMsg);
    }
    container.append(row);
  } else {
    container.append(Object.assign(document.createElement("p"), { className: "muted", style: "font-size:0.84rem", textContent: "No configurable settings." }));
  }

  const prefs = await api<BridgePrefs>(`/library/bridges/${enc(detail.info.id)}/prefs`).catch(
    () => ({ bridgeId: detail.info.id, trackersDisabled: false, historyDisabled: false }),
  );

  const prefToggle = (checked: boolean, label: string, key: "trackersDisabled" | "historyDisabled"): HTMLLabelElement => {
    const lbl = document.createElement("label");
    lbl.style.cssText = "display:flex;align-items:center;gap:0.4rem;font-size:0.84rem;margin-top:0.6rem";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = checked;
    chk.onchange = async () => {
      await send("PUT", `/library/bridges/${enc(detail.info.id)}/prefs`, { [key]: chk.checked });
    };
    lbl.append(chk, label);
    return lbl;
  };

  container.append(
    prefToggle(prefs.trackersDisabled, "Disable tracker sync for this bridge", "trackersDisabled"),
    prefToggle(prefs.historyDisabled, "Don't track reading history for this bridge", "historyDisabled"),
  );
}

async function saveBridgeSettings(bridgeId: string, form: HTMLElement, msgEl: HTMLElement, sumEl: HTMLElement): Promise<void> {
  const body: Record<string, string | number | boolean | string[]> = {};
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((el) => {
    const key = el.dataset.key!;
    const kind = el.dataset.kind!;
    if (kind === "boolean") {
      body[key] = (el as HTMLInputElement).checked;
    } else if (kind === "enum" && (el as HTMLSelectElement).multiple) {
      body[key] = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value);
    } else if (kind === "number") {
      const v = (el as HTMLInputElement).value.trim();
      if (v !== "") body[key] = Number(v);
    } else {
      const v = (el as HTMLInputElement).value.trim();
      if (v !== "") body[key] = v;
    }
  });
  const res = await send("PUT", `/bridges/${bridgeId}/settings`, body);
  if (res.ok) {
    msgEl.textContent = "Saved ✓";
    msgEl.className = "ok";
    const detail = await api<BridgeDetail>(`/bridges/${bridgeId}`);
    updateBridgeSummary(sumEl, detail);
    document.querySelectorAll<HTMLElement>("#bridge-list .tab").forEach((el) => {
      if (el.dataset.id !== bridgeId) return;
      let label = detail.info.name;
      if (detail.missingRequired.length) label += " ⚠";
      if (detail.availableVersion) label += " ↑";
      el.textContent = label;
    });
    if (activeBridge === bridgeId) activeCaps = detail.info.capabilities;
  } else {
    msgEl.textContent = (res.data as { error?: string }).error ?? `error ${res.status}`;
    msgEl.className = "err";
  }
}

/** Build a control prefilled with the current stored value (falling back to the descriptor default). */
function buildInput(
  d: SettingDescriptor,
  current: string | number | boolean | string[] | undefined,
  secretSet: boolean,
  ctx?: { trackerId: string; form: HTMLElement },
): HTMLElement {
  if (d.type === "oauth-callback") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:0.4rem;margin-top:0.2rem";
    if (secretSet) {
      const status = document.createElement("span");
      status.className = "ok";
      status.style.fontSize = "0.82rem";
      status.textContent = "Connected ✓";
      wrap.append(status);
    }
    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.className = "secondary";
    connectBtn.style.cssText = "font-size:0.82rem;padding:0.3rem 0.7rem;align-self:flex-start";
    connectBtn.textContent = secretSet ? "Reconnect" : `Connect ${d.label}`;
    const statusMsg = document.createElement("span");
    statusMsg.style.cssText = "font-size:0.8rem;color:var(--fg-muted,#888)";
    connectBtn.onclick = async () => {
      connectBtn.disabled = true;
      statusMsg.textContent = "Opening authorization…";
      try {
        const settings: Record<string, string> = {};
        if (ctx) {
          ctx.form.querySelectorAll<HTMLInputElement>("[data-key]").forEach((el) => {
            if (el.value.trim()) settings[el.dataset.key!] = el.value.trim();
          });
        }
        const res = await send("POST", `/trackers/${ctx?.trackerId ?? ""}/oauth-start`, { key: d.key, settings });
        if (!res.ok) { statusMsg.textContent = (res.data as { error?: string }).error ?? "Failed to start OAuth"; connectBtn.disabled = false; return; }
        const { authUrl } = res.data as { authUrl: string };
        window.open(authUrl, "_blank", "noopener noreferrer");
        statusMsg.textContent = "Authorize in the browser window…";
        const onMsg = (e: MessageEvent) => {
          if ((e.data as { type?: string })?.type !== "comical-oauth-complete") return;
          window.removeEventListener("message", onMsg);
          statusMsg.textContent = "Connected! Refreshing…";
          void fetchTrackers().then((t) => { availableTrackers = t; return loadTrackerConfig(); });
        };
        window.addEventListener("message", onMsg);
        connectBtn.disabled = false;
      } catch (e) {
        statusMsg.textContent = e instanceof Error ? e.message : String(e);
        connectBtn.disabled = false;
      }
    };
    wrap.append(connectBtn, statusMsg);
    return wrap;
  }
  if (d.type === "oauth-pin") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:0.3rem;margin-top:0.2rem";
    const hasExchange = "exchange" in d && !!d.exchange;
    if (secretSet) {
      const status = document.createElement("span");
      status.className = "ok";
      status.style.fontSize = "0.82rem";
      status.textContent = "Connected ✓";
      wrap.append(status);
    }
    const link = document.createElement("a");
    link.href = d.authUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = secretSet ? "Reconnect" : `Connect ${d.label}`;
    link.style.cssText = "font-size:0.82rem";
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.key = d.key;
    input.dataset.kind = "oauth-pin";
    input.placeholder = secretSet
      ? `leave blank to keep — paste ${hasExchange ? "new authorization code" : "new token"} to update`
      : hasExchange ? "Paste the authorization code shown on the provider page" : "Paste the access token shown on the provider page";
    wrap.append(link, input);
    return wrap;
  }
  if (d.type === "enum") {
    const sel = document.createElement("select");
    sel.dataset.key = d.key;
    sel.dataset.kind = "enum";
    if (d.multiple) sel.multiple = true;
    const selected = current ?? d.default;
    for (const o of d.options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (selected === o.value || (Array.isArray(selected) && selected.includes(o.value))) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }
  const input = document.createElement("input");
  input.dataset.key = d.key;
  input.dataset.kind = d.type;
  if (d.type === "boolean") {
    input.type = "checkbox";
    input.checked = typeof current === "boolean" ? current : (d.default ?? false);
  } else if (d.type === "number") {
    input.type = "number";
    if (d.min !== undefined) input.min = String(d.min);
    if (d.max !== undefined) input.max = String(d.max);
    const v = current ?? d.default;
    if (v !== undefined) input.value = String(v);
  } else {
    input.type = d.secret ? "password" : "text";
    if (d.secret) {
      // Never echo a stored secret; show it's set and keep it if left blank.
      input.placeholder = secretSet ? "•••••• (saved — leave blank to keep)" : (d.placeholder ?? "");
    } else {
      if (d.placeholder) input.placeholder = d.placeholder;
      const v = current ?? d.default;
      if (v !== undefined) input.value = String(v);
    }
  }
  return input;
}

async function saveSettings(): Promise<void> {
  const body: Record<string, string | number | boolean | string[]> = {};
  $("#settings-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((el) => {
    const key = el.dataset.key!;
    const kind = el.dataset.kind!;
    if (kind === "boolean") {
      body[key] = (el as HTMLInputElement).checked;
    } else if (kind === "enum" && (el as HTMLSelectElement).multiple) {
      body[key] = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value);
    } else if (kind === "number") {
      const v = (el as HTMLInputElement).value.trim();
      if (v !== "") body[key] = Number(v);
    } else {
      const v = (el as HTMLInputElement).value.trim();
      if (v !== "") body[key] = v;
    }
  });
  const msg = $("#settings-msg");
  const res = await send("PUT", `/bridges/${activeBridge}/settings`, body);
  if (res.ok) {
    msg.textContent = "Saved ✓";
    msg.className = "ok";
    await selectBridge(activeBridge); // refresh missingRequired + reload content
  } else {
    const err = res.data as { error?: string };
    msg.textContent = err.error ?? `error ${res.status}`;
    msg.className = "err";
  }
}

// ── Filters / sort / tags (capability-gated) ─────────────────────────────────────
async function renderMeta(capabilities: string[]): Promise<void> {
  const panel = $("#meta-panel");
  let any = false;
  const filtersBlock = $("#filters-block");
  const sortBlock = $("#sort-block");
  const tagsBlock = $("#tags-block");
  filtersBlock.style.display = "none";
  sortBlock.style.display = "none";
  tagsBlock.style.display = "none";

  currentFilters = [];
  if (capabilities.includes("filters")) {
    try {
      currentFilters = await api<Filter[]>(`/bridges/${activeBridge}/filters`);
      renderFilterControls(currentFilters);
      filtersBlock.style.display = "";
      any = true;
    } catch { /* ignore */ }
  }
  currentSortOptions = [];
  if (capabilities.includes("sort")) {
    try {
      const sorts = await api<SortOption[]>(`/bridges/${activeBridge}/sort`);
      currentSortOptions = sorts;
      const field = $<HTMLSelectElement>("#sort-field");
      field.innerHTML = "";
      field.append(new Option("— default —", ""));
      for (const s of sorts) field.append(new Option(s.label, s.key));
      updateSortDirVisibility();
      sortBlock.style.display = "";
      any = true;
    } catch { /* ignore */ }
  }
  if (capabilities.includes("tags")) {
    try {
      const tags = await api<Tag[]>(`/bridges/${activeBridge}/tags`);
      $("#tags").innerHTML = tags.map((t) => `<span class="chip">${esc(t.label)}</span>`).join("");
      tagsBlock.style.display = "";
      any = true;
    } catch { /* ignore */ }
  }
  panel.style.display = "none";
  const toggleBtn = $<HTMLButtonElement>("#filters-toggle");
  toggleBtn.style.display = any ? "" : "none";
  toggleBtn.textContent = "Filters";
  browseBridge = activeBridge;
}

// ── Home (stacked list sections) + list detail ───────────────────────────────────
const listPath = (id: string, page: number): string =>
  `/bridges/${activeBridge}/lists/${enc(id)}?page=${page}`;

function clearHome(): void {
  for (const io of homeObservers) io.disconnect();
  homeObservers = [];
  $("#home-sections").innerHTML = "";
}

/** Toggle the browse view between the stacked home and the results/list-detail grid. */
function showBrowseMode(mode: "home" | "results"): void {
  const home = mode === "home";
  $("#home-sections").style.display = home ? "" : "none";
  $("#results-pane").style.display = home ? "none" : "";
  if (home) {
    activeListId = null;
    $("#grid").innerHTML = "";
    setLoadMore(false, async () => {});
  }
}

/** The "← Home" results header is for drill-downs (search / See all); home-page tabs hide it. */
function setResultsHead(show: boolean): void {
  $("#results-head").style.display = show ? "" : "none";
}

function updateHomeTabsActive(): void {
  document.querySelectorAll<HTMLElement>("#home-tabs .home-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === activeHomeTab));
}

/** Switch home pages. Home shows the list stack; Favorites shows the favorites grid (no back link). */
async function selectHomeTab(tab: "home" | "favorites"): Promise<void> {
  activeHomeTab = tab;
  updateHomeTabsActive();
  $<HTMLInputElement>("#query").value = "";
  status("");
  if (tab === "home") {
    setResultsHead(true);
    showBrowseMode("home");
  } else {
    showBrowseMode("results");
    setResultsHead(false);
    $("#results-label").textContent = "";
    await loadFavorites(1);
  }
}

/** Re-show the active home page (e.g. after clearing a search or backing out of a drill-down). */
function returnToHomeTab(): void {
  void selectHomeTab(activeHomeTab);
}

/**
 * Build the home view: a vertical stack of list sections in `getLists()` order. The hint on each
 * list decides how it renders; a `grid` that is the LAST section infinite-scrolls, earlier grids
 * page with a "Load more" button (see {@link renderSection}).
 */
async function renderHome(): Promise<void> {
  clearHome();
  activeHomeTab = "home";
  updateHomeTabsActive();
  setResultsHead(true);
  showBrowseMode("home");
  const host = $("#home-sections");
  if (activeCaps.includes("lists")) {
    const lists = await api<SeriesList[]>(`/bridges/${activeBridge}/lists`);
    currentLists = lists;
    for (let i = 0; i < lists.length; i++) {
      await renderSection(host, lists[i]!, i === lists.length - 1);
    }
  } else {
    currentLists = [];
  }
  if (host.children.length === 0) status("Nothing to show for this bridge yet.");
}

function sectionHead(name: string, seeAll?: () => void): HTMLElement {
  const head = document.createElement("div");
  head.className = "section-head";
  const h = document.createElement("h3");
  h.textContent = name;
  head.append(h);
  if (seeAll) {
    const btn = document.createElement("button");
    btn.className = "see-all";
    btn.textContent = "See all →";
    btn.onclick = seeAll;
    head.append(btn);
  }
  return head;
}

async function renderSection(host: HTMLElement, list: SeriesList, isLast: boolean): Promise<void> {
  const layout = list.layout ?? "grid";
  const horizontal = layout === "carousel" || layout === "ranked" || layout === "hero";
  let r: PagedResults;
  try {
    r = await api<PagedResults>(listPath(list.id, 1));
  } catch (e) {
    status(`List "${list.name}" failed to load: ${e instanceof Error ? e.message : e}`, true);
    return;
  }
  if (r.items.length === 0) return;

  const section = document.createElement("section");
  section.className = "section";

  if (horizontal) {
    // "See all" when there's more than what's shown — either further pages, or items past the two
    // rows the desktop carousel caps at (cards 11+ are hidden via CSS there).
    const hasMore = r.hasNextPage || r.items.length > 10;
    section.append(sectionHead(list.name, hasMore ? () => void showListDetail(list) : undefined));
    const row = document.createElement("div");
    row.className = "carousel" + (layout === "ranked" ? " ranked" : layout === "hero" ? " hero" : "");
    r.items.forEach((item, idx) => {
      const card = makeCard(item);
      if (layout === "ranked") {
        const badge = document.createElement("span");
        badge.className = "rank-badge";
        badge.textContent = String(idx + 1);
        card.prepend(badge);
      }
      row.append(card);
    });
    section.append(row);
  } else {
    // A non-terminal grid links to its full list and pages with "Load more"; the terminal grid
    // owns the page's downward scroll and loads more automatically.
    section.append(sectionHead(list.name, !isLast && r.hasNextPage ? () => void showListDetail(list) : undefined));
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const item of r.items) grid.append(makeCard(item));
    section.append(grid);
    if (isLast) attachInfinite(section, grid, list, r.hasNextPage);
    else attachLoadMore(section, grid, list, r.hasNextPage);
  }
  host.append(section);
}

/** A non-terminal grid section: append the next page on each click until exhausted. */
function attachLoadMore(section: HTMLElement, grid: HTMLElement, list: SeriesList, hasNextInit: boolean): void {
  let page = 1;
  let hasNext = hasNextInit;
  const wrap = document.createElement("div");
  wrap.className = "load-more-wrap";
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Load more";
  btn.style.display = hasNext ? "" : "none";
  btn.onclick = async () => {
    if (!hasNext || btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await api<PagedResults>(listPath(list.id, page + 1));
      page += 1;
      for (const item of r.items) grid.append(makeCard(item));
      hasNext = r.hasNextPage;
      btn.style.display = hasNext ? "" : "none";
    } catch (e) {
      status(`Load more failed: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      btn.disabled = false;
    }
  };
  wrap.append(btn);
  section.append(wrap);
}

/**
 * The terminal grid section: a sentinel at the page bottom auto-loads successive pages as it
 * scrolls into view. Only ever wired onto the final section, so the "one infinite list, and it's
 * at the bottom" invariant holds by construction.
 */
function attachInfinite(section: HTMLElement, grid: HTMLElement, list: SeriesList, hasNextInit: boolean): void {
  let page = 1;
  let hasNext = hasNextInit;
  let loading = false;
  const sentinel = document.createElement("div");
  sentinel.style.height = "1px";
  section.append(sentinel);
  if (!hasNext) return;
  const io = new IntersectionObserver(
    async (entries) => {
      if (loading || !hasNext || !entries.some((e) => e.isIntersecting)) return;
      loading = true;
      try {
        const r = await api<PagedResults>(listPath(list.id, page + 1));
        page += 1;
        for (const item of r.items) grid.append(makeCard(item));
        hasNext = r.hasNextPage;
        if (!hasNext) io.disconnect();
      } catch (e) {
        io.disconnect();
        status(`Infinite scroll stopped: ${e instanceof Error ? e.message : e}`, true);
      } finally {
        loading = false;
      }
    },
    { rootMargin: "400px" },
  );
  io.observe(sentinel);
  homeObservers.push(io);
}

/** Open a list full-screen in the results grid; the search box scopes to it when `searchable`. */
async function showListDetail(list: SeriesList): Promise<void> {
  showBrowseMode("results");
  setResultsHead(true);
  $("#results-label").textContent = list.searchable
    ? `${list.name} — search box scopes to this list`
    : list.name;
  await loadList(list.id, 1);
}

async function loadList(listId: string, page = 1): Promise<void> {
  if (page === 1) { activeListId = listId; status(`Loading list "${listId}"…`); }
  try {
    const r = await api<PagedResults>(listPath(listId, page));
    if (page === 1) renderGrid(r.items);
    else for (const item of r.items) $("#grid").append(makeCard(item));
    setLoadMore(r.hasNextPage, () => loadList(listId, page + 1));
    if (page === 1) {
      const searchable = currentLists.find((l) => l.id === listId)?.searchable;
      status(`${r.items.length} item(s) in "${listId}".${searchable ? " (search box scopes to this list)" : ""}`);
    }
  } catch (e) {
    status(`List load failed: ${e instanceof Error ? e.message : e}`, true);
  }
}

function makeCard(item: SeriesEntry): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <img src="${item.thumbnailUrl ?? ""}" alt="${esc(item.title)}" loading="lazy"
      onerror="this.onerror=null;this.src='https://placehold.co/300x450?text='+encodeURIComponent(this.alt||'No Cover')">
    <div class="card-title clampable" data-full="${esc(item.title)}"><span>${esc(item.title)}</span></div>
    ${item.subtitle ? `<div class="card-sub">${esc(item.subtitle)}</div>` : ""}`;
  card.onclick = () => void showDetail(item.id);
  return card;
}

function renderGrid(items: SeriesEntry[]): void {
  const grid = $("#grid");
  grid.innerHTML = "";
  for (const item of items) grid.append(makeCard(item));
  setLoadMore(false, async () => {});
}

async function showDetail(seriesId: string): Promise<void> {
  if (currentView !== "detail") previousView = currentView as "browse" | "library" | "history";
  switchView("detail");
  pushRoute(`detail/${enc(activeBridge)}/${enc(seriesId)}`);
  // Show skeleton placeholders (shimmer on cover/title/description) until the fetch resolves, so the
  // real content fades in without a layout jump rather than popping in from a "Loading…" stub.
  $("#detail").classList.add("loading");
  $("#detail-title").textContent = "";
  $("#detail-meta").innerHTML = "";
  $("#detail-stats").innerHTML = "";
  $("#detail-genres").innerHTML = "";
  $("#detail-taggroups").innerHTML = "";
  $("#detail-description").textContent = "";
  ($("#detail-cover") as HTMLImageElement).style.display = "none";
  $("#cover-chapter-badge").hidden = true;
  $("#lib-menu").hidden = true;
  $("#lib-list-picker").hidden = true;
  $("#tracker-menu").hidden = true;
  $("#tracker-panel").hidden = true;
  $("#chapters").innerHTML = "";
  $("#chapters-section").hidden = true;
  $("#page-thumbs").innerHTML = "";
  // Reset the chapters filter/sort to defaults for each newly-opened series.
  chapterFilter = "overview";
  chapterSortAsc = false;
  updateChapterControls();

  const isDirect = activeCaps.includes("direct");
  // `currentFilters` is rendered for `browseBridge`; if this series is from a different bridge (opened
  // from history/library), reload it so the author/genre chips below map to this bridge's filters.
  const filtersReload = browseBridge !== activeBridge && activeCaps.includes("filters")
    ? api<Filter[]>(`/bridges/${activeBridge}/filters`).catch(() => [] as Filter[])
    : Promise.resolve(currentFilters);
  const [info, chapters] = await Promise.all([
    api<SeriesInfo>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}`),
    isDirect
      ? Promise.resolve([] as Chapter[])
      : api<Chapter[]>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}/chapters`),
  ]);
  currentFilters = await filtersReload;

  $("#detail-title").textContent = info.title;
  const creator = info.author || info.artist;
  const creatorId = info.author ? info.authorId : info.artistId;
  const canSearch = activeCaps.includes("search") || activeCaps.includes("filters");
  const authorFilter = currentFilters.find((f) => f.key === "author");

  // Chapter count: shown solely as the pip overlaid on the cover (the title tooltip spells out the
  // unit), so we don't also repeat it as a redundant "📖 N chapters" stats line.
  const chapterCount = isDirect ? 0 : groupChapters(chapters).length;
  const coverBadge = $("#cover-chapter-badge");
  if (chapterCount) {
    coverBadge.hidden = false;
    coverBadge.textContent = String(chapterCount);
    coverBadge.title = `${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`;
  } else {
    coverBadge.hidden = true;
  }

  // Meta grid (label-over-value cells), populated only with fields the contract actually provides.
  const authorIsClickable = !!creator && canSearch;
  const metaCells: string[] = [];
  if (info.status) metaCells.push(metaCell("Status", esc(titleCase(info.status))));
  if (creator) {
    const label = info.author ? "Author" : "Artist";
    const value = authorIsClickable
      ? `<span class="meta-value chip-link" id="author-chip">${esc(creator)}</span>`
      : `<span class="meta-value">${esc(creator)}</span>`;
    metaCells.push(`<div class="meta-cell"><span class="meta-label">${label}</span>${value}</div>`);
  }
  if (info.artist && info.artist !== info.author) metaCells.push(metaCell("Artist", esc(info.artist)));
  if (info.languages?.length) metaCells.push(metaCell("Language", esc(info.languages.join(" / "))));
  $("#detail-meta").innerHTML = metaCells.join("");
  const authorChip = document.getElementById("author-chip");
  if (authorChip) authorChip.onclick = () => {
    if (authorFilter) {
      const val = creatorId ?? creator!;
      const value = authorFilter.type === "text" ? val : [val];
      void navigateToFilteredSearch([{ key: "author", value }]);
    } else {
      $<HTMLInputElement>("#query").value = creator!;
      switchView("browse");
      void doSearch();
    }
  };

  const cover = $("#detail-cover") as HTMLImageElement;
  if (info.thumbnailUrl) {
    cover.src = info.thumbnailUrl;
    cover.alt = info.title;
    cover.style.display = "";
    cover.onerror = () => {
      cover.onerror = null;
      cover.src = `https://placehold.co/200x300?text=${encodeURIComponent(info.title)}`;
    };
  }
  const favBtn = $("#fav-toggle") as HTMLButtonElement;
  if (activeCaps.includes("favorites")) {
    favBtn.hidden = false;
    favBtn.textContent = "☆ Favorite";
    let favorited = false;
    // Fire-and-forget: don't block readBtn wiring on the network round-trip
    api<{ favorited: boolean }>(`/bridges/${activeBridge}/favorites/${encodeURIComponent(seriesId)}`)
      .then((check) => {
        favorited = check.favorited;
        favBtn.textContent = favorited ? "★ Favorited" : "☆ Favorite";
      })
      .catch(() => { /* non-fatal */ });
    favBtn.onclick = async () => {
      const r = await send(
        favorited ? "DELETE" : "PUT",
        `/bridges/${activeBridge}/favorites/${encodeURIComponent(seriesId)}`,
      );
      if (r.ok) {
        favorited = !favorited;
        favBtn.textContent = favorited ? "★ Favorited" : "☆ Favorite";
        favoritesDirty = true;
        favoritesCache.delete(activeBridge);
      } else {
        status(`Favorite failed — set a session token? (${(r.data as { error?: string })?.error ?? r.status})`, true);
      }
    };
  } else {
    favBtn.hidden = true;
  }

  const genreFilter = currentFilters.find((f) => f.key === "genre");
  const genreOptions = genreFilter && "options" in genreFilter ? (genreFilter.options ?? []) : [];
  $("#detail-genres").innerHTML = (info.genres ?? [])
    .map((name) => {
      const opt = genreOptions.find((o) => o.label === name);
      return opt
        ? `<span class="chip chip-link" data-genre-id="${esc(opt.value)}">${esc(name)}</span>`
        : `<span class="chip">${esc(name)}</span>`;
    })
    .join("");
  $("#detail-genres").querySelectorAll<HTMLElement>("[data-genre-id]").forEach((el) => {
    el.onclick = () => void navigateToFilteredSearch([{ key: "genre", value: [el.dataset.genreId!] }]);
  });
  for (const grp of info.tagGroups ?? [])
    grp.tags.forEach((name, i) => { const id = grp.tagIds?.[i]; if (id) tagIdToName.set(id, name); });
  $("#detail-taggroups").innerHTML = (info.tagGroups ?? [])
    .map(
      (grp) =>
        `<div class="tag-group"><span class="tag-group-label">${esc(grp.label)}</span>` +
        grp.tags.map((t, i) => {
          const id = grp.tagIds?.[i] ?? "";
          return `<span class="chip tag chip-link" data-tag="${esc(id || t)}">${esc(t)}</span>`;
        }).join("") +
        `</div>`,
    )
    .join("");
  $("#detail-taggroups").querySelectorAll<HTMLElement>("[data-tag]").forEach((el) => {
    el.onclick = () => void navigateToFilteredSearch([{ key: "tag", value: [el.dataset.tag!] }]);
  });
  $("#detail-description").textContent = info.description ?? "";
  // Core info is rendered — drop the skeleton so the real content (and the cover) is revealed.
  $("#detail").classList.remove("loading");

  // Direct series read from page 1. The cover (when present) stays a click-to-read affordance, and
  // the primary ▶ button also reads from page 1 so there's an explicit control in the layout. For
  // chaptered series the button is the first-chapter entry point.
  const coverReadable = isDirect && !!info.thumbnailUrl;
  cover.classList.toggle("readable", coverReadable);
  cover.onclick = coverReadable ? () => void readDirect(seriesId) : null;
  cover.title = coverReadable ? "Read from page 1" : "";
  const readBtn = $<HTMLButtonElement>("#read-primary-btn");
  const firstGroup = isDirect ? undefined : groupChapters(chapters)[0];
  if (isDirect) {
    readBtn.hidden = false;
    readBtn.textContent = "▶ Read";
    readBtn.title = "";
    readBtn.onclick = () => void readDirect(seriesId);
  } else if (firstGroup) {
    readBtn.hidden = false;
    readBtn.textContent = `▶ ${firstGroup.name}`;
    // The button truncates with an ellipsis (long chapter names would otherwise widen the column);
    // expose the full name via the tooltip.
    readBtn.title = firstGroup.name;
    readBtn.onclick = () => void openChapter(pickVersion(firstGroup, preferredGroupName));
  } else {
    readBtn.hidden = true;
  }

  // Library tracking (optional module): track this series under the bridge it came from.
  prefetchedChapter = null;
  directPages = null;
  preloadedUrls.clear();
  preferredGroupName = undefined;
  currentSeries = { bridgeId: activeBridge, seriesId, info, chapters, progress: new Map(), inLibrary: false };
  await refreshLibraryStatus();
  renderChapters();
  if (isDirect) void loadPageThumbs(activeBridge, seriesId);
}

/**
 * For a direct series, fetch its flat page list and render a thumbnail grid (cached on `directPages`
 * so opening the reader doesn't re-fetch). The grid only renders when the bridge supplies cheaper
 * `thumbnailUrl`s — we never bulk-load full-resolution page images just for a preview.
 */
async function loadPageThumbs(bridgeId: string, seriesId: string): Promise<void> {
  let pages: Page[];
  try {
    pages = await api<Page[]>(`/bridges/${bridgeId}/series/${enc(seriesId)}/pages`);
  } catch {
    return; // non-fatal: the ▶ Read button still works (it re-fetches on its own)
  }
  // Guard against a stale response after the user navigated to a different series.
  if (!currentSeries || currentSeries.bridgeId !== bridgeId || currentSeries.seriesId !== seriesId) return;
  directPages = { bridgeId, seriesId, pages };
  renderPageThumbs(seriesId, pages);
}

function renderPageThumbs(seriesId: string, pages: Page[]): void {
  const grid = $("#page-thumbs");
  // Gate: only show the grid when the bridge provides real thumbnails.
  if (!pages.some((p) => p.thumbnailUrl)) {
    grid.innerHTML = "";
    return;
  }
  grid.innerHTML = pages
    .filter((p) => p.thumbnailUrl)
    .map(
      (p) =>
        `<div class="page-thumb" data-index="${p.index}">` +
        `<img loading="lazy" src="${esc(p.thumbnailUrl!)}" alt="Page ${p.index + 1}"` +
        ` onerror="this.onerror=null;this.src='https://placehold.co/160x220?text=Page+${p.index + 1}'">` +
        `<span class="page-num">${p.index + 1}</span>` +
        `</div>`,
    )
    .join("");
  grid.querySelectorAll<HTMLElement>(".page-thumb").forEach((el) => {
    el.onclick = () => void readDirect(seriesId, Number(el.dataset.index));
  });
}

// ── Library: detail-page tracking ────────────────────────────────────────────
interface CurrentSeries {
  bridgeId: string;
  seriesId: string;
  info: SeriesInfo;
  chapters: Chapter[];
  progress: Map<string, ProgressItem>;
  inLibrary: boolean;
}
let currentSeries: CurrentSeries | null = null;

interface ReaderState { ch: Chapter; pages: Page[]; currentPage: number; }
let readerState: ReaderState | null = null;

interface PrefetchedChapter { bridgeId: string; seriesId: string; ch: Chapter; pages: Page[] }
let prefetchedChapter: PrefetchedChapter | null = null;

/** Pages fetched for the direct series' thumbnail grid, reused when opening the reader. */
let directPages: { bridgeId: string; seriesId: string; pages: Page[] } | null = null;

// ── Logical chapters (scanlator grouping) ────────────────────────────────────────
// Sites with multiple scanlation groups return one Chapter per group. We collapse copies that share
// the same (number, language) into one "logical chapter" row, and remember which group the user last
// read so chapter-to-chapter navigation keeps the same scanlator + language.
interface ChapterGroup {
  key: string;
  number?: number;
  languageCode?: string;
  name: string; // representative display name (from the preferred/first version)
  versions: Chapter[];
}
/** The scanlation group the user last opened — used to keep the same source across chapter turns. */
let preferredGroupName: string | undefined;

/** Chapters-list view state (mirrors the Overview/All/Read/Unread tabs + sort arrows). */
type ChapterFilter = "overview" | "all" | "read" | "unread";
let chapterFilter: ChapterFilter = "overview";
let chapterSortAsc = false; // false → newest first (descending), matching the example layout
/** How many chapters the condensed "Overview" tab shows before offering "Show all". */
const OVERVIEW_LIMIT = 12;

/** One label-over-value cell in the detail meta grid. */
function metaCell(label: string, valueHtml: string): string {
  return `<div class="meta-cell"><span class="meta-label">${esc(label)}</span><span class="meta-value">${valueHtml}</span></div>`;
}

/** Reflect the current filter/sort state on the chapters-tab and sort-arrow buttons. */
function updateChapterControls(): void {
  document.querySelectorAll<HTMLElement>("#chapters-tabs .ch-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === chapterFilter);
  });
  document.querySelectorAll<HTMLElement>("#chapters-sort button").forEach((b) => {
    b.classList.toggle("active", (b.dataset.sort === "asc") === chapterSortAsc);
  });
}

/** Same logical-chapter key as the library: copies sharing (number, language) collapse; numberless stand alone. */
function chapterLogicalKey(c: Chapter): string {
  return c.number !== undefined ? `n:${c.number}:${c.languageCode ?? ""}` : `i:${c.id}`;
}

/** Collapse a chapter list into logical-chapter groups, ordered for reading (ascending number, numberless last). */
function groupChapters(chapters: Chapter[]): ChapterGroup[] {
  const byKey = new Map<string, ChapterGroup>();
  for (const ch of chapters) {
    const key = chapterLogicalKey(ch);
    let g = byKey.get(key);
    if (!g) {
      g = { key, number: ch.number, languageCode: ch.languageCode, name: ch.name, versions: [] };
      byKey.set(key, g);
    }
    g.versions.push(ch);
  }
  // Within a group, newest first (publishedAt desc) then by group name, so the default copy is the freshest.
  for (const g of byKey.values()) {
    g.versions.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || (a.group ?? "").localeCompare(b.group ?? ""));
    g.name = g.versions[0]!.name;
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.number !== undefined && b.number !== undefined) return a.number - b.number;
    if (a.number !== undefined) return -1;
    if (b.number !== undefined) return 1;
    return 0;
  });
}

/** Pick the copy of a group matching a preferred scanlator group, falling back to the first (freshest). */
function pickVersion(group: ChapterGroup, prefGroupName?: string): Chapter {
  return group.versions.find((v) => v.group === prefGroupName) ?? group.versions[0]!;
}
const preloadedUrls = new Set<string>();

let toolbarHideTimer: ReturnType<typeof setTimeout> | null = null;
function showToolbar(): void {
  const tb = document.querySelector(".reader-toolbar") as HTMLElement | null;
  if (!tb) return;
  tb.classList.remove("hidden");
  if (toolbarHideTimer) clearTimeout(toolbarHideTimer);
  toolbarHideTimer = setTimeout(() => tb.classList.add("hidden"), 3000);
}

function toggleToolbar(): void {
  const tb = document.querySelector(".reader-toolbar") as HTMLElement | null;
  if (!tb) return;
  if (tb.classList.contains("hidden")) {
    showToolbar();
  } else {
    if (toolbarHideTimer) clearTimeout(toolbarHideTimer);
    tb.classList.add("hidden");
  }
}

function preloadImages(urls: string[]): void {
  for (const url of urls) {
    if (preloadedUrls.has(url)) continue;
    preloadedUrls.add(url);
    const img = new Image();
    img.src = url;
  }
}

/** Load the series' library state (membership, progress) and surface any newly-published chapters. */
async function refreshLibraryStatus(): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId } = currentSeries;
  const libMenu = $("#lib-menu");
  const libBtn = $<HTMLButtonElement>("#lib-toggle");
  const picker = $("#lib-list-picker");
  const newBadge = $("#new-badge");
  libMenu.hidden = false;
  newBadge.hidden = true;
  picker.hidden = true;
  let detail: { entry: LibEntry; progress: ProgressItem[] } | undefined;
  try {
    detail = await api<{ entry: LibEntry; progress: ProgressItem[] }>(
      `/library/entries/${bridgeId}/${enc(seriesId)}`,
    );
    currentSeries.inLibrary = true;
    currentSeries.progress = new Map(detail.progress.map((p) => [p.chapterId, p]));
    // In-library: the button opens the list-management dropdown (lists + remove).
    libBtn.textContent = "✓ In Library ▾";
    libBtn.onclick = () => { picker.hidden = !picker.hidden; $("#tracker-panel").hidden = true; $("#group-panel").hidden = true; };
    // Detect new chapters since the last visit.
    const sync = await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/sync`, { chapters: currentSeries.chapters });
    const added = (sync.data as { added?: Chapter[] }).added ?? [];
    if (added.length) { newBadge.hidden = false; newBadge.textContent = `${added.length} new`; }
  } catch {
    currentSeries.inLibrary = false;
    currentSeries.progress = new Map();
    // Not in library: the button is a plain add affordance, no list management shown.
    libBtn.textContent = "＋ Library";
    libBtn.onclick = () => void toggleLibrary();
    picker.hidden = true;
    picker.innerHTML = "";
    $("#group-menu").hidden = true;
    $("#tracker-menu").hidden = true;
    $("#tracker-panel").hidden = true;
    return;
  }
  // Render UI panels separately — failures here must not reset inLibrary.
  await renderListPicker(detail.entry.listIds).catch(() => {});
  await renderGroupPanel(bridgeId, seriesId, detail.entry).catch(() => {});
  const trackersAvailable = await renderTrackerPanel(bridgeId, seriesId).catch(() => false);
  $("#tracker-menu").hidden = !trackersAvailable;
}

async function renderGroupPanel(bridgeId: string, seriesId: string, entry: LibEntry): Promise<void> {
  const menu = $("#group-menu");
  const panel = $("#group-panel");
  menu.hidden = true;
  panel.hidden = true;
  panel.innerHTML = "";

  const [groups, allEntries] = await Promise.all([
    api<SeriesGroup[]>("/library/groups").catch(() => [] as SeriesGroup[]),
    api<LibEntryView[]>("/library").catch(() => [] as LibEntryView[]),
  ]);

  const currentKey = `${bridgeId}:${seriesId}`;
  const entryByKey = new Map(allEntries.map((e) => [`${e.bridgeId}:${e.seriesId}`, e]));
  const group = entry.seriesGroupId ? groups.find((g) => g.id === entry.seriesGroupId) : undefined;
  const bridgeOf = (key: string) => key.slice(0, key.indexOf(":"));
  const nameOf = (key: string) => bridgeNames.get(bridgeOf(key)) ?? bridgeOf(key);

  // Same-title copies on other bridges not already in this group — the link/add candidates. Merging
  // two existing groups isn't supported (joinGroup doesn't detach a prior group), so from the grouped
  // side we only offer ungrouped candidates.
  const titleNorm = entry.title.trim().toLowerCase();
  const memberKeys = new Set(group?.memberKeys ?? [currentKey]);
  const candidates = allEntries.filter((e) =>
    e.title.trim().toLowerCase() === titleNorm &&
    !memberKeys.has(`${e.bridgeId}:${e.seriesId}`) &&
    !(group && e.seriesGroupId),
  );

  if (!group && candidates.length === 0) return; // nothing to show

  function makeBtn(text: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "secondary";
    b.style.cssText = "font-size:0.75rem;padding:0.15rem 0.5rem";
    b.textContent = text;
    b.onclick = fn;
    return b;
  }
  function sectionHead(text: string): void {
    if (panel.childElementCount > 0) {
      const sep = document.createElement("div");
      sep.className = "lib-menu-sep";
      panel.append(sep);
    }
    const h = document.createElement("div");
    h.className = "src-section-head";
    h.textContent = text;
    panel.append(h);
  }
  function makeRow(key: string, isPrimary: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "src-row";
    const id = document.createElement("div");
    id.className = "src-id";
    const thumb = entryByKey.get(key)?.thumbnailUrl;
    id.innerHTML =
      (thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : "") +
      `<span class="src-name">${esc(nameOf(key))}${isPrimary ? " <span class=\"ok\" style=\"font-size:0.7rem\">primary</span>" : ""}</span>`;
    const acts = document.createElement("span");
    acts.className = "src-acts";
    row.append(id, acts);
    panel.append(row);
    return acts;
  }

  // Manage: existing group members with switch / set-primary / unlink.
  if (group) {
    sectionHead("Sources");
    for (const key of group.memberKeys) {
      const acts = makeRow(key, key === group.primaryKey);
      const bid = bridgeOf(key);
      const sid = key.slice(key.indexOf(":") + 1);
      if (key !== currentKey) acts.append(makeBtn("Switch", () => void openSeries(bid, sid)));
      if (key !== group.primaryKey) acts.append(makeBtn("Set primary", async () => {
        await send("PUT", `/library/groups/${group.id}/primary`, { primaryKey: key });
        await refreshLibraryStatus();
      }));
      if (key === currentKey) acts.append(makeBtn("Unlink", async () => {
        await send("DELETE", `/library/entries/${bridgeId}/${enc(seriesId)}/leave-group`);
        await refreshLibraryStatus();
      }));
    }
  }

  // Discover: same-title copies on other bridges, kept visually distinct from the managed members.
  if (candidates.length > 0) {
    sectionHead(group ? "Add another source" : "Same title on other sources");
    for (const c of candidates) {
      const candidateKey = `${c.bridgeId}:${c.seriesId}`;
      const acts = makeRow(candidateKey, false);
      acts.append(makeBtn("Link", async () => {
        if (group) {
          await send("POST", `/library/entries/${c.bridgeId}/${enc(c.seriesId)}/join-group`, { groupId: group.id });
        } else if (c.seriesGroupId) {
          await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/join-group`, { groupId: c.seriesGroupId });
        } else {
          await send("POST", "/library/groups", { memberKeys: [currentKey, candidateKey], primaryKey: candidateKey });
        }
        await refreshLibraryStatus();
      }));
    }
  }

  menu.hidden = false;
}

// ── Tracker panel (per-series) ────────────────────────────────────────────────
let availableTrackers: TrackerSummary[] = [];

async function fetchTrackers(): Promise<TrackerSummary[]> {
  try { return await api<TrackerSummary[]>("/trackers"); }
  catch { return []; }
}

/** Render the per-series tracker management UI into #tracker-panel. Returns whether trackers are
 * available (so the library dropdown can decide whether to surface a "Trackers" button). The panel
 * stays hidden — it's revealed on demand from the library list-management dropdown. */
async function renderTrackerPanel(bridgeId: string, seriesId: string): Promise<boolean> {
  const panel = $("#tracker-panel");
  // Preserve the reveal state across re-renders triggered by link/unlink/sync actions, so the panel
  // doesn't collapse out from under the user mid-interaction. Fresh series loads reset it hidden.
  const wasOpen = !panel.hidden;
  panel.hidden = true;
  panel.innerHTML = "";

  if (availableTrackers.length === 0) return false;

  const prefs = await api<BridgePrefs>(`/library/bridges/${enc(bridgeId)}/prefs`).catch(
    () => ({ bridgeId, trackersDisabled: false }),
  );
  if (prefs.trackersDisabled) return false;

  const links = await api<TrackerLink[]>(
    `/library/entries/${bridgeId}/${enc(seriesId)}/tracker-links`,
  ).catch(() => [] as TrackerLink[]);

  if (links.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.cssText = "font-size:0.78rem;margin-bottom:0.35rem";
    empty.textContent = "No trackers linked yet.";
    panel.append(empty);
  }

  // Render each existing link.
  for (const link of links) {
    const tracker = availableTrackers.find((t) => t.info.id === link.trackerId);
    const name = tracker?.info.name ?? link.trackerId;
    const row = document.createElement("div");
    row.className = "tracker-row";
    const ago = link.lastSyncAt ? ` · synced ${relativeTime(link.lastSyncAt)}` : "";
    const progress = link.chaptersRead !== undefined ? ` · ${link.chaptersRead} read` : "";
    row.innerHTML = `<span><strong>${esc(name)}</strong><span class="muted"> ${esc(String(link.externalId))}${progress}${ago}</span></span>`;
    const acts = document.createElement("span");
    acts.className = "tracker-row-acts";

    const syncBtn = document.createElement("button");
    syncBtn.className = "secondary";
    syncBtn.style.cssText = "font-size:0.75rem;padding:0.15rem 0.5rem";
    syncBtn.textContent = "Sync";
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      // backgroundSync reconciles both directions for every entry, then pulls each tracker's list.
      const { data } = await send("POST", "/library/sync");
      const res = data as { readSynced?: number; suggestions?: Array<{ title: string }> };
      syncBtn.disabled = false;
      await renderTrackerPanel(bridgeId, seriesId);
      const parts = [`${res.readSynced ?? 0} chapters reconciled`];
      const sug = res.suggestions ?? [];
      if (sug.length > 0) parts.push(`${sug.length} tracked series not in library: ${sug.slice(0, 3).map((s) => s.title).join(", ")}${sug.length > 3 ? "…" : ""}`);
      status(`Synced. ${parts.join(" · ")}`);
    };

    const unlinkBtn = document.createElement("button");
    unlinkBtn.className = "secondary";
    unlinkBtn.style.cssText = "font-size:0.75rem;padding:0.15rem 0.5rem";
    unlinkBtn.textContent = "Unlink";
    unlinkBtn.onclick = async () => {
      await send("DELETE", `/library/entries/${bridgeId}/${enc(seriesId)}/tracker-links/${enc(link.trackerId)}`);
      await renderTrackerPanel(bridgeId, seriesId);
    };
    acts.append(syncBtn, unlinkBtn);
    row.append(acts);
    panel.append(row);
  }

  // "Link tracker" toggle.
  const linkBtn = document.createElement("button");
  linkBtn.className = "secondary";
  linkBtn.style.cssText = "font-size:0.75rem;margin-top:0.35rem";
  linkBtn.textContent = "+ Link tracker";
  panel.append(linkBtn);

  const searchArea = document.createElement("div");
  searchArea.style.display = "none";
  searchArea.style.marginTop = "0.5rem";

  // Tracker picker + search input.
  const trackerSel = document.createElement("select");
  trackerSel.style.cssText = "font-size:0.82rem;margin-right:0.4rem";
  for (const t of availableTrackers) {
    if (!t.info.capabilities.includes("search")) continue;
    const opt = document.createElement("option");
    opt.value = t.info.id;
    opt.textContent = t.info.name;
    trackerSel.append(opt);
  }

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search title…";
  searchInput.style.cssText = "font-size:0.82rem;width:14rem;margin-right:0.4rem";

  const goBtn = document.createElement("button");
  goBtn.textContent = "Search";
  goBtn.style.cssText = "font-size:0.82rem;padding:0.3rem 0.6rem";

  const resultsDiv = document.createElement("div");
  resultsDiv.style.marginTop = "0.4rem";

  if (trackerSel.options.length === 0) {
    // No tracker supports search — skip the search UI.
    searchArea.innerHTML = '<span class="muted">No configured trackers support search.</span>';
  } else {
    searchArea.append(trackerSel, searchInput, goBtn, resultsDiv);
    const doSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;
      goBtn.disabled = true;
      resultsDiv.innerHTML = '<span class="muted">Searching…</span>';
      try {
        const r = await api<TrackerSearchPageResult>(
          `/trackers/${enc(trackerSel.value)}/search?q=${enc(q)}`,
        );
        resultsDiv.innerHTML = "";
        if (r.items.length === 0) {
          resultsDiv.innerHTML = '<span class="muted">No results.</span>';
        }
        for (const item of r.items) {
          const row = document.createElement("div");
          row.className = "tracker-search-result";
          row.innerHTML =
            (item.thumbnailUrl ? `<img src="${esc(item.thumbnailUrl)}" alt="" onerror="this.style.display='none'">` : "") +
            esc(item.title) +
            `<span class="muted"> (${esc(String(item.externalId))})</span>`;
          row.onclick = async () => {
            await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/tracker-links`, {
              trackerId: trackerSel.value,
              externalId: item.externalId,
            });
            searchArea.style.display = "none";
            linkBtn.textContent = "+ Link tracker";
            await renderTrackerPanel(bridgeId, seriesId);
          };
          resultsDiv.append(row);
        }
      } catch (e) {
        resultsDiv.innerHTML = `<span class="err">${esc(e instanceof Error ? e.message : String(e))}</span>`;
      }
      goBtn.disabled = false;
    };
    goBtn.onclick = () => void doSearch();
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void doSearch(); });
  }

  panel.append(searchArea);
  linkBtn.onclick = () => {
    const open = searchArea.style.display !== "none";
    searchArea.style.display = open ? "none" : "";
    linkBtn.textContent = open ? "+ Link tracker" : "Cancel";
  };
  panel.hidden = !wasOpen;
  return true;
}

function relativeTime(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Tracker config panel (global, like Registry) ──────────────────────────────
async function loadTrackerConfig(): Promise<void> {
  const section = $("#trackers-config-panel");
  const list = $("#trackers-config-list");

  // Also fetch available trackers from registry, if any registries are added.
  let availableFromRegistry: AvailableTracker[] = [];
  try { availableFromRegistry = await api<AvailableTracker[]>("/registry/trackers"); } catch { /* no registry */ }

  if (availableTrackers.length === 0 && availableFromRegistry.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  list.innerHTML = "";

  for (const t of availableTrackers) {
    const item = document.createElement("div");
    item.className = "tracker-config-item";

    const stateText = t.missingRequired.length
      ? `— needs: ${t.missingRequired.join(", ")}`
      : "— configured";
    const stateClass = t.missingRequired.length ? "warn" : "ok";

    const det = document.createElement("details");
    det.innerHTML = `<summary style="font-size:0.88rem;font-weight:600">${esc(t.info.name)} <span class="${stateClass}" style="font-size:0.8rem">${esc(stateText)}</span></summary>`;

    if (t.settings.length > 0) {
      const form = document.createElement("div");
      form.className = "tracker-config-form";

      for (const d of t.settings) {
        const wrap = document.createElement("div");
        const label = document.createElement("label");
        label.textContent = d.label + (d.required ? " *" : "");
        if (d.description) label.title = d.description;
        label.append(buildInput(d, t.values[d.key], t.secretsSet.includes(d.key), { trackerId: t.info.id, form }));
        wrap.append(label);
        form.append(wrap);
      }

      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "0.5rem";
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.style.cssText = "font-size:0.82rem;padding:0.3rem 0.7rem";
      const msg = document.createElement("span");
      msg.style.fontSize = "0.8rem";
      saveBtn.onclick = async () => {
        const body: Record<string, string | number | boolean | string[]> = {};
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((el) => {
          const key = el.dataset.key!;
          const kind = el.dataset.kind!;
          if (kind === "boolean") { body[key] = (el as HTMLInputElement).checked; }
          else if (kind === "enum" && (el as HTMLSelectElement).multiple) {
            body[key] = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value);
          } else if (kind === "number") {
            const v = (el as HTMLInputElement).value.trim(); if (v !== "") body[key] = Number(v);
          } else {
            const v = (el as HTMLInputElement).value.trim(); if (v !== "") body[key] = v;
          }
        });
        const res = await send("PUT", `/trackers/${enc(t.info.id)}/settings`, body);
        if (res.ok) { msg.textContent = "Saved ✓"; msg.className = "ok"; availableTrackers = await fetchTrackers(); await loadTrackerConfig(); }
        else { const e = res.data as { error?: string }; msg.textContent = e.error ?? `error ${res.status}`; msg.className = "err"; }
      };
      row.append(saveBtn, msg);
      det.append(form, row);
    } else {
      det.innerHTML += '<span class="muted" style="font-size:0.82rem">No settings required.</span>';
    }

    item.append(det);
    list.append(item);
  }

  // ── Registry-available trackers ──────────────────────────────────────────
  if (availableFromRegistry.length > 0) {
    const heading = document.createElement("h4");
    heading.textContent = "Available from registry";
    heading.style.cssText = "margin:0.75rem 0 0.4rem;font-size:0.85rem;opacity:0.7";
    list.append(heading);

    for (const t of availableFromRegistry) {
      const row = document.createElement("div");
      row.className = "tracker-config-item";
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:0.5rem";

      const caps = t.entry.capabilities.join(", ") || "—";
      const versionTag = t.installedVersion
        ? `<span class="ok" style="font-size:0.78rem">installed ${esc(t.installedVersion)}</span>`
        : "";
      const updateTag = t.updateAvailable
        ? `<span class="warn" style="font-size:0.78rem"> → ${esc(t.entry.version)}</span>`
        : "";

      const info = document.createElement("span");
      info.innerHTML = `${esc(t.entry.name)} <span class="muted" style="font-size:0.8rem">v${esc(t.entry.version)}</span> ${versionTag}${updateTag}<br><span class="muted" style="font-size:0.78rem">${esc(caps)}</span>`;
      row.append(info);

      const acts = document.createElement("span");
      if (t.updateAvailable) {
        const btn = document.createElement("button");
        btn.textContent = `Update → ${t.entry.version}`;
        btn.onclick = async () => {
          btn.disabled = true;
          await send("POST", `/trackers/${enc(t.entry.id)}/update`);
          availableTrackers = await fetchTrackers();
          await loadTrackerConfig();
        };
        acts.append(btn);
      } else if (t.installedVersion) {
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = "Uninstall";
        btn.onclick = async () => {
          btn.disabled = true;
          await send("DELETE", `/trackers/${enc(t.entry.id)}`);
          availableTrackers = await fetchTrackers();
          await loadTrackerConfig();
        };
        acts.append(btn);
      } else {
        const btn = document.createElement("button");
        btn.textContent = "Install";
        btn.onclick = async () => {
          btn.disabled = true;
          await send("POST", `/registries/${encodeURIComponent(t.registryUrl)}/trackers/${enc(t.entry.id)}/install`);
          availableTrackers = await fetchTrackers();
          await loadTrackerConfig();
        };
        acts.append(btn);
      }
      row.append(acts);
      list.append(row);
    }
  }
}

async function toggleLibrary(): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId, info, inLibrary } = currentSeries;
  if (inLibrary) {
    await send("DELETE", `/library/entries/${bridgeId}/${enc(seriesId)}`);
  } else {
    const snap: Record<string, unknown> = { bridgeId, seriesId, title: info.title };
    if (info.thumbnailUrl) snap.thumbnailUrl = info.thumbnailUrl;
    if (info.author) snap.author = info.author;
    if (info.externalIds) snap.externalIds = info.externalIds;
    const r = await send("POST", "/library/entries", snap);
    if (r.ok) {
      const result = r.data as AddSeriesResult;
      if (result.autoLinked) {
        const [linkedBridge] = result.autoLinked.matchedKey.split(":");
        status(`Added and auto-linked with "${linkedBridge}" (same ${result.autoLinked.sharedId.service} id).`);
      }
    }
    await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/sync`, { chapters: currentSeries.chapters });
  }
  await refreshLibraryStatus();
  renderChapters();
}


/** Populate the list-management dropdown (lists + remove action). Visibility is driven by
 * the In-Library button; this only fills in contents and never forces the dropdown open. */
async function renderListPicker(selectedIds: string[]): Promise<void> {
  const picker = $("#lib-list-picker");
  if (!currentSeries?.inLibrary) { picker.hidden = true; picker.innerHTML = ""; return; }
  const lists = await api<LibraryList[]>("/library/lists");
  picker.innerHTML = "";

  const head = document.createElement("div");
  head.id = "lib-list-head";
  head.textContent = "Lists";
  picker.append(head);

  if (lists.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.cssText = "font-size:0.78rem;padding:0.1rem 0.4rem 0.3rem";
    empty.textContent = "No lists yet — create some via Manage lists in the Library tab.";
    picker.append(empty);
  } else {
    for (const list of lists) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedIds.includes(list.id);
      cb.dataset.id = list.id;
      cb.onchange = async () => {
        const ids = Array.from(picker.querySelectorAll<HTMLInputElement>("input:checked")).map((i) => i.dataset.id!);
        await send("PUT", `/library/entries/${currentSeries!.bridgeId}/${enc(currentSeries!.seriesId)}/lists`, { listIds: ids });
      };
      label.append(cb, document.createTextNode(list.name));
      picker.append(label);
    }
  }

  const sep = document.createElement("div");
  sep.className = "lib-menu-sep";
  picker.append(sep);

  const remove = document.createElement("button");
  remove.className = "lib-remove-btn";
  remove.textContent = "✕ Remove from library";
  remove.onclick = () => void toggleLibrary();
  picker.append(remove);
}

function renderChapters(): void {
  if (!currentSeries) return;
  const { chapters, progress, inLibrary } = currentSeries;
  const section = $("#chapters-section");
  const ul = $("#chapters");
  ul.innerHTML = "";

  let groups = groupChapters(chapters);
  if (groups.length === 0) { section.hidden = true; return; }
  section.hidden = false;
  updateChapterControls();

  // groupChapters returns ascending (reading order); descending is newest-first.
  if (!chapterSortAsc) groups = groups.slice().reverse();

  const isRead = (g: ChapterGroup) => g.versions.some((v) => progress.get(v.id)?.read);
  let shown = groups;
  if (chapterFilter === "read") shown = groups.filter(isRead);
  else if (chapterFilter === "unread") shown = groups.filter((g) => !isRead(g));
  else if (chapterFilter === "overview") shown = groups.slice(0, OVERVIEW_LIMIT);

  if (shown.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.style.cssText = "padding:0.6rem 0.2rem";
    li.textContent = chapterFilter === "read" ? "No chapters read yet." : "No unread chapters.";
    ul.append(li);
    return;
  }

  for (const group of shown) ul.append(renderChapterGroup(group, progress, inLibrary));

  // Overview is a condensed peek; offer a jump to the full list when there's more.
  if (chapterFilter === "overview" && groups.length > shown.length) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "ch-show-all";
    btn.textContent = `Show all ${groups.length} chapters`;
    btn.onclick = () => { chapterFilter = "all"; renderChapters(); };
    li.append(btn);
    ul.append(li);
  }
}

/** A short "Group · lang · Np" label for one scanlation-group copy of a chapter. */
function versionLabel(v: Chapter): string {
  const parts: string[] = [];
  if (v.group) parts.push(v.group);
  if (v.languageCode) parts.push(v.languageCode);
  if (v.pageCount) parts.push(`${v.pageCount}p`);
  return parts.join(" · ") || v.name;
}

/** One chapter-list row: a logical chapter, expandable to its per-scanlator copies. */
function renderChapterGroup(group: ChapterGroup, progress: Map<string, ProgressItem>, inLibrary: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const groupRead = group.versions.some((v) => progress.get(v.id)?.read);
  const multi = group.versions.length > 1;

  const row = document.createElement("div");
  row.className = "ch-row";
  if (groupRead) row.classList.add("read");

  const name = document.createElement("span");
  name.className = "ch-name";
  const lang = group.languageCode ? ` (${group.languageCode})` : "";
  const pages = !multi && group.versions[0]!.pageCount ? ` · ${group.versions[0]!.pageCount}p` : "";
  name.textContent = `${group.name}${lang}${pages}`;
  row.append(name);

  let sub: HTMLUListElement | undefined;
  if (multi) {
    const toggle = document.createElement("button");
    toggle.className = "ch-versions-toggle";
    const setLabel = () => { toggle.textContent = `${group.versions.length} versions ${sub!.hidden ? "▾" : "▴"}`; };
    sub = document.createElement("ul");
    sub.className = "ch-versions";
    sub.hidden = true;
    for (const v of group.versions) {
      const vli = document.createElement("li");
      if (progress.get(v.id)?.read) vli.classList.add("read");
      const dot = document.createElement("span");
      dot.className = "ch-dot";
      const vn = document.createElement("span");
      vn.className = "ch-name";
      vn.textContent = versionLabel(v);
      vli.append(dot, vn);
      vli.onclick = (e) => { e.stopPropagation(); void openChapter(v); };
      sub.append(vli);
    }
    setLabel();
    toggle.onclick = (e) => { e.stopPropagation(); sub!.hidden = !sub!.hidden; setLabel(); };
    row.append(toggle);
  }

  if (inLibrary) {
    const up = document.createElement("button");
    up.className = "ch-uptohere";
    up.textContent = "read to here";
    up.onclick = (e) => { e.stopPropagation(); void readUpTo(pickVersion(group, preferredGroupName).id); };
    row.append(up);
  }

  // Right-aligned: the chapter's publish time, then (in-library) a read checkbox.
  const publishedAt = group.versions[0]!.publishedAt;
  if (publishedAt) {
    const time = document.createElement("span");
    time.className = "ch-time";
    time.style.marginLeft = "auto";
    time.textContent = relativeTime(publishedAt);
    row.append(time);
  }

  if (inLibrary) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = groupRead;
    cb.title = "Mark read";
    if (!publishedAt) cb.style.marginLeft = "auto";
    cb.onclick = (e) => { e.stopPropagation(); void markGroupRead(group, cb.checked); };
    row.append(cb);
  }

  row.onclick = () => void openChapter(pickVersion(group, preferredGroupName));
  li.append(row);
  if (sub) li.append(sub);
  return li;
}

/**
 * Toggle the read state of a whole logical chapter. Marking read sets one copy (the library counts
 * logically, so a single copy makes the chapter read everywhere); un-marking clears every copy that
 * currently has a read record.
 */
async function markGroupRead(group: ChapterGroup, read: boolean): Promise<void> {
  if (!currentSeries) return;
  if (read) {
    const v = pickVersion(group, preferredGroupName);
    await markRead(v.id, true, v.name);
    return;
  }
  const toClear = group.versions.filter((v) => currentSeries!.progress.get(v.id)?.read);
  for (const v of toClear) await markRead(v.id, false, v.name);
  if (toClear.length === 0) renderChapters();
}

async function openChapter(ch: Chapter, resumePage?: number, replace = false): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId, inLibrary } = currentSeries;
  // Remember the scanlation group so next/prev keeps the same source where it exists.
  if (ch.group !== undefined) preferredGroupName = ch.group;
  // Replace when already in the reader (chapter-to-chapter nav shouldn't stack), or when the
  // caller asks — e.g. resuming from history, where we don't want the intermediate series-detail
  // entry to sit between the reader and history. Back should return to the pre-reader view.
  const replaceEntry = replace || currentView === "reader";
  switchView("reader");
  const route = `reader/${enc(bridgeId)}/${enc(seriesId)}/${enc(ch.id)}`;
  if (replaceEntry) {
    history.replaceState(null, "", `#${route}`);
  } else {
    pushRoute(route);
  }
  let pages: Page[];
  if (prefetchedChapter?.ch.id === ch.id &&
      prefetchedChapter.bridgeId === bridgeId &&
      prefetchedChapter.seriesId === seriesId) {
    pages = prefetchedChapter.pages;
    prefetchedChapter = null;
  } else {
    prefetchedChapter = null;
    $("#reader-info").textContent = `${ch.name} · Loading…`;
    $<HTMLButtonElement>("#reader-prev").disabled = true;
    $<HTMLButtonElement>("#reader-next").disabled = true;
    $("#reader-page").innerHTML = `<p class="muted" style="text-align:center;padding:2rem">Loading pages…</p>`;
    pages = await api<Page[]>(
      `/bridges/${bridgeId}/series/${enc(seriesId)}/chapters/${enc(ch.id)}/pages`,
    );
  }
  readerState = { ch, pages, currentPage: Math.min(resumePage ?? 0, Math.max(0, pages.length - 1)) };
  renderReaderPage(true);
  if (inLibrary) {
    await setProgress(ch, readerState.currentPage, pages.length);
  } else {
    recordHistory(readerState.currentPage);
  }
}

async function readDirect(seriesId: string, resumePage?: number, replace = false): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, info, inLibrary } = currentSeries;
  const replaceEntry = replace || currentView === "reader";
  switchView("reader");
  const route = `reader/${enc(bridgeId)}/${enc(seriesId)}/__direct__`;
  if (replaceEntry) history.replaceState(null, "", `#${route}`);
  else pushRoute(route);
  // Reuse the page list already fetched for the thumbnail grid; otherwise fetch it now.
  let pages: Page[];
  if (directPages?.bridgeId === bridgeId && directPages.seriesId === seriesId) {
    pages = directPages.pages;
  } else {
    $("#reader-info").textContent = `${info.title} · Loading…`;
    $<HTMLButtonElement>("#reader-prev").disabled = true;
    $<HTMLButtonElement>("#reader-next").disabled = true;
    $("#reader-page").innerHTML = `<p class="muted" style="text-align:center;padding:2rem">Loading pages…</p>`;
    pages = await api<Page[]>(`/bridges/${bridgeId}/series/${enc(seriesId)}/pages`);
  }
  const syntheticChapter: Chapter = { id: "__direct__", name: info.title };
  readerState = { ch: syntheticChapter, pages, currentPage: Math.min(resumePage ?? 0, Math.max(0, pages.length - 1)) };
  renderReaderPage(true);
  if (inLibrary) {
    await setProgress(syntheticChapter, readerState.currentPage, pages.length);
  } else {
    recordHistory(readerState.currentPage);
  }
}

/**
 * The next/previous logical chapter to read. Stays in the current chapter's language and, within the
 * target chapter, prefers the same scanlation group (falling back to the freshest copy). This keeps a
 * multi-scanlator series reading like a single continuous run instead of cycling through every group.
 */
function getAdjacentChapter(delta: 1 | -1): Chapter | null {
  if (!currentSeries || !readerState) return null;
  const cur = readerState.ch;
  const groups = groupChapters(currentSeries.chapters);
  const lane = groups.filter((g) => g.languageCode === cur.languageCode);
  const idx = lane.findIndex((g) => g.key === chapterLogicalKey(cur));
  if (idx !== -1) {
    const target = lane[idx + delta];
    return target ? pickVersion(target, cur.group ?? preferredGroupName) : null;
  }
  // Fallback for a chapter that isn't in the grouped list (e.g. a synthetic/direct read): step flat.
  const ordered = groups.flatMap((g) => g.versions);
  const flat = ordered.findIndex((c) => c.id === cur.id);
  return flat === -1 ? null : ordered[flat + delta] ?? null;
}

async function prefetchNextChapter(): Promise<void> {
  if (!currentSeries || !readerState) return;
  const nextCh = getAdjacentChapter(1);
  if (!nextCh) return;
  const { bridgeId, seriesId } = currentSeries;
  if (prefetchedChapter?.ch.id === nextCh.id &&
      prefetchedChapter.bridgeId === bridgeId &&
      prefetchedChapter.seriesId === seriesId) return;
  try {
    const pages = await api<Page[]>(
      `/bridges/${bridgeId}/series/${enc(seriesId)}/chapters/${enc(nextCh.id)}/pages`,
    );
    prefetchedChapter = { bridgeId, seriesId, ch: nextCh, pages };
    preloadImages(pages.slice(0, 3).map(p => p.imageUrl));
  } catch { /* silently discard — openChapter will retry */ }
}

/** One filmstrip slot: an empty pane when the neighbour page doesn't exist, else its image. */
/** Build one filmstrip slot as a real DOM node so it can be recycled across page turns (reused nodes
 *  keep their already-decoded image; only the newly-revealed neighbour is created on each ±1 turn). */
function makeReaderSlot(p: Page | undefined, pageNumber: number): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "reader-slot";
  if (!p) return slot; // empty slot past an end / chapter boundary
  const img = document.createElement("img");
  img.src = p.imageUrl;
  img.alt = `Page ${pageNumber}`;
  img.addEventListener("error", function fallback() {
    img.removeEventListener("error", fallback);
    img.src = `https://placehold.co/700x1000?text=Page+${pageNumber}`;
  });
  slot.appendChild(img);
  return slot;
}

/** The current filmstrip track (rebuilt on every render), or null when the reader isn't mounted. */
function readerTrack(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#reader-page .reader-track");
}

/**
 * Position the filmstrip. The resting (centred) state is translateX(-100%) so the middle slot —
 * the current page — fills the viewport; `dx` (px, +right) shifts it as the finger drags. Percent
 * keeps the resting/snapped states correct across resizes; px only rides along during a live drag.
 */
function setTrackOffset(dx: number, animate: boolean): void {
  const track = readerTrack();
  if (!track) return;
  track.classList.toggle("animate", animate);
  track.style.transform = dx === 0 ? "translateX(-100%)" : `translateX(calc(-100% + ${dx}px))`;
}

/** Update the toolbar text/buttons for the current page — the cheap part shared by full and incremental renders. */
function updateReaderChrome(): void {
  if (!readerState) return;
  const { ch, pages, currentPage } = readerState;
  const onLastPage = currentPage >= pages.length - 1;
  const nextCh = onLastPage ? getAdjacentChapter(1) : null;
  $("#reader-info").textContent = ch.name;
  $("#reader-progress").textContent = `${currentPage + 1} / ${pages.length}`;
  $<HTMLButtonElement>("#reader-prev").disabled = currentPage === 0;
  $<HTMLButtonElement>("#reader-next").disabled = onLastPage && !nextCh;
  $<HTMLButtonElement>("#reader-next").textContent = onLastPage && nextCh ? "Next ch. ›" : "Next ›";
}

/** Warm the images around the current page and pull in the next chapter as the end nears. */
function primeReaderAround(): void {
  if (!readerState) return;
  const { pages, currentPage } = readerState;
  preloadImages(pages.slice(Math.max(0, currentPage - 1), currentPage + 4).map(p => p.imageUrl));
  if (currentPage >= pages.length - 1 - 3) void prefetchNextChapter();
}

/** Full render: rebuild the whole 3-slot filmstrip from scratch (chapter open, page-jump, resize). */
function renderReaderPage(showOverlay = false): void {
  if (!readerState) return;
  const { pages, currentPage } = readerState;
  if (!pages[currentPage]) return;
  ($("#reader-view") as HTMLElement).scrollTop = 0;
  updateReaderChrome();
  const track = document.createElement("div");
  track.className = "reader-track";
  track.append(
    makeReaderSlot(pages[currentPage - 1], currentPage),
    makeReaderSlot(pages[currentPage], currentPage + 1),
    makeReaderSlot(pages[currentPage + 1], currentPage + 2),
  );
  $("#reader-page").replaceChildren(track);
  setTrackOffset(0, false);
  if (showOverlay) showToolbar();
  primeReaderAround();
}

/**
 * Incremental render for a ±1 page turn: slide the 3-slot window by one. Drops the slot that scrolled
 * off, appends/prepends only the newly-revealed neighbour, then re-centres — so the two reused slots
 * keep their decoded images and a fast swipe doesn't pay a full teardown/redecode. Falls back to a
 * full render if the track isn't in its expected 3-slot shape. `currentPage` must already be updated.
 */
function updateReaderWindow(dir: 1 | -1): void {
  if (!readerState) return;
  const track = readerTrack();
  if (!track || track.children.length !== 3) { renderReaderPage(); return; }
  const { pages, currentPage } = readerState;
  if (dir === 1) {
    track.firstElementChild?.remove();
    track.appendChild(makeReaderSlot(pages[currentPage + 1], currentPage + 2));
  } else {
    track.lastElementChild?.remove();
    track.insertBefore(makeReaderSlot(pages[currentPage - 1], currentPage), track.firstElementChild);
  }
  ($("#reader-view") as HTMLElement).scrollTop = 0;
  setTrackOffset(0, false);
  updateReaderChrome();
  primeReaderAround();
}

/** True when there is a page (or a following chapter) to slide toward in the given direction. */
function hasNeighbourPage(dir: 1 | -1): boolean {
  if (!readerState) return false;
  const { pages, currentPage } = readerState;
  if (dir === -1) return currentPage > 0;
  return currentPage < pages.length - 1 || !!getAdjacentChapter(1);
}

/** Soften the drag past an end with no page to reveal, so the strip rubber-bands instead of tearing off. */
function applySwipeResistance(dx: number): number {
  if (dx > 0 && !hasNeighbourPage(-1)) return dx * 0.25;
  if (dx < 0 && !hasNeighbourPage(1)) return dx * 0.25;
  return dx;
}

/** Run `cb` when the track's slide animation finishes, with a timeout fallback if transitionend never fires. */
function onceTransitionEnd(el: HTMLElement, cb: () => void): void {
  let done = false;
  const run = (): void => { if (done) return; done = true; el.removeEventListener("transitionend", run); cb(); };
  el.addEventListener("transitionend", run);
  setTimeout(run, 460); // > the .reader-track transition (0.38s) so it only fires if transitionend is dropped
}

/**
 * A page-turn slide that has been kicked off but not yet advanced `currentPage` (it's still
 * animating, waiting on `transitionend`), or null when nothing is mid-flight. A fresh gesture
 * calls this to land the previous turn instantly — otherwise a second swipe cancels the first
 * slide's transition, stranding it on the timeout fallback, which then fires late and makes the
 * strip lurch back to an old page.
 */
let pendingSwipeFinalize: (() => void) | null = null;

/** Animate the filmstrip fully toward a neighbour, then re-centre on it (the image is already in place). */
function commitSwipe(dir: 1 | -1): void {
  const track = readerTrack();
  if (!track) { void readerNavigate(dir); return; }
  track.classList.add("animate");
  track.style.transform = dir === 1 ? "translateX(-200%)" : "translateX(0%)";
  const finalize = (): void => {
    if (pendingSwipeFinalize !== finalize) return; // already flushed by a later gesture
    pendingSwipeFinalize = null;
    void readerNavigate(dir); // advances currentPage and re-renders (re-centres) synchronously
  };
  pendingSwipeFinalize = finalize;
  onceTransitionEnd(track, finalize);
}

/** Resolve a finished horizontal drag: commit to the neighbour past the threshold, else snap back. */
function finishSwipe(dx: number, width: number): void {
  const threshold = Math.max(60, width * 0.18);
  if (dx <= -threshold && hasNeighbourPage(1)) commitSwipe(1);
  else if (dx >= threshold && hasNeighbourPage(-1)) commitSwipe(-1);
  else setTrackOffset(0, true);
}

async function readerNavigate(delta: number): Promise<void> {
  if (!readerState) return;
  if (delta > 0 && readerState.currentPage >= readerState.pages.length - 1) {
    const nextCh = getAdjacentChapter(1);
    if (nextCh) await openChapter(nextCh);
    return;
  }
  const next = Math.max(0, Math.min(readerState.pages.length - 1, readerState.currentPage + delta));
  if (next === readerState.currentPage) return;
  const step = next - readerState.currentPage;
  readerState.currentPage = next;
  if (step === 1 || step === -1) updateReaderWindow(step); else renderReaderPage();
  if (currentSeries?.inLibrary) await setProgress(readerState.ch, readerState.currentPage, readerState.pages.length);
  else recordHistory(readerState.currentPage);
}

/** Jump straight to a 0-based page index (clamped) and persist, like {@link readerNavigate}. */
async function jumpToPage(index: number): Promise<void> {
  if (!readerState) return;
  const next = Math.max(0, Math.min(readerState.pages.length - 1, index));
  if (next === readerState.currentPage) return;
  readerState.currentPage = next;
  renderReaderPage();
  if (currentSeries?.inLibrary) await setProgress(readerState.ch, readerState.currentPage, readerState.pages.length);
  else recordHistory(readerState.currentPage);
}

/**
 * Turn the progress pill into a tiny page-number input. Enter jumps, Escape/blur cancels.
 * A `done` flag guards against blur firing after Enter (which would re-render twice).
 */
function openPageJump(): void {
  if (!readerState) return;
  const pill = $("#reader-progress");
  if (pill.querySelector(".page-jump")) return; // already editing
  const total = readerState.pages.length;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = String(total);
  input.value = String(readerState.currentPage + 1);
  input.className = "page-jump";
  input.setAttribute("inputmode", "numeric");
  // iOS's numeric keypad has no return key, so Enter can't submit there — give it a Go button.
  const go = document.createElement("button");
  go.textContent = "Go";
  go.className = "page-jump-go";
  pill.replaceChildren(input, document.createTextNode(` / ${total} `), go);
  input.focus();
  input.select();
  let done = false;
  const cancel = (): void => { if (done) return; done = true; renderReaderPage(); };
  const commit = (): void => {
    if (done) return;
    done = true;
    const n = parseInt(input.value, 10);
    renderReaderPage(); // restore the pill (jumpToPage re-renders again only if the page changes)
    if (Number.isFinite(n)) void jumpToPage(n - 1);
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  // pointerdown + preventDefault keeps focus on the input so its blur→cancel doesn't beat the commit.
  go.addEventListener("pointerdown", (e: PointerEvent) => { e.preventDefault(); commit(); });
  input.addEventListener("blur", cancel);
}

async function reloadProgress(): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId } = currentSeries;
  const progress = await api<ProgressItem[]>(`/library/entries/${bridgeId}/${enc(seriesId)}/progress`);
  currentSeries.progress = new Map(progress.map((p) => [p.chapterId, p]));
}

async function markRead(chapterId: string, read: boolean, name: string): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId } = currentSeries;
  await send("PUT", `/library/entries/${bridgeId}/${enc(seriesId)}/progress/${enc(chapterId)}`, { read, chapterName: name });
  await reloadProgress();
  renderChapters();
}

async function readUpTo(chapterId: string): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId, chapters } = currentSeries;
  await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/read-up-to`, { chapters, chapterId });
  await reloadProgress();
  renderChapters();
}

async function setProgress(ch: Chapter, lastPage: number, pageCount: number): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId } = currentSeries;
  const wasRead = currentSeries.progress.get(ch.id)?.read;
  await send("PUT", `/library/entries/${bridgeId}/${enc(seriesId)}/progress/${enc(ch.id)}`, { lastPage, pageCount, chapterName: ch.name });
  // Only re-render when read state may have flipped (reaching the end), to avoid churn while scrolling.
  if (!wasRead && lastPage >= pageCount - 1) { await reloadProgress(); renderChapters(); }
}

/**
 * Record a non-library read into the reading log, including the resume page. Library reads persist
 * the page through {@link setProgress}; non-library reads have no progress record, so the page rides
 * along on the history entry. Fire-and-forget — a failed write must not interrupt reading.
 */
function recordHistory(lastPage: number): void {
  if (!currentSeries || !readerState) return;
  const { bridgeId, seriesId, info } = currentSeries;
  const { ch } = readerState;
  void send("POST", "/reading-history", {
    bridgeId, seriesId, title: info.title, thumbnailUrl: info.thumbnailUrl,
    chapterId: ch.id, chapterName: ch.name, lastPage, pageCount: readerState.pages.length, lastReadAt: Date.now(),
  }).catch(() => {});
}

async function doSearch(): Promise<void> {
  const q = $<HTMLInputElement>("#query").value;
  const filters = collectFilters();
  const sort = collectSort();
  // An empty global query (no filters/sort, not scoped to a list) just returns to the home stack.
  if (q.trim() === "" && activeListId === null && filters.length === 0 && !sort) {
    returnToHomeTab();
    return;
  }
  showBrowseMode("results");
  setResultsHead(true);
  if (activeListId === null) $("#results-label").textContent = `Search: "${q.trim() || "all"}"`;
  await runSearch(q, filters, sort, 1);
}

async function navigateToFilteredSearch(filters: FilterValue[]): Promise<void> {
  // The chip belongs to the series' bridge, which may differ from whatever bridge the browse view
  // last rendered its filter controls for (e.g. clicked a series from another bridge in history).
  // Rebuild browse for the active bridge first, otherwise the values below land in the wrong DOM.
  if (browseBridge !== activeBridge) {
    await selectBridge(activeBridge);
  }
  switchView("browse");
  $<HTMLInputElement>("#query").value = "";
  for (const f of filters) {
    const el = $("#filters").querySelector<HTMLElement>(`[data-key="${f.key}"]`);
    if (!el) continue;
    if (el instanceof HTMLSelectElement && Array.isArray(f.value)) {
      for (const opt of el.options) opt.selected = (f.value as string[]).includes(opt.value);
    } else if (el.dataset.kind === "tag-multiselect" && Array.isArray(f.value)) {
      const tags = (f.value as string[]).map((id) => ({ id, label: tagIdToName.get(id) ?? id }));
      filterTagSelections.set(f.key, tags);
      const pills = el.querySelector<HTMLElement>(".tag-filter-pills");
      if (pills) {
        pills.innerHTML = tags.map((t) =>
          `<span class="tag-pill" data-id="${esc(t.id)}">${esc(t.label)} <button type="button">×</button></span>`
        ).join("");
        pills.querySelectorAll<HTMLElement>(".tag-pill button").forEach((btn) => {
          btn.onclick = () => {
            const id = btn.closest<HTMLElement>(".tag-pill")!.dataset.id!;
            filterTagSelections.set(f.key, (filterTagSelections.get(f.key) ?? []).filter((t) => t.id !== id));
            btn.closest<HTMLElement>(".tag-pill")!.remove();
          };
        });
      }
    } else if (el instanceof HTMLInputElement && typeof f.value === "string") {
      el.value = f.value;
    }
  }
  void doSearch();
}

async function runSearch(
  q: string,
  filters: FilterValue[],
  sort: ReturnType<typeof collectSort>,
  page: number,
): Promise<void> {
  const activeList = currentLists.find((l) => l.id === activeListId);
  const scoped = activeList?.searchable ? activeList : undefined;

  const qs = [`q=${enc(q)}`, `page=${page}`];
  if (filters.length) qs.push(`filters=${enc(JSON.stringify(filters))}`);
  if (sort) qs.push(`sort=${enc(sort.key)}&dir=${sort.ascending ? "asc" : "desc"}`);

  if (page === 1) {
    status(scoped ? `Searching in "${scoped.name}"…` : "Searching…");
  }
  try {
    const path = scoped
      ? `/bridges/${activeBridge}/lists/${enc(scoped.id)}?${qs.join("&")}`
      : `/bridges/${activeBridge}/search?${qs.join("&")}`;
    const r = await api<PagedResults>(path);
    if (page === 1) renderGrid(r.items);
    else for (const item of r.items) $("#grid").append(makeCard(item));
    setLoadMore(r.hasNextPage, () => runSearch(q, filters, sort, page + 1));
    if (page === 1) {
      const where = scoped ? ` in "${scoped.name}"` : "";
      const notes = [filters.length ? `${filters.length} filter(s)` : "", sort ? `sort:${sort.key}` : ""].filter(Boolean).join(", ");
      status(`${r.items.length} result(s) for "${q}"${where}${notes ? ` (${notes})` : ""}.`);
    }
  } catch (e) {
    status(`Search failed: ${e instanceof Error ? e.message : e}`, true);
  }
}

// ── Registry panel (M4) ──────────────────────────────────────────────────────────
async function loadRegistry(): Promise<void> {
  const registries = await api<SavedRegistry[]>("/registries");
  const list = $("#reg-list");
  list.innerHTML = registries
    .map((r) => `<div class="reg-item"><span>${esc(r.name)}<br><span class="muted">${esc(r.url)}</span></span>
      <button class="secondary" data-remove="${esc(r.url)}">Remove</button></div>`)
    .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      await send("DELETE", `/registries/${encodeURIComponent(btn.dataset.remove!)}`);
      await refreshAll();
    };
  });

  const browse = $("#reg-browse");
  if (registries.length === 0) {
    browse.innerHTML = '<span class="muted">No registries added.</span>';
    return;
  }
  const available = await api<AvailableBridge[]>("/registry/bridges");
  if (available.length === 0) {
    browse.innerHTML = '<span class="muted">No bridges found in the added registries.</span>';
    return;
  }
  browse.innerHTML = available
    .map((b) => {
      const action = b.updateAvailable
        ? `<button data-update="${esc(b.entry.id)}">Update → ${esc(b.entry.version)}</button>`
        : b.installedVersion
          ? `<button class="secondary" data-uninstall="${esc(b.entry.id)}">Uninstall</button>`
          : `<button data-install-reg="${esc(b.registryUrl)}" data-install-id="${esc(b.entry.id)}">Install</button>`;
      const tag = b.installedVersion ? `<span class="ok">installed ${esc(b.installedVersion)}</span>` : "";
      return `<div class="reg-item"><span>${esc(b.entry.name)} <span class="muted">v${esc(b.entry.version)}</span> ${tag}</span>${action}</div>`;
    })
    .join("");
  browse.querySelectorAll<HTMLButtonElement>("[data-install-id]").forEach((btn) => {
    btn.onclick = async () => {
      await send("POST", `/registries/${encodeURIComponent(btn.dataset.installReg!)}/bridges/${btn.dataset.installId}/install`);
      await refreshAll();
    };
  });
  browse.querySelectorAll<HTMLButtonElement>("[data-update]").forEach((btn) => {
    btn.onclick = async () => { await send("POST", `/bridges/${btn.dataset.update}/update`); await refreshAll(); };
  });
  browse.querySelectorAll<HTMLButtonElement>("[data-uninstall]").forEach((btn) => {
    btn.onclick = async () => { await send("DELETE", `/bridges/${btn.dataset.uninstall}`); await refreshAll(); };
  });
}

async function refreshAll(): Promise<void> {
  await loadBridges();
  await loadRegistry();
  availableTrackers = await fetchTrackers();
  await loadTrackerConfig();
}

// ── Library view (cross-bridge collection) ──────────────────────────────────
// Cached on full load so search/sort/filter changes only refetch entries, not lists+groups.
let libLists: LibraryList[] = [];
let libGroups: SeriesGroup[] = [];
// Filter/sort state. The list filter is single-select: null = all, "__unlisted__" = the no-lists
// bucket, otherwise a list id.
const UNLISTED = "__unlisted__";
let libListFilter: string | null = null;
let librarySearch = "";
let librarySort: "lastRead" | "added" | "title" | "unread" = "lastRead";

/** Full load: (re)fetch lists + groups, render the controls, then apply the current filters. */
async function loadLibrary(): Promise<void> {
  const [lists, groups] = await Promise.all([
    api<LibraryList[]>("/library/lists"),
    api<SeriesGroup[]>("/library/groups").catch(() => [] as SeriesGroup[]),
  ]);
  libLists = lists;
  libGroups = groups;
  // A filtered-on list that was just deleted falls back to "all".
  if (libListFilter && libListFilter !== UNLISTED && !lists.some((l) => l.id === libListFilter)) {
    libListFilter = null;
  }
  renderListFilter(lists);
  renderManageLists(lists);
  await applyLibraryFilters();
}

/** Whether any narrowing filter is active — drives the "no matches" vs "empty library" message. */
function hasLibraryFilters(): boolean {
  return libListFilter !== null || librarySearch.trim() !== "";
}

/** Refetch just the entries for the current search/sort/filter state and re-render the grid. */
async function applyLibraryFilters(): Promise<void> {
  const params = new URLSearchParams();
  if (libListFilter === UNLISTED) params.set("unlisted", "true");
  else if (libListFilter) params.set("list", libListFilter);
  const q = librarySearch.trim();
  if (q) params.set("q", q);
  params.set("sort", librarySort);
  const entries = await api<LibEntryView[]>(`/library?${params.toString()}`);
  renderLibraryGrid(entries);
}

function renderLibraryGrid(entries: LibEntryView[]): void {
  const grid = $("#library-grid");
  grid.innerHTML = "";
  if (entries.length === 0) {
    grid.innerHTML = hasLibraryFilters()
      ? "<p class=\"muted\">No series match your search or filters.</p>"
      : "<p class=\"muted\">Your library is empty. Open a series and tap \"＋ Library\".</p>";
    return;
  }

  // Track which entry keys are non-primary group members (to skip them — covered by the primary card).
  const hiddenKeys = new Set<string>();
  for (const g of libGroups) {
    for (const k of g.memberKeys) {
      if (k !== g.primaryKey) hiddenKeys.add(k);
    }
  }

  for (const e of entries) {
    const key = `${e.bridgeId}:${e.seriesId}`;
    if (hiddenKeys.has(key)) continue; // covered by primary card

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      ${e.unreadCount > 0 ? `<span class="badge-unread">${e.unreadCount}</span>` : ""}
      <img src="${e.thumbnailUrl ?? ""}" alt="${esc(e.title)}" loading="lazy"
        onerror="this.onerror=null;this.src='https://placehold.co/300x450?text='+encodeURIComponent(this.alt||'No Cover')">
      <div class="card-title clampable" data-full="${esc(e.title)}"><span>${esc(e.title)}</span></div>
      <div class="card-sub">${esc(e.bridgeId)}</div>`;
    // Per-card quick-assign — only when lists exist (otherwise there's nothing to assign to).
    if (libLists.length > 0) {
      const menuBtn = document.createElement("button");
      menuBtn.className = "card-menu-btn";
      menuBtn.textContent = "⋯";
      menuBtn.title = "Add to lists";
      menuBtn.onclick = (ev) => { ev.stopPropagation(); openCardListMenu(menuBtn, e); };
      card.append(menuBtn);
    }
    card.onclick = () => void openSeries(e.bridgeId, e.seriesId);
    grid.append(card);
  }
}

/** Open the shared list-checkbox popover anchored under a card's "⋯" button. */
function openCardListMenu(anchor: HTMLElement, entry: LibEntryView): void {
  const menu = $("#card-list-menu");
  menu.innerHTML = "";
  const assigned = new Set(entry.listIds);
  for (const list of libLists) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = assigned.has(list.id);
    cb.onchange = async () => {
      if (cb.checked) assigned.add(list.id);
      else assigned.delete(list.id);
      entry.listIds = [...assigned];
      await send("PUT", `/library/entries/${entry.bridgeId}/${enc(entry.seriesId)}/lists`, { listIds: [...assigned] });
      // If a list filter is active, the card may no longer match — re-apply.
      if (libListFilter) void applyLibraryFilters();
    };
    label.append(cb, document.createTextNode(list.name));
    menu.append(label);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${window.scrollY + r.bottom + 4}px`;
  menu.style.left = `${window.scrollX + r.left}px`;
  menu.hidden = false;
}

/** Populate the single-select list filter dropdown (All / each list / Unlisted). */
function renderListFilter(lists: LibraryList[]): void {
  const sel = $<HTMLSelectElement>("#lib-list-filter");
  sel.innerHTML = "";
  const opt = (value: string, label: string) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.append(o);
  };
  opt("", "All lists");
  for (const l of lists) opt(l.id, l.name);
  opt(UNLISTED, "Unlisted");
  sel.value = libListFilter ?? "";
  sel.onchange = () => { libListFilter = sel.value || null; void applyLibraryFilters(); };
}

/** Render the Manage-lists modal body: add field is wired separately; here we list each list with
 * inline rename, delete, and drag-to-reorder (HTML5 drag from the handle). */
function renderManageLists(lists: LibraryList[]): void {
  const host = $("#lib-list-manage");
  host.innerHTML = "";
  if (lists.length === 0) {
    host.innerHTML = "<p class=\"muted\">No lists yet. Add one above.</p>";
    return;
  }
  let dragId: string | null = null;
  for (const list of lists) {
    const row = document.createElement("div");
    row.className = "list-row";
    row.dataset.id = list.id;

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    handle.draggable = true;
    handle.ondragstart = (ev) => { dragId = list.id; ev.dataTransfer!.effectAllowed = "move"; };

    const nameInput = document.createElement("input");
    nameInput.className = "list-name-input";
    nameInput.value = list.name;
    nameInput.onkeydown = (ev) => { if (ev.key === "Enter") nameInput.blur(); };
    nameInput.onblur = async () => {
      const name = nameInput.value.trim();
      if (name && name !== list.name) { await send("PATCH", `/library/lists/${enc(list.id)}`, { name }); await loadLibrary(); }
      else nameInput.value = list.name;
    };

    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "✕";
    del.title = "Delete list";
    del.onclick = async () => {
      if (libListFilter === list.id) libListFilter = null;
      await send("DELETE", `/library/lists/${enc(list.id)}`);
      await loadLibrary();
    };

    row.ondragover = (ev) => { ev.preventDefault(); row.classList.add("drag-over"); };
    row.ondragleave = () => row.classList.remove("drag-over");
    row.ondrop = async (ev) => {
      ev.preventDefault();
      row.classList.remove("drag-over");
      if (!dragId || dragId === list.id) return;
      const ids = lists.map((l) => l.id);
      const [moved] = ids.splice(ids.indexOf(dragId), 1);
      ids.splice(ids.indexOf(list.id), 0, moved!);
      await send("POST", "/library/lists/reorder", { orderedIds: ids });
      await loadLibrary();
    };

    row.append(handle, nameInput, del);
    host.append(row);
  }
}

// ── History view ─────────────────────────────────────────────────────────────
async function loadHistory(): Promise<void> {
  const items = await api<HistoryItem[]>("/library/history");
  const host = $("#history-list");
  host.innerHTML = "";
  if (items.length === 0) {
    host.innerHTML = '<p class="muted">No reading history yet.</p>';
    return;
  }
  for (const h of items) {
    const row = document.createElement("div");
    row.className = "history-item";
    const when = new Date(h.lastReadAt).toLocaleString();
    // A direct series has no real chapter — its "chapter name" is just the title, so don't repeat it.
    const isDirect = h.lastReadChapterId === "__direct__";
    const chapterLabel = !isDirect && h.lastReadChapterName ? esc(h.lastReadChapterName) : "";
    const pageLabel = h.lastPage !== undefined
      ? (h.pageCount ? `${h.lastPage + 1} / ${h.pageCount}` : `Page ${h.lastPage + 1}`)
      : "";
    const sub = [chapterLabel, pageLabel, when].filter(Boolean).join(" · ");
    row.innerHTML = `
      <img src="${h.thumbnailUrl ?? ""}" alt="" onerror="this.style.visibility='hidden'">
      <div class="hi-body">
        <div class="hi-title clampable" data-full="${esc(h.title)}"><span>${esc(h.title)}</span></div>
        <div class="hi-sub">${sub}</div>
      </div>`;
    // Title / thumbnail open the series page; Resume jumps back into the reader.
    const openDetail = () => void openSeries(h.bridgeId, h.seriesId);
    for (const sel of ["img", ".hi-body"]) {
      const el = row.querySelector<HTMLElement>(sel);
      if (el) { el.style.cursor = "pointer"; el.addEventListener("click", openDetail); }
    }
    const resume = document.createElement("button");
    resume.textContent = "Resume";
    resume.onclick = () => void openSeries(h.bridgeId, h.seriesId, h.lastReadChapterId, h.lastPage);
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "btn-ghost";
    remove.onclick = async () => {
      await send("DELETE", `/library/history/${enc(h.bridgeId)}/${enc(h.seriesId)}`);
      row.remove();
      if (!host.querySelector(".history-item")) host.innerHTML = '<p class="muted">No reading history yet.</p>';
    };
    row.append(resume, remove);
    host.append(row);
  }
}

// ── Activity feed (newly-detected chapters) ──────────────────────────────────────
/** Compact "x ago" for activity timestamps; falls back to a date past a week. */
function relTime(ms: number): string {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function loadActivity(): Promise<void> {
  const items = await api<ActivityItemView[]>("/library/activity");
  const host = $("#activity-list");
  host.innerHTML = "";
  if (items.length === 0) {
    host.innerHTML = '<p class="muted">No new chapters yet. Hit “Check for updates” to scan your library.</p>';
    return;
  }
  for (const a of items) {
    const row = document.createElement("div");
    row.className = a.read ? "history-item read" : "history-item";
    const chap = a.chapterName ?? (a.number !== undefined ? `Chapter ${a.number}` : "New chapter");
    row.innerHTML = `
      <img src="${a.thumbnailUrl ?? ""}" alt="" onerror="this.style.visibility='hidden'">
      <div class="hi-body">
        <div class="hi-title clampable" data-full="${esc(a.title)}"><span>${esc(a.title)}</span></div>
        <div class="hi-sub">${esc(chap)} · ${relTime(a.detectedAt)}</div>
      </div>`;
    // Title / thumbnail open the series page; Read jumps straight into the chapter.
    const openDetail = () => void openSeries(a.bridgeId, a.seriesId);
    for (const sel of ["img", ".hi-body"]) {
      const el = row.querySelector<HTMLElement>(sel);
      if (el) { el.style.cursor = "pointer"; el.addEventListener("click", openDetail); }
    }
    const read = document.createElement("button");
    read.textContent = a.read ? "Read again" : "Read";
    read.onclick = () => void openSeries(a.bridgeId, a.seriesId, a.chapterId);
    row.append(read);
    host.append(row);
  }
}

/** Refresh the unread-count badge on the Activity nav item. */
async function refreshActivityBadge(): Promise<void> {
  const badge = document.querySelector<HTMLElement>("#activity-badge");
  if (!badge) return;
  try {
    const { unread } = await api<{ unread: number }>("/library/activity/count");
    if (unread > 0) {
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch {
    badge.hidden = true;
  }
}

// ── Cross-view navigation ──────────────────────────────────────────────────────
/** Ensure a bridge's capabilities are loaded (so favorites etc. render) without resetting browse UI. */
async function ensureBridge(bridgeId: string): Promise<void> {
  if (activeBridge === bridgeId && activeCaps.length) return;
  activeBridge = bridgeId;
  try {
    const d = await api<BridgeDetail>(`/bridges/${bridgeId}`);
    activeCaps = d.info.capabilities;
  } catch {
    activeCaps = [];
  }
}

/**
 * Load just the series state the reader needs — info, chapters, and library membership/progress —
 * without rendering or switching to the series-detail view. Lets "Resume" jump straight from history
 * into the reader instead of flashing the detail page on the way.
 */
async function loadSeriesForReader(seriesId: string): Promise<void> {
  const isDirect = activeCaps.includes("direct");
  const [info, chapters] = await Promise.all([
    api<SeriesInfo>(`/bridges/${activeBridge}/series/${enc(seriesId)}`),
    isDirect ? Promise.resolve([] as Chapter[]) : api<Chapter[]>(`/bridges/${activeBridge}/series/${enc(seriesId)}/chapters`),
  ]);
  prefetchedChapter = null;
  preloadedUrls.clear();
  currentSeries = { bridgeId: activeBridge, seriesId, info, chapters, progress: new Map(), inLibrary: false };
  try {
    const detail = await api<{ entry: LibEntry; progress: ProgressItem[] }>(`/library/entries/${activeBridge}/${enc(seriesId)}`);
    currentSeries.inLibrary = true;
    currentSeries.progress = new Map(detail.progress.map((p) => [p.chapterId, p]));
  } catch {
    // Not in the library (or the library module is off) — non-library resume uses the history page.
  }
}

/** Open a series from anywhere (library/history), optionally jumping into a chapter to resume. */
async function openSeries(bridgeId: string, seriesId: string, resumeChapterId?: string, resumePage?: number): Promise<void> {
  await ensureBridge(bridgeId);
  if (!resumeChapterId) {
    await showDetail(seriesId);
    return;
  }
  // Resume: load only what the reader needs and jump straight in — no detail-view flash. We stay on
  // the calling view (e.g. history) while loading, then the reader pushes a single entry on top, so
  // Back returns there directly.
  await loadSeriesForReader(seriesId);
  if (!currentSeries) return;
  // Library reads resume via the progress map; non-library reads carry the page on the history item.
  const lastPage = resumePage ?? currentSeries.progress.get(resumeChapterId)?.lastPage;
  // A direct series has no chapter list — its pages come from the direct endpoint, so resume must go
  // through readDirect rather than openChapter (which fetches per-chapter pages).
  if (resumeChapterId === "__direct__") {
    await readDirect(seriesId, lastPage);
    return;
  }
  const ch = currentSeries.chapters.find((c) => c.id === resumeChapterId);
  if (ch) await openChapter(ch, lastPage);
}

function switchView(view: "browse" | "library" | "history" | "activity" | "detail" | "reader" | "settings"): void {
  currentView = view;
  document.querySelectorAll<HTMLElement>(".bn-item").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view),
  );
  $("#browse-view").style.display = view === "browse" ? "" : "none";
  $("#library-view").style.display = view === "library" ? "" : "none";
  $("#history-view").style.display = view === "history" ? "" : "none";
  $("#activity-view").style.display = view === "activity" ? "" : "none";
  $("#detail-view").style.display = view === "detail" ? "" : "none";
  $("#reader-view").style.display = view === "reader" ? "" : "none";
  $("#settings-view").style.display = view === "settings" ? "" : "none";
  updateHeaderForView(view);
  if (view === "browse" || view === "library" || view === "history" || view === "activity" || view === "settings") pushRoute(view);
  if (view === "browse" && activeHomeTab === "favorites" && favoritesDirty) {
    favoritesDirty = false;
    void loadFavorites(1).catch((e) => status(`Favorites unavailable: ${e instanceof Error ? e.message : e}`, true));
  }
  if (view === "library") void loadLibrary().catch((e) => status(`Library unavailable: ${e instanceof Error ? e.message : e}`, true));
  if (view === "history") void loadHistory().catch((e) => status(`History unavailable: ${e instanceof Error ? e.message : e}`, true));
  if (view === "activity") void loadActivity().catch((e) => status(`Activity unavailable: ${e instanceof Error ? e.message : e}`, true));
  void refreshActivityBadge();
  document.body.style.overflow = view === "reader" ? "hidden" : "";
  if (view !== "reader") {
    if (toolbarHideTimer) { clearTimeout(toolbarHideTimer); toolbarHideTimer = null; }
    const tb = document.querySelector(".reader-toolbar") as HTMLElement | null;
    if (tb) tb.classList.remove("hidden");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  status("Connecting to server…");
  try {
    await api<{ ok: boolean }>("/health");
  } catch {
    status(`Cannot reach server at ${SERVER}. Is comical-server running? (bun run demo:server)`, true);
    return;
  }

  document.querySelectorAll<HTMLElement>(".bn-item").forEach((t) => {
    t.onclick = () => switchView((t.dataset.view as "browse" | "library" | "history" | "activity" | "settings") ?? "browse");
  });

  // Browse-view title doubles as a bridge switcher: click to toggle the dropdown of bridges.
  $("#app-title").onclick = () => { if (currentView === "browse") toggleBridgeDropdown(); };
  document.addEventListener("click", (e: MouseEvent) => {
    if (!$("#bridge-dropdown").hidden && !(e.target as HTMLElement).closest("#app-header")) closeBridgeDropdown();
  });

  $("#activity-refresh").onclick = async () => {
    const s = $("#activity-status");
    s.textContent = "Checking…";
    const res = await send("POST", "/library/sync");
    const data = res.data as { newChapters?: number };
    s.textContent = res.ok ? `Found ${data.newChapters ?? 0} new chapter(s).` : "Sync failed.";
    await loadActivity();
    await refreshActivityBadge();
  };
  $("#back-btn").onclick = () => history.back();
  // The Sources button toggles its own popover (anchored under the library button).
  $("#group-toggle").onclick = () => {
    const panel = $("#group-panel");
    panel.hidden = !panel.hidden;
    $("#lib-list-picker").hidden = true; // don't overlap the popovers
    $("#tracker-panel").hidden = true;
  };
  // The Trackers button toggles its own popover (anchored under the library button).
  $("#tracker-toggle").onclick = () => {
    const panel = $("#tracker-panel");
    panel.hidden = !panel.hidden;
    $("#lib-list-picker").hidden = true; // don't overlap the popovers
    $("#group-panel").hidden = true;
  };
  // Close any popover when clicking outside its menu.
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const picker = $("#lib-list-picker");
    if (!picker.hidden && !target.closest("#lib-menu")) picker.hidden = true;
    const group = $("#group-panel");
    if (!group.hidden && !target.closest("#group-menu")) group.hidden = true;
    const tracker = $("#tracker-panel");
    if (!tracker.hidden && !target.closest("#tracker-menu")) tracker.hidden = true;
    const cardMenu = $("#card-list-menu");
    if (!cardMenu.hidden && !target.closest("#card-list-menu") && !target.closest(".card-menu-btn")) cardMenu.hidden = true;
  });
  $("#chapters-tabs").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ch-tab");
    if (!btn) return;
    chapterFilter = btn.dataset.filter as ChapterFilter;
    renderChapters();
  });
  $("#chapters-sort").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-sort]");
    if (!btn) return;
    chapterSortAsc = btn.dataset.sort === "asc";
    renderChapters();
  });
  $("#reader-back").onclick = () => history.back();
  $("#reader-prev").onclick = () => void readerNavigate(-1);
  $("#reader-next").onclick = () => void readerNavigate(1);
  $("#reader-progress").addEventListener("click", (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    openPageJump();
  });
  $("#reader-page").addEventListener("click", (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    // Left 40% → prev, right 40% → next, center 20% band → toggle the overlay.
    if (frac < 0.4) void readerNavigate(-1);
    else if (frac > 0.6) void readerNavigate(1);
    else toggleToolbar();
  });
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (currentView !== "reader") return;
    if (e.key === "ArrowLeft") { e.preventDefault(); void readerNavigate(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); void readerNavigate(1); }
  });
  // Show toolbar on mouse movement (desktop idle recovery)
  ($("#reader-view") as HTMLElement).addEventListener("mousemove", () => {
    if (currentView === "reader") showToolbar();
  });
  // Touch navigation (mobile): a single finger physically drags the filmstrip and snaps to the
  // neighbour page (Mihon-style); two fingers are a pinch and never paginate; a clean tap falls
  // through to the left/right/centre zone logic below.
  const readerView = $("#reader-view") as HTMLElement;
  let swipeStartX = 0, swipeStartY = 0;
  let gestureActive = false;     // a single-finger gesture is in flight (still a tap or a drag)
  let gestureHorizontal = false; // that gesture has locked into a horizontal page-drag
  let multiTouch = false;        // 2+ fingers seen this gesture → pinch, suppress paging entirely
  let onControl = false;         // gesture began on a toolbar control → leave taps to native clicks
  readerView.addEventListener("touchstart", (e: TouchEvent) => {
    // Land any page-turn still sliding so this gesture starts from the real current page, not a
    // half-finished animation. Without this, a fast second swipe cancels the first slide's
    // transition and its late timeout re-renders an old page underneath you.
    pendingSwipeFinalize?.();
    if (e.touches.length >= 2) {
      // Pinch starting — drop any drag in progress and snap the strip home; never page on a pinch.
      multiTouch = true;
      if (gestureHorizontal) setTrackOffset(0, true);
      gestureActive = false; gestureHorizontal = false;
      return;
    }
    const target = e.target as HTMLElement;
    onControl = !!target.closest("button,a,input,#reader-progress");
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    gestureActive = true; gestureHorizontal = false; multiTouch = false;
  }, { passive: true });
  readerView.addEventListener("touchmove", (e: TouchEvent) => {
    if (e.touches.length >= 2 || multiTouch) {
      // A second finger landed mid-gesture — abandon the drag and let the browser pinch-zoom.
      if (gestureHorizontal) setTrackOffset(0, true);
      multiTouch = true; gestureActive = false; gestureHorizontal = false;
      return;
    }
    if (!gestureActive || onControl) return;
    const dy = e.touches[0].clientY - swipeStartY;
    if (!gestureHorizontal) {
      const dx = e.touches[0].clientX - swipeStartX;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        // Re-base the origin to here so the strip tracks the finger from 0 — without this it pops by
        // the ~10px we waited through to confirm the gesture was a horizontal drag, not a tap/scroll.
        gestureHorizontal = true;
        swipeStartX = e.touches[0].clientX;
      } else if (Math.abs(dy) > 12) { gestureActive = false; return; } // vertical intent — bail out
      else return;
    }
    e.preventDefault(); // claim the gesture so the page doesn't also scroll/zoom under us
    setTrackOffset(applySwipeResistance(e.touches[0].clientX - swipeStartX), false);
  }, { passive: false });
  const endSwipe = (e: TouchEvent): void => {
    if (e.touches.length > 0) return; // still fingers down (e.g. lifting one finger of a pinch)
    const wasMulti = multiTouch, wasHorizontal = gestureHorizontal;
    const wasActive = gestureActive, startedOnControl = onControl;
    multiTouch = false; gestureHorizontal = false; gestureActive = false;
    if (wasMulti) { setTrackOffset(0, true); return; } // pinch released — no page, no tap
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (wasHorizontal) { finishSwipe(applySwipeResistance(dx), readerView.clientWidth); return; }
    // Not a drag → tap-zone logic. Handled here (not via the synthesized click) so it doesn't
    // depend on a hover-priming first tap; preventDefault also suppresses the synthesized mouse
    // events, keeping the #reader-page click handler desktop-only. Controls keep their native click.
    if (startedOnControl || !wasActive) return;
    if (Math.abs(dx) >= 12 || Math.abs(dy) >= 12) return;
    const target = e.target as HTMLElement;
    if (target.closest("button,a")) return;
    if (target.tagName === "INPUT") return; // let the page-jump input handle its own taps
    if (target.closest("#reader-progress")) { e.preventDefault(); openPageJump(); return; }
    e.preventDefault();
    const frac = e.changedTouches[0].clientX / window.innerWidth;
    if (frac < 0.4) void readerNavigate(-1);
    else if (frac > 0.6) void readerNavigate(1);
    else toggleToolbar();
  };
  readerView.addEventListener("touchend", endSwipe, { passive: false });
  readerView.addEventListener("touchcancel", (e: TouchEvent) => {
    // A cancelled gesture (e.g. the OS taking over) should never page — just settle the strip.
    multiTouch = false; gestureActive = false;
    if (gestureHorizontal) { gestureHorizontal = false; setTrackOffset(0, true); }
    void e;
  });
  // Manage-lists modal: open/close + add-list. Rename/delete/reorder are wired per-row in renderManageLists.
  const manageModal = $("#manage-lists-modal");
  $("#lib-manage-lists").onclick = () => { manageModal.hidden = false; };
  $("#manage-lists-close").onclick = () => { manageModal.hidden = true; };
  manageModal.addEventListener("click", (e) => { if (e.target === manageModal) manageModal.hidden = true; });
  const addList = async () => {
    const input = $<HTMLInputElement>("#lib-new-list");
    const name = input.value.trim();
    if (!name) return;
    await send("POST", "/library/lists", { name });
    input.value = "";
    await loadLibrary();
  };
  $("#lib-add-list").onclick = () => void addList();
  $<HTMLInputElement>("#lib-new-list").addEventListener("keydown", (e) => { if (e.key === "Enter") void addList(); });

  // Library search/sort/filter controls. Search is debounced live filtering; sort re-queries.
  let libSearchDebounce: ReturnType<typeof setTimeout>;
  $<HTMLInputElement>("#lib-search").addEventListener("input", (e) => {
    librarySearch = (e.target as HTMLInputElement).value;
    clearTimeout(libSearchDebounce);
    libSearchDebounce = setTimeout(() => void applyLibraryFilters(), 200);
  });
  $<HTMLSelectElement>("#lib-sort").addEventListener("change", (e) => {
    librarySort = (e.target as HTMLSelectElement).value as typeof librarySort;
    void applyLibraryFilters();
  });

  $<HTMLSelectElement>("#sort-field").addEventListener("change", updateSortDirVisibility);
  $("#searchBtn").onclick = () => void doSearch();
  $("#browse-back").onclick = () => returnToHomeTab();
  $("#filters-toggle").onclick = () => {
    const panel = $("#meta-panel");
    const btn = $<HTMLButtonElement>("#filters-toggle");
    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    btn.textContent = open ? "Filters ✕" : "Filters";
  };
  document.querySelectorAll<HTMLElement>("#home-tabs .home-tab").forEach((t) => {
    t.onclick = () => void selectHomeTab((t.dataset.tab as "home" | "favorites") ?? "home");
  });
  $<HTMLInputElement>("#query").addEventListener("keydown", (e) => { if (e.key === "Enter") void doSearch(); });
  $("#reg-add").onclick = async () => {
    const url = $<HTMLInputElement>("#reg-url").value.trim();
    if (!url) return;
    const res = await send("POST", "/registries", { url });
    const msg = $("#reg-msg");
    if (res.ok) { msg.textContent = "Added ✓"; msg.className = "ok"; $<HTMLInputElement>("#reg-url").value = ""; await refreshAll(); }
    else { const e = res.data as { error?: string }; msg.textContent = e.error ?? `error ${res.status}`; msg.className = "err"; }
  };

  window.addEventListener("popstate", () => void handleRoute());

  // Clampable titles (series cards + history/activity rows) only reveal their full-text overlay
  // when actually truncated. Measuring is cheap when done lazily for just the item being interacted
  // with (one reflow, not one per rendered row), and re-measuring each activation keeps it correct
  // across resizes/orientation changes.
  const ITEM_SEL = ".card, .history-item";
  const markClamped = (item: HTMLElement): void => {
    const span = item.querySelector<HTMLElement>(".clampable > span");
    item.classList.toggle("clamped", !!span && span.scrollHeight > span.clientHeight + 1);
  };

  // Touch "hover": on touch devices :hover doesn't follow the finger, so the overlay never shows
  // while scrolling. Track whichever item sits under the finger and mark it active.
  let touchItem: HTMLElement | null = null;
  const setTouchItem = (el: HTMLElement | null): void => {
    if (el === touchItem) return;
    touchItem?.classList.remove("touch-active");
    touchItem = el;
    if (el) { markClamped(el); el.classList.add("touch-active"); }
  };
  const itemAt = (t: Touch): HTMLElement | null =>
    (document.elementFromPoint(t.clientX, t.clientY)?.closest(ITEM_SEL) as HTMLElement | null) ?? null;
  const onTouch = (e: TouchEvent): void => { if (e.touches[0]) setTouchItem(itemAt(e.touches[0])); };
  document.addEventListener("touchstart", onTouch, { passive: true });
  document.addEventListener("touchmove", onTouch, { passive: true });
  document.addEventListener("touchend", () => setTouchItem(null), { passive: true });
  document.addEventListener("touchcancel", () => setTouchItem(null), { passive: true });

  // Desktop hover: measure as the pointer crosses into an item (not on every descendant), before
  // :hover reveals the overlay.
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return; // touch path handled above
    const item = (e.target as Element | null)?.closest<HTMLElement>(ITEM_SEL);
    if (item && !item.contains(e.relatedTarget as Node | null)) markClamped(item);
  }, { passive: true });

  try {
    availableTrackers = await fetchTrackers();
    await Promise.all([loadBridges(), loadRegistry(), loadTrackerConfig()]);
  } catch (e) {
    status(`Init failed: ${e instanceof Error ? e.message : e}`, true);
  }

  initialized = true;
  void refreshActivityBadge();
  await handleRoute().catch(() => {});
})();
