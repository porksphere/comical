/**
 * Reusable **live bridge audit** — the harness a registry repo runs on a schedule to check every
 * bridge it publishes against the real backend, then commit the result back as a status table.
 *
 * `evaluateBridge` grades one bridge; this grades a *repo of them* and renders the two documents a
 * registry repo keeps: a compact summary table (spliced into a README between markers) and a
 * per-check detail document. It also owns the policy that makes such a run usable in CI — a bridge
 * whose site blocks datacenter IPs must not redden the run forever (see `flaky`).
 *
 * Deliberately free of `node:*` and of any host adapter, like the rest of `@comical/testkit`: the
 * caller supplies `readBundle` (filesystem, HTTP, wherever the bundles live) and `createCapabilities`
 * (whichever host adapter it runs on), and gets markdown back. Writing files is the caller's job.
 *
 *   const result = await runBridgeAudit({
 *     bridges: { "my-bridge": { searchQuery: "spy" } },
 *     readBundle: (id) => readFileSync(`.build/${id}/dist/bridge.js`, "utf8"),
 *     createCapabilities: (id, settings) => createBunHost({ bridgeId: id, settings }),
 *     fetchAsset: defaultAssetFetcher,
 *   });
 *   writeFileSync("README.md", applyStatusBlock(readFileSync("README.md", "utf8"), result.summaryMarkdown));
 *   writeFileSync("AUDIT.md", result.detailsMarkdown);
 *   process.exit(result.hardFailures.length > 0 ? 1 : 0);
 */
import type { HostCapabilities } from "@comical/contract";
import { loadBridge } from "@comical/core";
import type { AssetFetcher } from "./asset-metrics.ts";
import { evaluateBridge, type EvaluationReport } from "./conformance.ts";

/**
 * Per-bridge audit policy, keyed by bridge id. Deliberately **outside** the bridge contract — this is
 * test/ops configuration about how a bridge is probed, not part of its runtime shape.
 */
export interface BridgeAuditConfig {
  /** A query expected to return ≥1 result live. */
  searchQuery?: string;
  /** Extra host settings for the live run (e.g. enabling adult content so an NSFW bridge returns results). */
  settings?: Record<string, string>;
  /**
   * Non-empty ⇒ tolerate this bridge's live failures: it shows ⚠ instead of ✗ and never fails the
   * run. For sites that Cloudflare-wall or rate-limit datacenter (CI runner) IPs even though they
   * work fine from a phone. The string is the human-readable reason, surfaced in both documents.
   * (Transient/blocked *throws* are already downgraded inside `evaluateBridge` — see
   * `isTransientError`; this covers a bridge whose checks legitimately can't pass from CI at all.)
   */
  flaky?: string;
}

/** One bridge's row in the summary table. */
export interface AuditRow {
  id: string;
  icon: "✓" | "⚠" | "✗";
  pass: number;
  warn: number;
  fail: number;
  /** Inconclusive/not-applicable probes (auth-gated, unobservable sort/filter). */
  skip: number;
  /** Capabilities exercised over declared, e.g. "6/7". */
  caps: string;
  /** Rendered cover metric, e.g. "80 KB (360×540)", or "—" when nothing was sampled. */
  cover: string;
  note: string;
  /** A real failure on a NON-flaky bridge — the only thing that fails the whole run. */
  hardFail: boolean;
}

/** A row plus the raw report. `loadError` is set instead of `report` when the bundle wouldn't load. */
export interface AuditEntry {
  row: AuditRow;
  report?: EvaluationReport;
  loadError?: string;
}

export interface BridgeAuditOptions {
  /** The bridges to audit, keyed by id (the key is also what's passed to `readBundle`). */
  bridges: Record<string, BridgeAuditConfig>;
  /** Return the built CJS bundle source for a bridge id. Throwing records a load failure for that row. */
  readBundle: (id: string) => string | Promise<string>;
  /** Build the host capabilities one audit run evaluates against. */
  createCapabilities: (id: string, settings: Record<string, string>) => HostCapabilities;
  /** Passed through to `evaluateBridge` for cover metrics. Omit to skip metrics (the `cover` cell reads "—"). */
  fetchAsset?: AssetFetcher;
  /** Called before each bridge is audited — for progress output on a long live run. */
  onProgress?: (id: string) => void;
  /**
   * Trailing provenance line appended to both documents, e.g.
   * ``_Updated 2026-07-27 by the nightly live audit ([`audit.ts`](audit.ts))._``
   * Defaults to a plain dated line. Kept configurable because the link is repo-relative.
   */
  stamp?: string;
}

