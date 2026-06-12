import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Named step screenshots land here and are collected (alongside the video) by scripts/e2e-capture.ts.
// Playwright runs from the repo root, so cwd is stable.
const SHOTS = join(process.cwd(), "e2e", ".test-results", "shots");

test("browse → series detail → reader", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });

  // Home: the fixture-backed "example" bridge renders list sections of cards.
  await page.goto("/");
  const firstCard = page.locator("#home-sections .card").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(SHOTS, "01-home.png"), fullPage: true });

  // Open the first series → detail view.
  await firstCard.click();
  await expect(page.locator("#detail-view")).toBeVisible();
  const title = page.locator("#detail-title");
  await expect(title).not.toHaveText("");
  await expect(title).not.toHaveText("Loading…");
  await page.screenshot({ path: join(SHOTS, "02-detail.png"), fullPage: true });

  // Enter the reader. A "direct" series exposes a single ▶ Read button and no chapter list; every
  // other series lists chapters. Handle whichever this series is so the spec doesn't depend on which
  // fixture item happens to surface first.
  const readDirect = page.locator("#read-direct-btn");
  if (await readDirect.isVisible()) {
    await readDirect.click();
  } else {
    const firstChapter = page.locator("#chapters .ch-row").first();
    await expect(firstChapter).toBeVisible();
    await firstChapter.click();
  }
  await expect(page.locator("#reader-view")).toBeVisible();
  await expect(page.locator(".reader-slot img").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(SHOTS, "03-reader.png") });
});

// The comical-server API (the demo client talks to it on :3100). Used to seed a second source so the
// unified Sources UI has something to show — the fixture demo ships a single copy per series.
const SERVER = "http://localhost:3100";

test("library search, sort, filters and unified Sources popover", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });

  // Open a real series and add it to the library.
  await page.goto("/");
  const firstCard = page.locator("#home-sections .card").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await firstCard.click();
  await expect(page.locator("#detail-view")).toBeVisible();
  await expect(page.locator("#detail-title")).not.toHaveText("Loading…");
  const addBtn = page.locator("#lib-toggle");
  await expect(addBtn).toBeVisible();
  if ((await addBtn.textContent())?.includes("＋")) await addBtn.click();
  await expect(addBtn).toContainText("In Library");
  await page.screenshot({ path: join(SHOTS, "10-detail-added.png"), fullPage: true });

  // Seed a second same-title source on the other bridge and link them into a group, so the card badge
  // and the Sources popover have real members to render. Skip if it's already grouped (re-runs).
  const lib = (await (await page.request.get(`${SERVER}/library`)).json()) as Array<{
    bridgeId: string; seriesId: string; title: string; thumbnailUrl?: string; seriesGroupId?: string;
  }>;
  const r = lib[0]!;
  if (!r.seriesGroupId) {
    const rKey = `${r.bridgeId}:${r.seriesId}`;
    const sKey = "direct-example:sources-demo";
    await page.request.post(`${SERVER}/library/entries`, {
      data: { bridgeId: "direct-example", seriesId: "sources-demo", title: r.title, thumbnailUrl: r.thumbnailUrl },
    });
    await page.request.post(`${SERVER}/library/groups`, { data: { memberKeys: [rKey, sKey], primaryKey: rKey } });
  }

  // Library tab: the new search / sort / unread controls.
  await page.locator('.bn-item[data-view="library"]').click();
  await expect(page.locator("#library-view")).toBeVisible();
  await expect(page.locator("#lib-search")).toBeVisible();
  await expect(page.locator("#library-grid .card").first()).toBeVisible();
  // The "N sources" badge now appears on the grouped card — the live entry point.
  await expect(page.locator("#library-grid .badge-sources").first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "11-library-controls.png"), fullPage: true });

  // Search filters live as you type.
  await page.locator("#lib-search").fill(r.title.slice(0, 3));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, "12-library-search.png"), fullPage: true });
  await page.locator("#lib-search").fill("");
  await page.waitForTimeout(300);

  // Sort dropdown.
  await page.locator("#lib-sort").selectOption("title");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, "13-library-sort.png"), fullPage: true });

  // Click the "N sources" badge → the series opens with the Sources popover already open.
  await page.locator("#library-grid .badge-sources").first().click();
  await expect(page.locator("#detail-view")).toBeVisible();
  await expect(page.locator("#group-panel")).toBeVisible();
  await expect(page.locator("#group-panel .src-row").first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "14-sources-popover.png"), fullPage: true });
});
