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
 * Auth setup (batch 42):
 *   - The `setup` project runs `auth.setup.ts` once, logs in as the
 *     seeded `playwright-admin` (role=ADMIN, no MFA), and writes
 *     `playwright/.auth/admin.json` storage state.
 *   - The `chromium` project depends on `setup` and reuses that state
 *     for the `authenticated.spec.ts` journeys — skipping the login
 *     dance on every test.
 *   - `smoke.spec.ts` runs unauthenticated (blank storage) via the
 *     explicit `storageState: {...}` override in that spec.
 *
 * CI: add a workflow job that
 *   (a) runs the seed SQL that creates the test admin (see
 *       `e2e/auth.setup.ts` header),
 *   (b) runs `npm run dev` against a test backend, and
 *   (c) runs `npx playwright test --reporter=github`.
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
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/admin.json',
      },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
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
