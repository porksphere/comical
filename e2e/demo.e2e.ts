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
