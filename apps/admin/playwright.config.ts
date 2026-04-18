import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for admin-portal E2E tests.
 * Scaffolded 2026-04-14 as part of the P1.7 testing floor. Tests live under `e2e/`.
 *
 * To run locally:
 *   1. Ensure `npm run dev` is running on http://localhost:3001 (admin dev port), OR
 *      let Playwright boot it via the `webServer` config below.
 *   2. Set `PLAYWRIGHT_BASE_URL` to override the target URL.
 *   3. `npx playwright install` once, then `npx playwright test`.
 *
 * CI: add a workflow job that runs `npm run dev` against a test backend +
 * `npx playwright test --reporter=github`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.CI
    ? {
        command: 'npm run dev',
        url: 'http://localhost:3001',
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
