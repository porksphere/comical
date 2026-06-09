/**
 * Browser console: a thin REST client for a running `comical serve` instance. It renders the
 * full host-server surface — bridge picker, settings form (typed descriptors + validation),
 * list tabs, search, series detail, filters/tags, and the M4 registry panel. The browser knows
 * nothing about bridges or parsing; it only calls the API and renders JSON.
 *
 *   bun run demo:server   — comical-server on :3100 (wired to the fixture backend)
 *   bun run demo:dev      — builds + serves this page on :3300
 */

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
interface Chapter { id: string; name: string; number?: number; pageCount?: number }
interface Page { index: number; imageUrl: string }
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
interface Category { id: string; name: string; order: number }
interface LibEntry { bridgeId: string; seriesId: string; title: string; thumbnailUrl?: string; author?: string; categoryIds: string[]; seriesGroupId?: string; externalIds?: Record<string, string | number>; lastReadChapterId?: string; lastReadChapterName?: string; lastReadAt?: number }
interface LibEntryView extends LibEntry { unreadCount: number }
interface HistoryItem { bridgeId: string; seriesId: string; title: string; thumbnailUrl?: string; lastReadChapterId?: string; lastReadChapterName?: string; lastReadAt: number }
interface SeriesGroup { id: string; title: string; primaryKey: string; memberKeys: string[]; createdAt: number }
interface AddSeriesResult { entry: LibEntry; autoLinked?: { matchedKey: string; sharedId: { service: string; value: number | string } } }
// Trackers
interface TrackerSummary { info: { id: string; name: string; capabilities: string[] }; settings: SettingDescriptor[]; values: Record<string, string | number | boolean | string[]>; secretsSet: string[]; configured: boolean; missingRequired: string[] }
interface BridgePrefs { bridgeId: string; trackersDisabled: boolean }
interface TrackerLink { trackerId: string; externalId: string | number; status?: string; chaptersRead?: number; lastSyncAt?: number }
interface TrackerSearchPageResult { items: Array<{ externalId: string | number; title: string; thumbnailUrl?: string }>; page: number; hasNextPage: boolean }
interface AvailableTracker { entry: { id: string; name: string; version: string; capabilities: string[] }; registryUrl: string; installedVersion: string | null; updateAvailable: boolean }

// ── DOM + API helpers ────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const enc = encodeURIComponent;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

function status(msg: string, isError = false): void {
  const el = $("#status");
  el.textContent = msg;
  el.className = isError ? "error" : "";
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
let currentFilters: Filter[] = [];
let currentLists: SeriesList[] = [];
let activeListId: string | null = null;
let currentView: "browse" | "library" | "history" | "detail" | "reader" | "settings" = "browse";
let previousView: "browse" | "library" | "history" = "browse";
let loadMoreFn: (() => Promise<void>) | null = null;
let currentSortOptions: SortOption[] = [];
const filterTagSelections = new Map<string, Array<{ id: string; label: string }>>();
const tagIdToName = new Map<string, string>();

// ── URL routing ─────────────────────────────────────────────────────────────────
// Route scheme: #browse | #library | #history | #detail/{bridgeId}/{seriesId} | #reader/{bridgeId}/{seriesId}/{chapterId}
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
        const ch = chapterId === "__direct__"
          ? { id: "__direct__", name: currentSeries.info.title }
          : currentSeries.chapters.find((c) => c.id === chapterId);
        if (ch) await openChapter(ch);
      }
    } else {
      switchView("browse");
    }
  } finally {
    isRestoringRoute = false;
  }
}