export interface BridgeAuditResult {
  entries: AuditEntry[];
  rows: AuditRow[];
  /** Ids that failed for real on a non-flaky bridge. Non-empty ⇒ the run should exit non-zero. */
  hardFailures: string[];
  /** The summary table, for splicing into a README with `applyStatusBlock`. */
  summaryMarkdown: string;
  /** The standalone per-check detail document (every probe for every bridge). */
  detailsMarkdown: string;
}

/** Marker delimiting the status block inside a README. */
export const BRIDGE_STATUS_START = "<!-- BRIDGE-STATUS:START -->";
/** Marker delimiting the status block inside a README. */
export const BRIDGE_STATUS_END = "<!-- BRIDGE-STATUS:END -->";

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

const defaultStamp = (): string => `_Updated ${new Date().toISOString().slice(0, 10)} by the live bridge audit._`;

const coverCell = (report: EvaluationReport): string => {
  const m = report.metrics;
  if (!m || m.sampled === 0) return "—";
  const dim = m.dimensions ? ` (${m.dimensions.avgWidth}×${m.dimensions.avgHeight})` : "";
  return `${kb(m.bytes.avg)}${dim}`;
};

/** Render the `(P✓ W⚠ F✗ S⊘)` tally, dropping the ⊘ term when nothing was skipped. */
const tally = (r: Pick<AuditRow, "pass" | "warn" | "fail" | "skip">): string =>
  `${r.pass}✓ ${r.warn}⚠ ${r.fail}✗${r.skip ? ` ${r.skip}⊘` : ""}`;

const SEV_ICON = { pass: "✓", warn: "⚠", fail: "✗", skip: "⊘" } as const;
const SEV_RANK = { fail: 0, warn: 1, skip: 2, pass: 3 } as const;

/** Make a string safe inside a markdown table cell: escape pipes, flatten newlines. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

async function auditOne(
  id: string,
  cfg: BridgeAuditConfig,
  opts: BridgeAuditOptions,
): Promise<AuditEntry> {
  let report: EvaluationReport;
  try {
    const code = await opts.readBundle(id);
    const capabilities = opts.createCapabilities(id, cfg.settings ?? {});
    // No `expectedId`: a published bundle carries its publisher-namespaced id (e.g. "acme.my-bridge")
    // while the audit keys off the build directory name, so we load whatever id the bundle declares.
    const bridge = await loadBridge({ code, capabilities });
    report = await evaluateBridge(bridge, {
      searchQuery: cfg.searchQuery ?? "",
      ...(opts.fetchAsset ? { fetchAsset: opts.fetchAsset } : {}),
    });
  } catch (e) {
    // A read/load/setup failure (missing build, bad bundle) — real unless the bridge is tagged flaky.
    const message = e instanceof Error ? e.message : String(e);
    return {
      row: {
        id,
        icon: cfg.flaky ? "⚠" : "✗",
        pass: 0,
        warn: 0,
        fail: cfg.flaky ? 0 : 1,
        skip: 0,
        caps: "0/0",
        cover: "—",
        note: `load failed: ${message}`,
        hardFail: !cfg.flaky,
      },
      loadError: message,
    };
  }

  const { pass, warn, fail, skip } = report.summary;
  const realFailUntolerated = fail > 0 && !cfg.flaky;
  const icon: AuditRow["icon"] = realFailUntolerated ? "✗" : fail > 0 || warn > 0 ? "⚠" : "✓";
  return {
    row: {
      id,
      icon,
      pass,
      warn,
      fail,
      skip,
      caps: `${report.summary.capabilitiesExercised.length}/${report.summary.capabilitiesDeclared.length}`,
      cover: coverCell(report),
      note: cfg.flaky && fail > 0 ? `flaky (tolerated): ${cfg.flaky}` : (cfg.flaky ?? ""),
      hardFail: realFailUntolerated,
    },
    report,
  };
}

/** The compact summary table that goes inside a README's BRIDGE-STATUS markers. */
function renderSummary(rows: AuditRow[], stamp: string): string {
  const head = "| Bridge | Status | Capabilities | Avg cover | Notes |\n|---|---|---|---|---|";
  const body = rows
    .map((r) => `| \`${r.id}\` | ${r.icon} (${tally(r)}) | ${r.caps} | ${r.cover} | ${r.note || "—"} |`)
    .join("\n");
  return `${head}\n${body}\n\n${stamp}`;
}

