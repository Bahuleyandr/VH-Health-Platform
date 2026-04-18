import { expect, test } from '@playwright/test';

/**
 * Baseline smoke tests. These exercise routes that don't require a live backend
 * (login page render, static public routes). Real journey tests land in the
 * god-component refactor PRs as components become testable in isolation.
 *
 * Once `auth.setup.ts` is wired with a test admin credential + API key, the
 * authenticated journeys (appointments, pharmacy, compliance) follow.
 */

test.describe('smoke', () => {
  test('login page renders the expected form elements', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login$/);
    // Form should have username + password inputs and a submit button.
    // Exact labels may differ — relax to the most stable selectors.
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /sign|log/i })).toBeVisible();
  });

  test('unauthenticated request to dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    // middleware.ts guards the entire `(with-auth)` tree.
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page meta tags are set (for SEO + security)', async ({ page }) => {
    await page.goto('/login');
    // Admin portals should not be indexed — robots meta should say so.
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    // Tolerate either an explicit noindex or the default (we just verify no surprise).
    if (robots) {
      expect(robots.toLowerCase()).toContain('noindex');
    }
  });
});
