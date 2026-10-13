import { expect, test } from "@playwright/test";

test.describe("Simple signal screen", () => {
  test("auto-scans and stays on WAIT with sample data", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Signal Desk" })).toBeVisible();
    await expect(page.getByText(/Live data band hai/)).toBeVisible();
    // The scan runs by itself — no button press needed
    await expect(page.getByText(/Price .* candle/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("verdict")).toHaveText(/WAIT/);
    await expect(page.getByText(/Agla check \d+s mein|Check ho raha hai/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  // Regression: the old Generate button forced UP/DOWN even when the rules said NO TRADE
  // (≈49 % on real history). "Check now" runs the same rules and never forces a direction.
  test("check-now button runs the rules and never forces a direction", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Price .* candle/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/v2 Fade \(tested\)/)).toBeVisible();
    await page.getByRole("button", { name: /Abhi check karein/ }).click();
    await expect(page.getByTestId("verdict")).toHaveText(/WAIT/);
    await expect(page.getByTestId("generated")).toHaveCount(0);
  });

  test("tabs: results, backtest, more", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Results", exact: true }).click();
    await expect(page.getByText(/Abhi koi BUY\/SELL signal nahin aaya/)).toBeVisible();
    await page.getByRole("button", { name: "Backtest", exact: true }).click();
    await page.getByRole("button", { name: /backtest chalayein/ }).click();
    await expect(page.getByText(/sample \(nakli\) data hai/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Jeet ki sharah")).toBeVisible();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("link", { name: /Pro view/ })).toBeVisible();
  });

  test("no horizontal overflow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("verdict")).toBeVisible();
    const [sw, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(sw).toBeLessThanOrEqual(vw);
  });
});

test.describe("Pro view", () => {
  test("safe defaults with no live provider configured", async ({ page }) => {
    await page.goto("/pro");
    await expect(page.getByText("Live data unavailable — no live signals will be generated.")).toBeVisible();
    await expect(page.getByTestId("verdict")).toHaveText("NO TRADE");
    await page.getByRole("button", { name: "Analyse now" }).click();
    await expect(page.getByText("Sample data — not a signal")).toBeVisible();
    await page.getByRole("tab", { name: "Sources" }).click();
    await expect(page.getByRole("tabpanel").getByText("TWELVEDATA_API_KEY is not set")).toBeVisible();
  });
});

test("manifest is served for PWA install", async ({ request }) => {
  const r = await request.get("/manifest.webmanifest");
  expect(r.ok()).toBe(true);
  const m = await r.json();
  expect(m.display).toBe("standalone");
});
