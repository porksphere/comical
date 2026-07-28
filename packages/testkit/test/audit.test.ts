/**
 * `runBridgeAudit` — the repo-wide live audit harness. These drive it against the example bridge and
 * an in-process fixture backend (no network), which is enough to pin the parts that actually decide
 * a scheduled run's outcome: the flaky tolerance policy, load-failure rows, and the two rendered
 * documents. `applyStatusBlock` is covered separately as pure string surgery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { HostCapabilities } from "@comical/contract";
import {
  BRIDGE_STATUS_END,
  BRIDGE_STATUS_START,
  FixtureBackend,
  applyStatusBlock,
  fixtureHost,
  runBridgeAudit,
} from "../src/index.ts";

const BUNDLE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "bridges", "example-bridge", "dist", "bridge.js"),
  "utf8",
);

/** Wire every audited bridge to its own fixture backend, so the run needs no network. */
const createCapabilities = (_id: string, settings: Record<string, string>): HostCapabilities =>
  fixtureHost(new FixtureBackend(), settings);

const readBundle = (): string => BUNDLE;

describe("runBridgeAudit", () => {
  test("audits a working bridge and renders both documents", async () => {
    const result = await runBridgeAudit({
      bridges: { example: { searchQuery: "a" } },
      readBundle,
      createCapabilities,
      stamp: "_stamped_",
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.id).toBe("example");
    expect(row.hardFail).toBe(false);
    expect(row.pass).toBeGreaterThan(0);
    expect(result.hardFailures).toEqual([]);
    expect(result.entries[0]!.report).toBeDefined();

    // Summary: a markdown table row for the bridge, plus the caller's stamp.
    expect(result.summaryMarkdown).toContain("| `example` |");
    expect(result.summaryMarkdown).toContain("_stamped_");
    // Details: a per-bridge section and a check table.
    expect(result.detailsMarkdown).toContain("## `example`");
    expect(result.detailsMarkdown).toContain("| Result | Check | Capability | Detail |");
    expect(result.detailsMarkdown).toContain("_stamped_");
  });

  test("no fetchAsset ⇒ no cover metrics, and the cover cell reads as absent", async () => {
    const result = await runBridgeAudit({
      bridges: { example: { searchQuery: "a" } },
      readBundle,
      createCapabilities,
    });
    expect(result.entries[0]!.report?.metrics).toBeUndefined();
    expect(result.rows[0]!.cover).toBe("—");
  });

  test("a bundle that will not load is a hard failure, not a throw", async () => {
    const result = await runBridgeAudit({
      bridges: { broken: {} },
      readBundle: () => {
        throw new Error("ENOENT: no such file");
      },
      createCapabilities,
    });

    const row = result.rows[0]!;
    expect(row.icon).toBe("✗");
    expect(row.hardFail).toBe(true);
    expect(row.fail).toBe(1);
    expect(row.note).toContain("load failed: ENOENT");
    expect(result.hardFailures).toEqual(["broken"]);
    expect(result.entries[0]!.loadError).toContain("ENOENT");
    expect(result.detailsMarkdown).toContain("**Bridge failed to load:**");
  });

  test("`flaky` downgrades a load failure to a warning and keeps the run green", async () => {
    const result = await runBridgeAudit({
      bridges: { blocked: { flaky: "Cloudflare walls datacenter IPs" } },
      readBundle: () => {
        throw new Error("ENOENT: no such file");
      },
      createCapabilities,
    });

    const row = result.rows[0]!;
    expect(row.icon).toBe("⚠");
    expect(row.hardFail).toBe(false);
    expect(row.fail).toBe(0);
    // The whole point: a known-blocked bridge never fails the scheduled run.
    expect(result.hardFailures).toEqual([]);
  });

  test("the flaky reason is carried into the summary for a bridge that passed", async () => {
    const result = await runBridgeAudit({
      bridges: { example: { searchQuery: "a", flaky: "IP-gated from datacenters" } },
      readBundle,
      createCapabilities,
      stamp: "_stamped_",
    });
    expect(result.rows[0]!.note).toBe("IP-gated from datacenters");
    expect(result.summaryMarkdown).toContain("IP-gated from datacenters");
  });

  // Three full evaluations run back-to-back (sequential by design, so a live run doesn't hammer
  // several backends at once) — well past the default 5s budget even against fixtures.
  test("audits every configured bridge, in configuration order", async () => {
    const seen: string[] = [];
    const result = await runBridgeAudit({
      bridges: { one: { searchQuery: "a" }, two: { searchQuery: "a" }, three: { searchQuery: "a" } },
      readBundle,
      createCapabilities,
      onProgress: (id) => seen.push(id),
    });
    expect(seen).toEqual(["one", "two", "three"]);
    expect(result.rows.map((r) => r.id)).toEqual(["one", "two", "three"]);
  }, 30_000);

  test("an empty config produces an empty, still-renderable report", async () => {
    const result = await runBridgeAudit({ bridges: {}, readBundle, createCapabilities });
    expect(result.rows).toEqual([]);
    expect(result.hardFailures).toEqual([]);
    expect(result.summaryMarkdown).toContain("| Bridge | Status |");
    expect(result.detailsMarkdown).toContain("# Bridge audit — detailed results");
  });
});

describe("applyStatusBlock", () => {
  const readme = `# Repo\n\n${BRIDGE_STATUS_START}\nold content\n${BRIDGE_STATUS_END}\n\n## After\n`;

  test("replaces only the content between the markers", () => {
    const out = applyStatusBlock(readme, "NEW TABLE");
    expect(out).toBe(`# Repo\n\n${BRIDGE_STATUS_START}\nNEW TABLE\n${BRIDGE_STATUS_END}\n\n## After\n`);
    expect(out).not.toContain("old content");
    expect(out).toContain("## After");
  });

  test("is idempotent across repeated runs", () => {
    expect(applyStatusBlock(applyStatusBlock(readme, "T"), "T")).toBe(applyStatusBlock(readme, "T"));
  });

  test("throws when a marker is missing, rather than silently updating nothing", () => {
    expect(() => applyStatusBlock("# Repo\n\nno markers here\n", "T")).toThrow(/missing/);
    expect(() => applyStatusBlock(`# Repo\n${BRIDGE_STATUS_START}\n`, "T")).toThrow(/missing/);
  });

  test("throws when the markers are inverted", () => {
    expect(() => applyStatusBlock(`${BRIDGE_STATUS_END}\nx\n${BRIDGE_STATUS_START}\n`, "T")).toThrow(
      /appears before/,
    );
  });
});
