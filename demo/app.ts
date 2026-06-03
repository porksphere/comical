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
interface TagGroup { label: string; kind?: string; tags: string[] }
interface SeriesInfo { id: string; title: string; thumbnailUrl?: string; author?: string; artist?: string; status?: string; description?: string; genres?: string[]; tagGroups?: TagGroup[]; languages?: string[] }
interface Chapter { id: string; name: string; number?: number }
interface Page { index: number; imageUrl: string }
interface PagedResults { items: SeriesEntry[]; page: number; hasNextPage: boolean }
interface SeriesList { id: string; name: string; layout?: string; featured?: boolean; searchable?: boolean }
interface Filter { type: "text" | "toggle" | "number" | "select" | "multiselect"; key: string; label: string; options?: Choice[]; min?: number; max?: number }
interface FilterValue { key: string; value: string | string[] | number | boolean }
interface SortOption { key: string; label: string }
interface Tag { id: string; label: string }
interface SavedRegistry { url: string; name: string }
interface AvailableBridge { entry: { id: string; name: string; version: string }; registryUrl: string; installedVersion: string | null; updateAvailable: boolean }

// ── DOM + API helpers ────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
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
let currentDescriptors: SettingDescriptor[] = [];
let currentFilters: Filter[] = [];
let currentLists: SeriesList[] = [];
let activeListId: string | null = null;

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

// ── Bridge picker ────────────────────────────────────────────────────────────────
async function loadBridges(): Promise<void> {
  const bridges = await api<BridgeSummary[]>("/bridges");
  const select = $<HTMLSelectElement>("#bridge");
  select.innerHTML = "";
  for (const b of bridges) {
    const opt = document.createElement("option");
    opt.value = b.info.id;
    opt.textContent = b.info.name + (b.availableVersion ? ` (update: ${b.availableVersion})` : "");
    select.append(opt);
  }
  select.onchange = () => void selectBridge(select.value);
  if (bridges.length > 0) {
    select.value = bridges[0]!.info.id;
    await selectBridge(bridges[0]!.info.id);
  } else {
    status("No bridges installed. Add a registry below, or build one locally.");
  }
}

// ── Select a bridge: load info, settings, meta, lists ────────────────────────────
async function selectBridge(id: string): Promise<void> {
  activeBridge = id;
  $("#detail").style.display = "none";
  const detail = await api<BridgeDetail>(`/bridges/${id}`);
  currentDescriptors = detail.settings;
  $("#caps").textContent = `[${detail.info.capabilities.join(", ")}]`;

  renderSettings(detail);
  await renderMeta(detail.info.capabilities);

  const canSearch = detail.info.capabilities.includes("search");
  $("#query").style.display = canSearch ? "" : "none";
  $("#searchBtn").style.display = canSearch ? "" : "none";

  // Content needs the bridge configured.
  if (detail.missingRequired.length > 0) {
    $("#list-tabs").innerHTML = "";
    $("#grid").innerHTML = "";
    status(`"${detail.info.name}" needs configuration: ${detail.missingRequired.join(", ")}`, true);
    $<HTMLDetailsElement>("#settings-details").open = true;
    return;
  }

  if (detail.info.capabilities.includes("lists")) await loadLists();
  else { $("#list-tabs").innerHTML = ""; $("#grid").innerHTML = ""; }
  status(`Loaded "${detail.info.name}".`);
}

