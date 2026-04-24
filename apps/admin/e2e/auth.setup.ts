import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

/**
 * One-shot login that writes a reusable storage-state file for the
 * authenticated journey specs. See `playwright.config.ts` for how the
 * `chromium` project picks this up via `storageState:`.
 *
 * ## Test admin seeding (required before first run)
 *
 * Credentials are `playwright-admin` / `PlaywrightTest!2026` — a
 * deliberately non-SUPER_ADMIN user that skips the MFA enrollment gate
 * (`REQUIRE_MFA_FOR_SUPER_ADMIN=true` in apps/backend/.env).
 *
 * To seed the admin on a fresh dev or test DB:
 *
 *   BCRYPT_HASH=$(cd apps/backend && node -e "
 *     require('bcrypt').hash('PlaywrightTest!2026', 12)
 *       .then(h => console.log(h))")
 *   psql -h localhost -p 5433 -U vhhealth -d vhhealth -c "
 *     INSERT INTO admins (username, password_hash, email, name, role,
 *                          is_active, status)
 *     VALUES ('playwright-admin', '$BCRYPT_HASH',
 *             'playwright@vhhealth.test', 'Playwright Test Admin',
 *             'ADMIN', true, 'active')
 *     ON CONFLICT (username) DO UPDATE
 *       SET password_hash=EXCLUDED.password_hash,
 *           role=EXCLUDED.role, is_active=true, status='active'"
 *
 * CI must run the same seed step before `playwright test` fires.
 */

const AUTH_FILE = path.resolve(__dirname, '../playwright/.auth/admin.json');

setup('authenticate as playwright-admin', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login$/);

  // Form submit via the actual UI so any future client-side auth
  // hardening (CSRF token, honeypot field, hCaptcha) automatically
  // gets exercised by every authenticated spec.
  const inputs = page.getByRole('textbox');
  await inputs.nth(0).fill('playwright-admin');
  // The password field is textbox-typed in the login form today (not
  // role=password) — first textbox is username, second is password.
  await inputs.nth(1).fill('PlaywrightTest!2026');

  await page.getByRole('button', { name: 'Sign In' }).click();

  // Post-login the dashboard renders — the URL stops being /login.
  // Using a permissive matcher so this works whether the dashboard
  // root is `/dashboard` or redirects somewhere else.
  await expect(page).not.toHaveURL(/\/login/);

  // Persist the auth_token cookie + any localStorage profile cache
  // so the dependent project can reuse the session.
  await page.context().storageState({ path: AUTH_FILE });
});