function setLoadMore(hasMore: boolean, fn: () => Promise<void>): void {
  loadMoreFn = hasMore ? fn : null;
  $<HTMLButtonElement>("#load-more").style.display = hasMore ? "" : "none";
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
async function loadBridges(): Promise<void> {
  const bridges = await api<BridgeSummary[]>("/bridges");
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

// ── Select a bridge: load info, settings, meta, lists ────────────────────────────
async function selectBridge(id: string): Promise<void> {
  activeBridge = id;
  localStorage.setItem("lastBridge", id);
  document.querySelectorAll<HTMLElement>("#bridge-list .tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
  activeCaps = [];
  filterTagSelections.clear();
  switchView("browse");
  const detail = await api<BridgeDetail>(`/bridges/${id}`);
  activeCaps = detail.info.capabilities;
  $("#caps").textContent = `[${detail.info.capabilities.join(", ")}]`;

  await renderMeta(detail.info.capabilities);

  const canSearch = detail.info.capabilities.includes("search");
  $("#query").style.display = canSearch ? "" : "none";
  $("#searchBtn").style.display = canSearch ? "" : "none";

  // Content needs the bridge configured.
  if (detail.missingRequired.length > 0) {
    $("#list-tabs").innerHTML = "";
    $("#grid").innerHTML = "";
    status(`"${detail.info.name}" needs configuration: ${detail.missingRequired.join(", ")}`, true);
    return;
  }

  if (detail.info.capabilities.includes("lists")) await loadLists();
  else { $("#list-tabs").innerHTML = ""; $("#grid").innerHTML = ""; }
  if (activeCaps.includes("favorites")) addFavoritesTab();

  status(`Loaded "${detail.info.name}".`);
}

/** A "★ Favorites" pseudo-tab (capability "favorites") that loads the account's favorites. */
function addFavoritesTab(): void {
  const tabs = $("#list-tabs");
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.textContent = "★ Favorites";
  tab.onclick = () => {
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    void loadFavorites();
  };
  tabs.append(tab);
}

async function loadFavorites(page = 1): Promise<void> {
  try {
    const r = await api<PagedResults>(`/bridges/${activeBridge}/favorites?page=${page}`);
    if (page === 1) { activeListId = null; renderGrid(r.items); }
    else for (const item of r.items) $("#grid").append(makeCard(item));
    setLoadMore(r.hasNextPage, () => loadFavorites(page + 1));
    if (page === 1) status(`Favorites: ${r.items.length} item(s).`);
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
    () => ({ bridgeId: detail.info.id, trackersDisabled: false }),
  );
  const trackerLbl = document.createElement("label");
  trackerLbl.style.cssText = "display:flex;align-items:center;gap:0.4rem;font-size:0.84rem;margin-top:0.6rem";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = prefs.trackersDisabled;
  chk.onchange = async () => {
    await send("PUT", `/library/bridges/${enc(detail.info.id)}/prefs`, { trackersDisabled: chk.checked });
  };
  trackerLbl.append(chk, "Disable tracker sync for this bridge");
  container.append(trackerLbl);
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
}

// ── Lists + grid ─────────────────────────────────────────────────────────────────
async function loadLists(): Promise<void> {
  const lists = await api<SeriesList[]>(`/bridges/${activeBridge}/lists`);
  currentLists = lists;
  const tabs = $("#list-tabs");
  tabs.innerHTML = "";
  if (lists.length === 0) { activeListId = null; return; }
  const initial = lists.find((l) => l.featured)?.id ?? lists[0]!.id;
  for (const l of lists) {
    const tab = document.createElement("div");
    tab.className = "tab" + (l.id === initial ? " active" : "");
    tab.textContent = l.name;
    tab.onclick = () => {
      if (tab.classList.contains("active")) {
        // Toggle off → deselect the list; search reverts to global, grid cleared.
        tab.classList.remove("active");
        activeListId = null;
        $("#grid").innerHTML = "";
        status(`Deselected "${l.name}". Search is now global.`);
        return;
      }
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      void loadList(l.id);
    };
    tabs.append(tab);
  }
  await loadList(initial);
}

async function loadList(listId: string, page = 1): Promise<void> {
  if (page === 1) { activeListId = listId; status(`Loading list "${listId}"…`); }
  try {
    const r = await api<PagedResults>(`/bridges/${activeBridge}/lists/${enc(listId)}?page=${page}`);
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
    <div class="card-title">${esc(item.title)}</div>
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
  $("#detail-title").textContent = "Loading…";
  $("#detail-meta").textContent = "";
  $("#detail-genres").innerHTML = "";
  $("#detail-taggroups").innerHTML = "";
  $("#detail-description").textContent = "";
  ($("#detail-cover") as HTMLImageElement).style.display = "none";
  $("#chapters").innerHTML = "";

  const isDirect = activeCaps.includes("direct");
  const [info, chapters] = await Promise.all([
    api<SeriesInfo>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}`),
    isDirect
      ? Promise.resolve([] as Chapter[])
      : api<Chapter[]>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}/chapters`),
  ]);

  $("#detail-title").textContent = info.title;
  const creator = info.author || info.artist;
  const creatorId = info.author ? info.authorId : info.artistId;
  const canSearch = activeCaps.includes("search") || activeCaps.includes("filters");
  const authorFilter = currentFilters.find((f) => f.key === "author");
  const otherMeta = [
    info.status,
    info.languages?.length ? info.languages.join(" / ") : undefined,
  ].filter(Boolean).join(" · ");
  if (creator && canSearch) {
    const suffix = otherMeta ? ` · ${esc(otherMeta)}` : "";
    $("#detail-meta").innerHTML = `<span class="chip chip-link" id="author-chip">${esc(creator)}</span>${suffix}`;
    document.getElementById("author-chip")!.onclick = () => {
      if (authorFilter) {
        const val = creatorId ?? creator;
        const value = authorFilter.type === "text" ? val : [val];
        navigateToFilteredSearch([{ key: "author", value }]);
      } else {
        $<HTMLInputElement>("#query").value = creator;
        switchView("browse");
        void doSearch();
      }
    };
  } else {
    $("#detail-meta").textContent = [creator, otherMeta || undefined].filter(Boolean).join(" · ");
  }

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
    el.onclick = () => navigateToFilteredSearch([{ key: "genre", value: [el.dataset.genreId!] }]);
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
    el.onclick = () => navigateToFilteredSearch([{ key: "tag", value: [el.dataset.tag!] }]);
  });
  $("#detail-description").textContent = info.description ?? "";

  const readBtn = $<HTMLButtonElement>("#read-direct-btn");
  readBtn.hidden = !isDirect;
  if (isDirect) readBtn.onclick = () => void readDirect(seriesId);

  // Library tracking (optional module): track this series under the bridge it came from.
  prefetchedChapter = null;
  preloadedUrls.clear();
  currentSeries = { bridgeId: activeBridge, seriesId, info, chapters, progress: new Map(), inLibrary: false };
  await refreshLibraryStatus();
  renderChapters();
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
const preloadedUrls = new Set<string>();

let toolbarHideTimer: ReturnType<typeof setTimeout> | null = null;
function showToolbar(): void {
  const tb = document.querySelector(".reader-toolbar") as HTMLElement | null;
  if (!tb) return;
  tb.classList.remove("hidden");
  if (toolbarHideTimer) clearTimeout(toolbarHideTimer);
  toolbarHideTimer = setTimeout(() => tb.classList.add("hidden"), 3000);
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
  const libBtn = $<HTMLButtonElement>("#lib-toggle");
  const newBadge = $("#new-badge");
  libBtn.hidden = false;
  newBadge.hidden = true;
  libBtn.onclick = () => void toggleLibrary();
  let detail: { entry: LibEntry; progress: ProgressItem[] } | undefined;
  try {
    detail = await api<{ entry: LibEntry; progress: ProgressItem[] }>(
      `/library/entries/${bridgeId}/${enc(seriesId)}`,
    );
    currentSeries.inLibrary = true;
    currentSeries.progress = new Map(detail.progress.map((p) => [p.chapterId, p]));
    libBtn.textContent = "✓ In Library";
    // Detect new chapters since the last visit.
    const sync = await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/sync`, { chapters: currentSeries.chapters });
    const added = (sync.data as { added?: Chapter[] }).added ?? [];
    if (added.length) { newBadge.hidden = false; newBadge.textContent = `${added.length} new`; }
  } catch {
    currentSeries.inLibrary = false;
    currentSeries.progress = new Map();
    libBtn.textContent = "＋ Library";
    $("#lib-category-picker").hidden = true;
    $("#group-panel").hidden = true;
    $("#tracker-panel").hidden = true;
    return;
  }
  // Render UI panels separately — failures here must not reset inLibrary.
  await renderCategoryPicker(detail.entry.categoryIds).catch(() => {});
  await renderGroupPanel(bridgeId, seriesId, detail.entry).catch(() => {});
  await renderTrackerPanel(bridgeId, seriesId).catch(() => {});
}

async function renderGroupPanel(bridgeId: string, seriesId: string, entry: LibEntry): Promise<void> {
  const panel = $("#group-panel");
  panel.hidden = true;
  panel.innerHTML = "";

  const [groups, allEntries] = await Promise.all([
    api<SeriesGroup[]>("/library/groups").catch(() => [] as SeriesGroup[]),
    api<LibEntryView[]>("/library").catch(() => [] as LibEntryView[]),
  ]);

  const groupId = entry.seriesGroupId;
  const currentKey = `${bridgeId}:${seriesId}`;

  function makeRow(label: string, isPrimary: boolean, actions: HTMLElement): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:0.25rem 0;";
    row.innerHTML = `<span style="font-size:0.85rem">${esc(label)}${isPrimary ? " <span class=\"ok\" style=\"font-size:0.7rem\">primary</span>" : ""}</span>`;
    row.append(actions);
    return row;
  }
  function makeBtn(text: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "secondary";
    b.style.cssText = "font-size:0.75rem;padding:0.15rem 0.5rem";
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  if (groupId) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    panel.hidden = false;
    const heading = document.createElement("div");
    heading.className = "muted";
    heading.style.cssText = "font-size:0.75rem;margin-bottom:0.35rem";
    heading.textContent = "Sources";
    panel.append(heading);
    for (const key of group.memberKeys) {
      const i = key.indexOf(":");
      const bid = key.slice(0, i);
      const sid = key.slice(i + 1);
      const isCurrent = key === currentKey;
      const isPrimary = key === group.primaryKey;
      const acts = document.createElement("span");
      acts.style.cssText = "display:flex;gap:0.4rem";
      if (!isCurrent) acts.append(makeBtn("Switch", () => void openSeries(bid, sid)));
      if (!isPrimary) acts.append(makeBtn("Set primary", async () => {
        await send("PUT", `/library/groups/${groupId}/primary`, { primaryKey: key });
        await refreshLibraryStatus();
      }));
      if (isCurrent) acts.append(makeBtn("Unlink", async () => {
        await send("DELETE", `/library/entries/${bridgeId}/${enc(seriesId)}/leave-group`);
        await refreshLibraryStatus();
      }));
      panel.append(makeRow(bid, isPrimary, acts));
    }
  } else {
    // Find other library entries with the same title from different bridges.
    const titleNorm = entry.title.trim().toLowerCase();
    const candidates = allEntries.filter((e) =>
      e.title.trim().toLowerCase() === titleNorm &&
      !(e.bridgeId === bridgeId && e.seriesId === seriesId),
    );
    if (candidates.length === 0) return;
    panel.hidden = false;
    const heading = document.createElement("div");
    heading.className = "muted";
    heading.style.cssText = "font-size:0.75rem;margin-bottom:0.35rem";
    heading.textContent = "Same title found in other sources — link them?";
    panel.append(heading);
    for (const c of candidates) {
      const candidateKey = `${c.bridgeId}:${c.seriesId}`;
      const acts = document.createElement("span");
      acts.style.cssText = "display:flex;gap:0.4rem";
      acts.append(makeBtn("Link", async () => {
        if (c.seriesGroupId) {
          await send("POST", `/library/entries/${bridgeId}/${enc(seriesId)}/join-group`, { groupId: c.seriesGroupId });
        } else {
          await send("POST", "/library/groups", { memberKeys: [currentKey, candidateKey], primaryKey: candidateKey });
        }
        await refreshLibraryStatus();
      }));
      panel.append(makeRow(c.bridgeId, false, acts));
    }
  }
}

// ── Tracker panel (per-series) ────────────────────────────────────────────────
let availableTrackers: TrackerSummary[] = [];

async function fetchTrackers(): Promise<TrackerSummary[]> {
  try { return await api<TrackerSummary[]>("/trackers"); }
  catch { return []; }
}

async function renderTrackerPanel(bridgeId: string, seriesId: string): Promise<void> {
  const panel = $("#tracker-panel");
  panel.hidden = true;
  panel.innerHTML = "";

  if (availableTrackers.length === 0) return;

  const prefs = await api<BridgePrefs>(`/library/bridges/${enc(bridgeId)}/prefs`).catch(
    () => ({ bridgeId, trackersDisabled: false }),
  );
  if (prefs.trackersDisabled) return;

  const links = await api<TrackerLink[]>(
    `/library/entries/${bridgeId}/${enc(seriesId)}/tracker-links`,
  ).catch(() => [] as TrackerLink[]);

  panel.hidden = false;

  const heading = document.createElement("div");
  heading.className = "muted";
  heading.style.cssText = "font-size:0.75rem;margin-bottom:0.35rem";
  heading.textContent = "Trackers";
  panel.append(heading);

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
}

function relativeTime(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
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


async function renderCategoryPicker(selectedIds: string[]): Promise<void> {
  const picker = $("#lib-category-picker");
  if (!currentSeries?.inLibrary) { picker.hidden = true; return; }
  const cats = await api<Category[]>("/library/categories");
  picker.hidden = false;
  picker.innerHTML = "";
  if (cats.length === 0) {
    picker.innerHTML = '<span class="muted">No categories yet — add some in the Library tab.</span>';
    return;
  }
  for (const cat of cats) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedIds.includes(cat.id);
    cb.dataset.id = cat.id;
    cb.onchange = async () => {
      const ids = Array.from(picker.querySelectorAll<HTMLInputElement>("input:checked")).map((i) => i.dataset.id!);
      await send("PUT", `/library/entries/${currentSeries!.bridgeId}/${enc(currentSeries!.seriesId)}/categories`, { categoryIds: ids });
    };
    label.append(cb, document.createTextNode(cat.name));
    picker.append(label);
  }
}

function renderChapters(): void {
  if (!currentSeries) return;
  const { chapters, progress, inLibrary } = currentSeries;
  const ul = $("#chapters");
  ul.innerHTML = "";
  for (const ch of chapters) {
    const li = document.createElement("li");
    const p = progress.get(ch.id);
    if (p?.read) li.classList.add("read");
    if (inLibrary) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!p?.read;
      cb.title = "Mark read";
      cb.onclick = (e) => { e.stopPropagation(); void markRead(ch.id, cb.checked, ch.name); };
      li.append(cb);
    }
    const name = document.createElement("span");
    name.className = "ch-name";
    name.textContent = ch.pageCount ? `${ch.name} · ${ch.pageCount}p` : ch.name;
    li.append(name);
    if (inLibrary) {
      const up = document.createElement("button");
      up.className = "ch-uptohere";
      up.textContent = "read to here";
      up.onclick = (e) => { e.stopPropagation(); void readUpTo(ch.id); };
      li.append(up);
    }
    li.onclick = () => void openChapter(ch);
    ul.append(li);
  }
}

async function openChapter(ch: Chapter, resumePage?: number): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, seriesId, inLibrary } = currentSeries;
  const alreadyInReader = currentView === "reader";
  switchView("reader");
  // Replace when already in the reader so chapter-to-chapter navigation doesn't
  // stack history entries — back should always return to the pre-reader view.
  const route = `#reader/${enc(bridgeId)}/${enc(seriesId)}/${enc(ch.id)}`;
  if (alreadyInReader) {
    history.replaceState(null, "", route);
  } else {
    pushRoute(`reader/${enc(bridgeId)}/${enc(seriesId)}/${enc(ch.id)}`);
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
  renderReaderPage();
  if (inLibrary) {
    await setProgress(ch, readerState.currentPage, pages.length);
  } else {
    const { info } = currentSeries;
    void send("POST", "/reading-history", {
      bridgeId, seriesId, title: info.title, thumbnailUrl: info.thumbnailUrl,
      chapterId: ch.id, chapterName: ch.name, lastReadAt: Date.now(),
    }).catch(() => {});
  }
}

async function readDirect(seriesId: string): Promise<void> {
  if (!currentSeries) return;
  const { bridgeId, info, inLibrary } = currentSeries;
  switchView("reader");
  pushRoute(`reader/${enc(bridgeId)}/${enc(seriesId)}/__direct__`);
  $("#reader-info").textContent = `${info.title} · Loading…`;
  $<HTMLButtonElement>("#reader-prev").disabled = true;
  $<HTMLButtonElement>("#reader-next").disabled = true;
  $("#reader-page").innerHTML = `<p class="muted" style="text-align:center;padding:2rem">Loading pages…</p>`;
  const pages = await api<Page[]>(`/bridges/${bridgeId}/series/${enc(seriesId)}/pages`);
  const syntheticChapter: Chapter = { id: "__direct__", name: info.title };
  readerState = { ch: syntheticChapter, pages, currentPage: 0 };
  renderReaderPage();
  if (inLibrary) {
    await setProgress(syntheticChapter, 0, pages.length);
  } else {
    void send("POST", "/reading-history", {
      bridgeId, seriesId, title: info.title, thumbnailUrl: info.thumbnailUrl,
      chapterId: "__direct__", chapterName: info.title, lastReadAt: Date.now(),
    }).catch(() => {});
  }
}

/** Next or previous chapter in reading order (ascending by chapter number). */
function getAdjacentChapter(delta: 1 | -1): Chapter | null {
  if (!currentSeries || !readerState) return null;
  const ordered = [...currentSeries.chapters].sort((a, b) => {
    if (a.number !== undefined && b.number !== undefined) return a.number - b.number;
    if (a.number !== undefined) return -1;
    if (b.number !== undefined) return 1;
    return 0;
  });
  const idx = ordered.findIndex((c) => c.id === readerState!.ch.id);
  if (idx === -1) return null;
  return ordered[idx + delta] ?? null;
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

function renderReaderPage(): void {
  if (!readerState) return;
  const { ch, pages, currentPage } = readerState;
  const p = pages[currentPage];
  if (!p) return;
  ($("#reader-view") as HTMLElement).scrollTop = 0;
  const onLastPage = currentPage >= pages.length - 1;
  const nextCh = onLastPage ? getAdjacentChapter(1) : null;
  $("#reader-info").textContent = `${ch.name} · ${currentPage + 1} / ${pages.length}`;
  $<HTMLButtonElement>("#reader-prev").disabled = currentPage === 0;
  $<HTMLButtonElement>("#reader-next").disabled = onLastPage && !nextCh;
  $<HTMLButtonElement>("#reader-next").textContent = onLastPage && nextCh ? "Next ch. ›" : "Next ›";
  $("#reader-page").innerHTML = `<img src="${p.imageUrl}" alt="Page ${currentPage + 1}" onerror="this.onerror=null;this.src='https://placehold.co/700x1000?text=Page+${currentPage + 1}'">`;
  showToolbar();
  preloadImages(pages.slice(Math.max(0, currentPage - 1), currentPage + 4).map(p => p.imageUrl));
  if (currentPage >= pages.length - 1 - 3) void prefetchNextChapter();
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
  readerState.currentPage = next;
  renderReaderPage();
  if (currentSeries?.inLibrary) await setProgress(readerState.ch, readerState.currentPage, readerState.pages.length);
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

async function doSearch(): Promise<void> {
  const q = $<HTMLInputElement>("#query").value;
  const filters = collectFilters();
  const sort = collectSort();
  await runSearch(q, filters, sort, 1);
}

function navigateToFilteredSearch(filters: FilterValue[]): void {
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
    if (!scoped) $("#list-tabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
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
let libActiveCategory: string | null = null;

async function loadLibrary(): Promise<void> {
  const [cats, groups] = await Promise.all([
    api<Category[]>("/library/categories"),
    api<SeriesGroup[]>("/library/groups").catch(() => [] as SeriesGroup[]),
  ]);
  renderCategoryChips(cats);
  renderCategoryManager(cats);
  const path = libActiveCategory ? `/library?category=${enc(libActiveCategory)}` : "/library";
  const entries = await api<LibEntryView[]>(path);
  const grid = $("#library-grid");
  grid.innerHTML = "";
  if (entries.length === 0) {
    grid.innerHTML = "<p class=\"muted\">Your library is empty. Open a series and tap \"＋ Library\".</p>";
    return;
  }

  // Build group map and track which entry keys are non-primary group members (to skip them).
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const hiddenKeys = new Set<string>();
  for (const g of groups) {
    for (const k of g.memberKeys) {
      if (k !== g.primaryKey) hiddenKeys.add(k);
    }
  }

  for (const e of entries) {
    const key = `${e.bridgeId}:${e.seriesId}`;
    if (hiddenKeys.has(key)) continue; // covered by primary card

    const group = e.seriesGroupId ? groupById.get(e.seriesGroupId) : undefined;
    const sourceCount = group ? group.memberKeys.length : 0;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      ${e.unreadCount > 0 ? `<span class="badge-unread">${e.unreadCount}</span>` : ""}
      ${sourceCount > 1 ? `<span class="badge-sources">${sourceCount} sources</span>` : ""}
      <img src="${e.thumbnailUrl ?? ""}" alt="${esc(e.title)}" loading="lazy"
        onerror="this.onerror=null;this.src='https://placehold.co/300x450?text='+encodeURIComponent(this.alt||'No Cover')">
      <div class="card-title">${esc(e.title)}</div>
      <div class="card-sub">${esc(e.bridgeId)}</div>`;
    if (cats.length > 0) {
      const catsRow = document.createElement("div");
      catsRow.className = "card-categories";
      const assigned = new Set(e.categoryIds);
      for (const cat of cats) {
        const chip = document.createElement("span");
        chip.className = "chip cat-chip" + (assigned.has(cat.id) ? " cat-chip-on" : "");
        chip.textContent = cat.name;
        chip.onclick = async (ev) => {
          ev.stopPropagation();
          if (assigned.has(cat.id)) assigned.delete(cat.id);
          else assigned.add(cat.id);
          chip.className = "chip cat-chip" + (assigned.has(cat.id) ? " cat-chip-on" : "");
          await send("PUT", `/library/entries/${e.bridgeId}/${enc(e.seriesId)}/categories`, { categoryIds: [...assigned] });
          if (libActiveCategory) void loadLibrary();
        };
        catsRow.append(chip);
      }
      card.append(catsRow);
    }
    card.onclick = () => void openSeries(e.bridgeId, e.seriesId);
    grid.append(card);
  }
}

function renderCategoryChips(cats: Category[]): void {
  const host = $("#lib-category-chips");
  host.innerHTML = "";
  const mk = (id: string | null, label: string) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (libActiveCategory === id ? " active" : "");
    tab.textContent = label;
    tab.onclick = () => { libActiveCategory = id; void loadLibrary(); };
    host.append(tab);
  };
  mk(null, "All");
  for (const c of cats) mk(c.id, c.name);
}

function renderCategoryManager(cats: Category[]): void {
  const host = $("#lib-category-manage");
  host.innerHTML = "";
  for (const c of cats) {
    const row = document.createElement("div");
    row.className = "reg-item";
    row.innerHTML = `<span>${esc(c.name)}</span>`;
    const actions = document.createElement("span");
    const rename = document.createElement("button");
    rename.className = "secondary";
    rename.textContent = "Rename";
    rename.onclick = async () => {
      const name = window.prompt("Rename category", c.name);
      if (name) { await send("PATCH", `/library/categories/${enc(c.id)}`, { name }); await loadLibrary(); }
    };
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (libActiveCategory === c.id) libActiveCategory = null;
      await send("DELETE", `/library/categories/${enc(c.id)}`);
      await loadLibrary();
    };
    actions.append(rename, del);
    row.append(actions);
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
    row.innerHTML = `
      <img src="${h.thumbnailUrl ?? ""}" alt="" onerror="this.style.visibility='hidden'">
      <div class="hi-body">
        <div class="hi-title">${esc(h.title)}</div>
        <div class="hi-sub">${h.lastReadChapterName ? esc(h.lastReadChapterName) + " · " : ""}${when}</div>
      </div>`;
    const resume = document.createElement("button");
    resume.textContent = "Resume";
    resume.onclick = () => void openSeries(h.bridgeId, h.seriesId, h.lastReadChapterId);
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

/** Open a series from anywhere (library/history), optionally jumping into a chapter to resume. */
async function openSeries(bridgeId: string, seriesId: string, resumeChapterId?: string): Promise<void> {
  await ensureBridge(bridgeId);
  await showDetail(seriesId);
  if (resumeChapterId && currentSeries) {
    const ch = currentSeries.chapters.find((c) => c.id === resumeChapterId);
    if (ch) {
      const lastPage = currentSeries.progress.get(resumeChapterId)?.lastPage;
      await openChapter(ch, lastPage);
    }
  }
}

function switchView(view: "browse" | "library" | "history" | "detail" | "reader" | "settings"): void {
  currentView = view;
  document.querySelectorAll<HTMLElement>(".bn-item").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view),
  );
  $("#browse-view").style.display = view === "browse" ? "" : "none";
  $("#library-view").style.display = view === "library" ? "" : "none";
  $("#history-view").style.display = view === "history" ? "" : "none";
  $("#detail-view").style.display = view === "detail" ? "" : "none";
  $("#reader-view").style.display = view === "reader" ? "" : "none";
  $("#settings-view").style.display = view === "settings" ? "" : "none";
  if (view === "browse" || view === "library" || view === "history" || view === "settings") pushRoute(view);
  if (view === "library") void loadLibrary().catch((e) => status(`Library unavailable: ${e instanceof Error ? e.message : e}`, true));
  if (view === "history") void loadHistory().catch((e) => status(`History unavailable: ${e instanceof Error ? e.message : e}`, true));
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
    t.onclick = () => switchView((t.dataset.view as "browse" | "library" | "history" | "settings") ?? "browse");
  });
  $("#back-btn").onclick = () => history.back();
  $("#reader-back").onclick = () => history.back();
  $("#reader-prev").onclick = () => void readerNavigate(-1);
  $("#reader-next").onclick = () => void readerNavigate(1);
  $("#reader-page").addEventListener("click", (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void readerNavigate(e.clientX < rect.left + rect.width / 2 ? -1 : 1);
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
  // Touch swipe navigation (mobile)
  let swipeStartX = 0, swipeStartY = 0;
  ($("#reader-view") as HTMLElement).addEventListener("touchstart", (e: TouchEvent) => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    showToolbar();
  }, { passive: true });
  ($("#reader-view") as HTMLElement).addEventListener("touchend", (e: TouchEvent) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      e.preventDefault();
      void readerNavigate(dx < 0 ? 1 : -1);
    }
  });
  $("#load-more").onclick = () => void loadMoreFn?.();
  $("#lib-add-category").onclick = async () => {
    const input = $<HTMLInputElement>("#lib-new-category");
    const name = input.value.trim();
    if (!name) return;
    await send("POST", "/library/categories", { name });
    input.value = "";
    await loadLibrary();
  };

  $<HTMLSelectElement>("#sort-field").addEventListener("change", updateSortDirVisibility);
  $("#searchBtn").onclick = () => void doSearch();
  $("#filters-toggle").onclick = () => {
    const panel = $("#meta-panel");
    const btn = $<HTMLButtonElement>("#filters-toggle");
    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    btn.textContent = open ? "Filters ✕" : "Filters";
  };
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

  try {
    availableTrackers = await fetchTrackers();
    await Promise.all([loadBridges(), loadRegistry(), loadTrackerConfig()]);
  } catch (e) {
    status(`Init failed: ${e instanceof Error ? e.message : e}`, true);
  }

  initialized = true;
  await handleRoute().catch(() => {});
})();