// ── Settings form ────────────────────────────────────────────────────────────────
function renderSettings(detail: BridgeDetail): void {
  const panel = $("#settings-panel");
  const form = $("#settings-form");
  form.innerHTML = "";
  if (detail.settings.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";
  $("#settings-state").textContent = detail.missingRequired.length
    ? `— needs: ${detail.missingRequired.join(", ")}`
    : "— configured";
  $("#settings-state").className = detail.missingRequired.length ? "warn" : "ok";

  for (const d of detail.settings) {
    const wrap = document.createElement("div");
    if (d.type === "string" && d.secret) wrap.className = "field-secret";
    const label = document.createElement("label");
    label.textContent = d.label + (d.required ? " *" : "");
    if (d.description) label.title = d.description;
    label.append(buildInput(d, detail.values[d.key], detail.secretsSet.includes(d.key)));
    wrap.append(label);
    form.append(wrap);
  }
  $("#settings-msg").textContent = "";
}

/** Build a control prefilled with the current stored value (falling back to the descriptor default). */
function buildInput(
  d: SettingDescriptor,
  current: string | number | boolean | string[] | undefined,
  secretSet: boolean,
): HTMLElement {
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
  if (capabilities.includes("sort")) {
    try {
      const sorts = await api<SortOption[]>(`/bridges/${activeBridge}/sort`);
      const field = $<HTMLSelectElement>("#sort-field");
      field.innerHTML = "";
      field.append(new Option("— default —", ""));
      for (const s of sorts) field.append(new Option(s.label, s.key));
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
  panel.style.display = any ? "" : "none";
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

async function loadList(listId: string): Promise<void> {
  activeListId = listId;
  status(`Loading list "${listId}"…`);
  try {
    const r = await api<PagedResults>(`/bridges/${activeBridge}/lists/${encodeURIComponent(listId)}`);
    renderGrid(r.items);
    const searchable = currentLists.find((l) => l.id === listId)?.searchable;
    status(`${r.items.length} item(s) in "${listId}".${searchable ? " (search box scopes to this list)" : ""}`);
  } catch (e) {
    status(`List load failed: ${e instanceof Error ? e.message : e}`, true);
  }
}

function renderGrid(items: SeriesEntry[]): void {
  const grid = $("#grid");
  grid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img src="${item.thumbnailUrl ?? ""}" alt="${esc(item.title)}" loading="lazy"
        onerror="this.onerror=null;this.src='https://placehold.co/300x450?text='+encodeURIComponent(this.alt||'No Cover')">
      <div class="card-title">${esc(item.title)}</div>
      ${item.subtitle ? `<div class="card-sub">${esc(item.subtitle)}</div>` : ""}`;
    card.onclick = () => void showDetail(item.id);
    grid.append(card);
  }
}

async function showDetail(seriesId: string): Promise<void> {
  const detail = $("#detail");
  detail.style.display = "block";
  $("#detail-title").textContent = "Loading…";
  $("#detail-meta").textContent = "";
  $("#detail-genres").innerHTML = "";
  $("#detail-taggroups").innerHTML = "";
  $("#detail-description").textContent = "";
  ($("#detail-cover") as HTMLImageElement).style.display = "none";
  $("#chapters").innerHTML = "";
  $("#pages").innerHTML = "";

  const [info, chapters] = await Promise.all([
    api<SeriesInfo>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}`),
    api<Chapter[]>(`/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}/chapters`),
  ]);

  $("#detail-title").textContent = info.title;
  const creator = info.author || info.artist;
  $("#detail-meta").textContent = [
    creator && `by ${creator}`,
    info.status,
    info.languages?.length ? info.languages.join(" / ") : undefined,
  ].filter(Boolean).join(" · ");

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
  $("#detail-genres").innerHTML = (info.genres ?? []).map((g) => `<span class="chip">${esc(g)}</span>`).join("");
  $("#detail-taggroups").innerHTML = (info.tagGroups ?? [])
    .map(
      (grp) =>
        `<div class="tag-group"><span class="tag-group-label">${esc(grp.label)}</span>` +
        grp.tags.map((t) => `<span class="chip tag">${esc(t)}</span>`).join("") +
        `</div>`,
    )
    .join("");
  $("#detail-description").textContent = info.description ?? "";

  const ul = $("#chapters");
  for (const ch of chapters) {
    const li = document.createElement("li");
    li.textContent = ch.name;
    li.onclick = async () => {
      const pagesEl = $("#pages");
      pagesEl.innerHTML = "<p>Loading pages…</p>";
      const pages = await api<Page[]>(
        `/bridges/${activeBridge}/series/${encodeURIComponent(seriesId)}/chapters/${encodeURIComponent(ch.id)}/pages`,
      );
      pagesEl.innerHTML = pages
        .map(
          (p) =>
            `<img src="${p.imageUrl}" loading="lazy"` +
            ` onerror="this.onerror=null;this.src='https://placehold.co/700x1000?text=Page+${p.index + 1}'">`,
        )
        .join("");
    };
    ul.append(li);
  }
}

async function doSearch(): Promise<void> {
  const q = $<HTMLInputElement>("#query").value;
  const filters = collectFilters();
  const sort = collectSort();

  // If the active list is searchable, scope the query to it (getListItems); else global search.
  const activeList = currentLists.find((l) => l.id === activeListId);
  const scoped = activeList?.searchable ? activeList : undefined;

  const qs = [`q=${encodeURIComponent(q)}`];
  if (filters.length) qs.push(`filters=${encodeURIComponent(JSON.stringify(filters))}`);
  if (sort) qs.push(`sort=${encodeURIComponent(sort.key)}&dir=${sort.ascending ? "asc" : "desc"}`);

  status(scoped ? `Searching in "${scoped.name}"…` : "Searching…");
  try {
    const path = scoped
      ? `/bridges/${activeBridge}/lists/${encodeURIComponent(scoped.id)}?${qs.join("&")}`
      : `/bridges/${activeBridge}/search?${qs.join("&")}`;
    const r = await api<PagedResults>(path);
    if (!scoped) $("#list-tabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    renderGrid(r.items);
    const where = scoped ? ` in "${scoped.name}"` : "";
    const notes = [filters.length ? `${filters.length} filter(s)` : "", sort ? `sort:${sort.key}` : ""].filter(Boolean).join(", ");
    status(`${r.items.length} result(s) for "${q}"${where}${notes ? ` (${notes})` : ""}.`);
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

  $("#settings-save").onclick = () => void saveSettings();
  $("#searchBtn").onclick = () => void doSearch();
  $<HTMLInputElement>("#query").addEventListener("keydown", (e) => { if (e.key === "Enter") void doSearch(); });
  $("#reg-add").onclick = async () => {
    const url = $<HTMLInputElement>("#reg-url").value.trim();
    if (!url) return;
    const res = await send("POST", "/registries", { url });
    const msg = $("#reg-msg");
    if (res.ok) { msg.textContent = "Added ✓"; msg.className = "ok"; $<HTMLInputElement>("#reg-url").value = ""; await refreshAll(); }
    else { const e = res.data as { error?: string }; msg.textContent = e.error ?? `error ${res.status}`; msg.className = "err"; }
  };

  try {
    await loadBridges();
    await loadRegistry();
  } catch (e) {
    status(`Init failed: ${e instanceof Error ? e.message : e}`, true);
  }
})();
