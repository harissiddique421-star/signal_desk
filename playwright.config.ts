import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke test against a production build.
 * `PW_CHROMIUM_PATH` lets you point at an existing Chromium when Playwright's
 * own browser download is unavailable; otherwise run `npx playwright install chromium`.
 */
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const extraArgs = process.env.PW_CHROMIUM_ARGS ? process.env.PW_CHROMIUM_ARGS.split(" ") : [];

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3200",
    launchOptions: { executablePath, args: extraArgs },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath, args: extraArgs } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, launchOptions: { executablePath, args: extraArgs } } },
  ],
  webServer: {
    command: "npx next start -p 3200",
    url: "http://localhost:3200/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { TWELVEDATA_API_KEY: "", ENABLE_SAMPLE_PROVIDER: "true", NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
  },
});
