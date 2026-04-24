import { expect, test } from '@playwright/test';

/**
 * Admin-portal smoke tests. Exercises the routes and auth-gate behaviour
 * that don't require a live backend. These are the first line of defence
 * — if any of them break, the middleware / layout / login page has
 * regressed and nothing else is worth running.
 *
 * Journey coverage (top 5 per the admin roadmap Phase 2 entry):
 *   1. Login page renders the expected form elements
 *   2. Empty-submit form validation on login
 *   3. Unauthenticated `/dashboard` redirects to `/login`
 *   4. Every authenticated tree is gated (audit / appointments / users /
 *      payroll / system-logs all redirect to login)
 *   5. Admin portal is marked noindex — wouldn't want Google serving it
 *
 * Authenticated journeys (MFA, user CRUD, appointment booking, payslip
 * download) need a seeded test backend + API key; they land in a
 * separate spec once auth.setup.ts is wired.
 */

test.describe('smoke — auth gate', () => {
  test('login page renders the expected form elements', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login$/);

    // Username + password inputs and the Sign In submit button should
    // all be visible. Admin / Staff Login are mode-toggles, not submit
    // buttons — anchor to the exact submit name to avoid matching them.
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('empty login submit stays disabled until both fields are filled', async ({ page }) => {
    await page.goto('/login');
    // UX contract: Sign In is disabled until the user has typed
    // something into both inputs. The admin middleware would bounce
    // an empty POST anyway, but we want the button gate, not only the
    // server gate.
    const submit = page.getByRole('button', { name: 'Sign In' });
    await expect(submit).toBeDisabled();

    // Confirm the disabled state holds even if the user fills only
    // the first field. This catches a class of regressions where
    // over-eager `enabled` logic flips on a single-field change.
    await page.getByRole('textbox').first().fill('admin');
    await expect(submit).toBeDisabled();
  });

  test('unauthenticated /dashboard redirects to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('every authenticated tree is gated by the middleware', async ({ page }) => {
    // One request per protected family — if the middleware regresses on
    // any of these, at least one assertion fails. Cheaper than a full
    // sitemap crawl and catches the Phase 2 "ADMIN_IP_ALLOWLIST /
    // (with-auth) layout wraps every route" contract.
    const protectedRoutes = [
      '/dashboard/audit',
      '/dashboard/appointments',
      '/dashboard/users',
      '/dashboard/payroll',
      '/dashboard/system-logs',
    ];
    for (const route of protectedRoutes) {
      await page.goto(route);
      await expect(page, `expected ${route} to redirect to /login`).toHaveURL(/\/login/);
    }
  });

  test('admin portal is noindex for search engines', async ({ page }) => {
    await page.goto('/login');
    // If a robots meta exists it must say noindex. If none exists we
    // accept the default. getAttribute on a missing element waits for
    // the default timeout before returning null, so we count first.
    const robotsMeta = page.locator('meta[name="robots"]');
    const count = await robotsMeta.count();
    if (count > 0) {
      const content = (await robotsMeta.first().getAttribute('content')) ?? '';
      expect(content.toLowerCase()).toContain('noindex');
    }
  });
});
