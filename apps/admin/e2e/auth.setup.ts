import { test as setup, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * One-shot login that writes a reusable storage-state file for the
 * authenticated journey specs. See `playwright.config.ts` for how the
 * `chromium` project picks this up via `storageState:`.
 *
 * ## Test admin seeding (required before first run)
 *
 * Default credentials are `playwright-admin` / `PlaywrightTest!2026` — a
 * deliberately non-SUPER_ADMIN user that skips the MFA enrollment gate
 * (`REQUIRE_MFA_FOR_SUPER_ADMIN=true` in apps/backend/.env). CI can override
 * them with PLAYWRIGHT_ADMIN_USERNAME / PLAYWRIGHT_ADMIN_PASSWORD when it uses
 * the comprehensive local seed (`admin` / `test1234`).
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
const ADMIN_USERNAME = process.env.PLAYWRIGHT_ADMIN_USERNAME || 'playwright-admin';
const ADMIN_PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD || 'PlaywrightTest!2026';

// Backend API for deterministic token acquisition (the UI login form has no
// scriptable MFA step in CI). API key + the run-scoped TOTP secret that the
// smoke's "Enroll SUPER_ADMIN TOTP" step exports when the admin has 2FA.
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5206';
const API_KEY = process.env.NEXT_PUBLIC_X_API_KEY || process.env.API_KEY || '';
const TOTP_SECRET = process.env.PLAYWRIGHT_ADMIN_TOTP_SECRET || '';

// Standalone RFC-6238 TOTP (SHA1, 30s step, 6 digits, base32 secret) — matches
// the backend's otplib defaults, so generated codes pass otplib `verify`. Kept
// dependency-free so the admin package needs no OTP library just for E2E.
function base32ToBuffer(b32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpCode(secret: string, step = 30, digits = 6): string {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin =
    ((h[off] & 0x7f) << 24) |
    ((h[off + 1] & 0xff) << 16) |
    ((h[off + 2] & 0xff) << 8) |
    (h[off + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

type StorageState = {
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
};

async function reuseExistingAuth(page: Page): Promise<boolean> {
  if (!fs.existsSync(AUTH_FILE)) return false;

  try {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as StorageState;
    const cookies = (state.cookies ?? []).filter((cookie) => cookie.name === 'auth_token' && cookie.value);
    if (cookies.length === 0) return false;

    await page.context().addCookies(cookies);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    if (/\/login/.test(page.url())) return false;
    return true;
  } catch {
    return false;
  }
}

setup('authenticate as playwright-admin', async ({ page }) => {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  if (await reuseExistingAuth(page)) {
    await page.context().storageState({ path: AUTH_FILE });
    return;
  }

  // Acquire a session token via the backend API so we can complete the REAL
  // admin 2FA (TOTP) challenge when the test admin has MFA enrolled — the UI
  // login form has no scriptable MFA step in CI. The resulting JWT carries
  // `mfa: true`, which the 2026-06-18 super-admin step-up gate requires on
  // sensitive admin namespaces (admin dashboard, admin-management).
  const loginRes = await page.request.post(`${API_URL}/api/v1/auth/admin/login`, {
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  expect(
    loginRes.ok(),
    `admin login failed (${loginRes.status()}): ${await loginRes.text()}`,
  ).toBeTruthy();
  const loginData = (await loginRes.json())?.data ?? {};

  let token: string | undefined = loginData.token;

  if (loginData.requiresTwoFactor) {
    expect(
      TOTP_SECRET,
      'PLAYWRIGHT_ADMIN_TOTP_SECRET must be set to complete the admin 2FA challenge',
    ).not.toBe('');
    const verifyRes = await page.request.post(
      `${API_URL}/api/v1/auth/admin/mfa/challenge/verify`,
      {
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        data: { challengeToken: loginData.challengeToken, code: totpCode(TOTP_SECRET) },
      },
    );
    expect(
      verifyRes.ok(),
      `2FA challenge verify failed (${verifyRes.status()}): ${await verifyRes.text()}`,
    ).toBeTruthy();
    token = ((await verifyRes.json())?.data ?? {}).token;
  }

  expect(token, 'no auth token obtained from admin login').toBeTruthy();

  // Set the httpOnly auth_token cookie the proxy + middleware expect. CI serves
  // the admin over http on localhost, so the cookie must be non-Secure (a Secure
  // cookie is dropped over http and every route would bounce to /login).
  await page.context().addCookies([
    {
      name: 'auth_token',
      value: token as string,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
      expires: Math.floor(Date.now() / 1000) + 4 * 3600,
    },
  ]);

  // Confirm the session lands on the dashboard, not /login.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/login/);

  // Persist the auth_token cookie so the dependent project reuses the session.
  await page.context().storageState({ path: AUTH_FILE });
});