/** Per-bridge metrics detail line (byte spread + dimensions + aspect). */
function metricsLine(report: EvaluationReport): string {
  const m = report.metrics;
  if (!m) return "";
  const parts = [
    `sampled ${m.sampled}`,
    `failed ${m.failed}`,
    `bytes min ${kb(m.bytes.min)} / avg ${kb(m.bytes.avg)} / median ${kb(m.bytes.median)} / max ${kb(m.bytes.max)}`,
  ];
  if (m.dimensions) {
    parts.push(
      `dims avg ${m.dimensions.avgWidth}×${m.dimensions.avgHeight} ` +
        `(max ${m.dimensions.maxWidth}×${m.dimensions.maxHeight})`,
    );
  }
  if (m.aspect) parts.push(`aspect avg ${m.aspect.avg.toFixed(2)}`);
  return parts.join(" · ");
}

/** The standalone detail document — every check for every bridge, failures/warnings first. */
function renderDetails(entries: AuditEntry[], stamp: string): string {
  const lines: string[] = [
    "# Bridge audit — detailed results",
    "",
    "Per-check results from the live bridge audit — every conformance probe run against the real",
    "backend. ✓ pass · ⚠ warn · ✗ fail · ⊘ skipped (auth-gated with no credentials, or an inconclusive",
    "sort/filter probe — never a defect). Warnings never fail the run; a tolerated flaky/blocked bridge",
    "shows ⚠ even for a hard failure.",
    "",
  ];
  for (const { row, report, loadError } of entries) {
    lines.push(`## \`${row.id}\` — ${row.icon} (${tally(row)})`, "");
    if (loadError) {
      lines.push(`**Bridge failed to load:** ${cell(loadError)}`, "");
      continue;
    }
    if (!report) continue;
    const meta = [`**${row.caps} capabilities**`, `cover ${row.cover}`];
    const ml = metricsLine(report);
    if (ml) meta.push(ml);
    lines.push(meta.join(" · "), "");
    if (row.note) lines.push(`> ${cell(row.note)}`, "");
    const sorted = [...report.results].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    lines.push("| Result | Check | Capability | Detail |", "|:--:|---|---|---|");
    for (const c of sorted) {
      lines.push(`| ${SEV_ICON[c.severity]} | \`${cell(c.id)}\` | ${c.capability} | ${cell(c.message)} |`);
    }
    lines.push("");
  }
  lines.push(stamp);
  return `${lines.join("\n")}\n`;
}

/**
 * Audit every configured bridge against its live backend and render both documents.
 *
 * Never throws on a bridge defect — a broken or unreachable bridge becomes a row with `hardFail` set
 * (or tolerated, when `flaky`). Only a harness/config bug throws. Bridges are audited **sequentially**
 * so a run doesn't hammer several backends at once and get itself rate-limited.
 */
export async function runBridgeAudit(opts: BridgeAuditOptions): Promise<BridgeAuditResult> {
  const stamp = opts.stamp ?? defaultStamp();
  const entries: AuditEntry[] = [];
  for (const [id, cfg] of Object.entries(opts.bridges)) {
    opts.onProgress?.(id);
    entries.push(await auditOne(id, cfg, opts));
  }
  const rows = entries.map((e) => e.row);
  return {
    entries,
    rows,
    hardFailures: rows.filter((r) => r.hardFail).map((r) => r.id),
    summaryMarkdown: renderSummary(rows, stamp),
    detailsMarkdown: renderDetails(entries, stamp),
  };
}

/**
 * Splice a rendered status table into `readme` between the `BRIDGE-STATUS` markers, returning the new
 * document. Pure — the caller reads and writes the file. Throws when either marker is missing, since
 * silently returning the input would let a scheduled audit report success while updating nothing.
 */
export function applyStatusBlock(readme: string, table: string): string {
  const s = readme.indexOf(BRIDGE_STATUS_START);
  const e = readme.indexOf(BRIDGE_STATUS_END);
  if (s < 0 || e < 0) throw new Error(`README is missing ${BRIDGE_STATUS_START} / ${BRIDGE_STATUS_END} markers`);
  if (e < s) throw new Error(`${BRIDGE_STATUS_END} appears before ${BRIDGE_STATUS_START}`);
  return `${readme.slice(0, s + BRIDGE_STATUS_START.length)}\n${table}\n${readme.slice(e)}`;
}
