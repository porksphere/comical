/**
 * Unit tests for the structured evaluator. `evaluateBridge` takes a plain `Bridge`, so these use
 * hand-built bridges (no bundle) to cover the pass path, the hard-fail gate, and warnings.
 */
import { describe, expect, test } from "bun:test";
import type { Bridge, BridgeInfo } from "@comical/contract";
import { evaluateBridge, runConformance } from "../src/conformance.ts";

const INFO = (capabilities: BridgeInfo["capabilities"]): BridgeInfo => ({
  id: "t",
  name: "T",
  version: "0.0.0",
  contractVersion: "1.0.0",
  languages: ["en"],
  nsfw: false,
  capabilities,
});

/** A clean search bridge with a complete read path. Override any method/info to degrade it. */
function bridge(over: Partial<Bridge> = {}): Bridge {
  return {
    info: INFO(["search"]),
    getSearchResults: async (_q, page) => ({
      items: [{ id: "a", title: "Alpha", thumbnailUrl: "https://x/a.png" }],
      page,
      hasNextPage: false,
    }),
    getSeriesDetails: async (id) => ({
      id,
      title: "Alpha",
      author: "Author",
      description: "desc",
      tagGroups: [{ kind: "genre", label: "Genres", tags: ["g"] }],
      status: "completed",
    }),
    getChapters: async () => [{ id: "c1", name: "Chapter 1", number: 1 }],
    getChapterPages: async () => [{ index: 0, imageUrl: "https://x/0.png" }],
    ...over,
  } as Bridge;
}

describe("evaluateBridge", () => {
  test("clean bridge → verdict pass, search exercised, read path checked", async () => {
    const r = await evaluateBridge(bridge());
    expect(r.summary.verdict).toBe("pass");
    expect(r.summary.fail).toBe(0);
    expect(r.summary.capabilitiesExercised).toContain("search");
    expect(r.results.find((x) => x.id === "read.detailsRoundTrip")?.severity).toBe("pass");
  });

  test("declares a capability but doesn't implement it → fail", async () => {
    const r = await evaluateBridge(bridge({ info: INFO(["search", "filters"]) }));
    expect(r.summary.verdict).toBe("fail");
    expect(r.results.find((x) => x.id === "capability.filters")?.severity).toBe("fail");
  });

  test("declares filters but getFilters returns none → fail", async () => {
    const r = await evaluateBridge(
      bridge({ info: INFO(["search", "filters"]), getFilters: async () => [] }),
    );
    expect(r.summary.verdict).toBe("fail");
    expect(r.results.find((x) => x.id === "filters.nonEmpty")?.severity).toBe("fail");
    expect(r.summary.capabilitiesPassing).not.toContain("filters");
  });

  test("missing optional metadata → warn (not fail)", async () => {
    const r = await evaluateBridge(
      bridge({
        getSeriesDetails: async (id) => ({ id, title: "Alpha", status: "completed" }),
      }),
    );
    expect(r.summary.verdict).toBe("pass");
    expect(r.summary.warn).toBeGreaterThan(0);
    expect(r.results.find((x) => x.id === "read.details.author")?.severity).toBe("warn");
  });

  test("id round-trip mismatch → fail", async () => {
    const r = await evaluateBridge(
      bridge({ getSeriesDetails: async () => ({ id: "WRONG", title: "Alpha", status: "completed" }) }),
    );
    expect(r.results.find((x) => x.id === "read.detailsRoundTrip")?.severity).toBe("fail");
    expect(r.summary.verdict).toBe("fail");
  });

  test("runConformance throws on a failing bridge, resolves on a clean one", async () => {
    await expect(runConformance(bridge({ info: INFO(["search", "filters"]) }))).rejects.toThrow();
    const ok = await runConformance(bridge());
    expect(ok.checks.length).toBeGreaterThan(0);
  });
});
