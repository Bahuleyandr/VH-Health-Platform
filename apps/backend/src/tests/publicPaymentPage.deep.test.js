// Audit 2026-08-09 finding F8 — public bill-payment landing page.
//
// The payment link we SMS/WhatsApp/email to patients pointed at
// `${HOSPITAL_PAY_BASE_URL}/<token>`, and NO route served it. This suite pins
// the page that now does, through the real Express mount (outside /api/v1,
// above validateApiKey/jwtAuth) with supertest.
//
// It seeds the DB layer rather than a database: prisma's raw call surface is
// mocked with a programmable stub, the same technique downtime-static.deep.test.js
// uses, so every state (payable / paid / expired / cancelled / invalid) is driven
// deterministically and the suite has no QA-cluster dependency.

import { jest } from '@jest/globals';
import request from 'supertest';

const queryRawUnsafe = jest.fn();

// Spread the REAL module first so app.js's import graph still resolves every
// symbol it needs (setTenant, setTenantTx, prismaReadOnly, circuit-breaker
// helpers, …); override only the raw call surface this page uses.
const actualPrisma = await import('../lib/prisma.js');
const prismaStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    if (prop === '$queryRawUnsafe') return queryRawUnsafe;
    if (typeof prop === 'string' && !prop.startsWith('$') && /^[a-z]/.test(prop)) {
      return new Proxy({}, { get: () => () => Promise.reject(new Error('unexpected model call')) });
    }
    return () => Promise.reject(new Error('unexpected prisma call'));
  },
});

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrisma,
  default: prismaStub,
  prismaReadOnly: prismaStub,
}));

// Deliberately low-entropy and self-describing: a realistic random base64url
// fixture reads as a live credential to secret scanners (GitGuardian flagged
// exactly that). The real token shape is covered in publicPaymentPageView.test.js.
const TOKEN = 'test-payment-link-token-000000';
const HOSPITAL = 'Venkataeswara Hospital';
const UPI_LINK = 'upi://pay?pa=hospital@upi&pn=Venkataeswara%20Hospital&am=1250.00&cu=INR&tr=VH-77-abc';

// Poison values: these live on the link/invoice rows in reality and must NEVER
// reach the page. Returned by the stub on purpose so the assertion is real.
const PHI_POISON = {
  patient_uid: '11111111-2222-4333-8444-555555555555',
  patient_phone: '+919876543210',
  patient_name: 'Rajesh Kumar',
  notes: 'Teleconsult post-consult payment: consult 91 / diabetes review',
  diagnosis: 'Type 2 diabetes mellitus',
};

function linkRow(overrides = {}) {
  return {
    amount: '1250.00',
    currency: 'INR',
    status: 'sent',
    expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    paid_at: null,
    upi_deep_link: UPI_LINK,
    upi_payee_name: HOSPITAL,
    invoice_number: 'INV-2026-000077',
    ...PHI_POISON,
    ...overrides,
  };
}

let app;
let patientRateLimiter;
let INVALID_LINK_PAGE;

beforeAll(async () => {
  ({ default: app } = await import('../app.js'));
  ({ patientRateLimiter } = await import('../middleware/rateLimitMiddleware.js'));
  ({ INVALID_LINK_PAGE } = await import('../routes/billing/publicPaymentPageRoutes.js'));
});

beforeEach(() => queryRawUnsafe.mockReset());

describe('GET /pay/:token — public payment landing page (audit F8)', () => {
  describe('payable', () => {
    it('renders the amount, invoice reference and a UPI intent link', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('₹1250.00');
      expect(res.text).toContain('INV-2026-000077');
      expect(res.text).toContain(HOSPITAL);
      // The upi:// intent is the ONLY payment rail offered.
      expect(res.text).toContain('upi://pay?');
      expect(res.text).toContain('Pay by UPI');
    });

    it('does not promise card / netbanking / wallet rails that do not exist', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      const res = await request(app).get(`/pay/${TOKEN}`);
      expect(res.text).not.toMatch(/\bcard\b/i);
      expect(res.text).not.toMatch(/\bwallet\b/i);
      expect(res.text).not.toMatch(/netbanking/i);
    });

    it('omits the pay button when the stored deep link is not a UPI intent', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow({ upi_deep_link: 'https://evil.example/phish' })]);
      const res = await request(app).get(`/pay/${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('evil.example');
      expect(res.text).toContain('billing counter');
    });
  });

  describe('already paid', () => {
    it('says the bill is paid and offers no payment link', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow({
        status: 'paid', paid_at: new Date('2026-08-01T10:30:00Z'),
      })]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('already been paid');
      expect(res.text).not.toContain('upi://');
    });
  });

  describe('expired', () => {
    it('reports expiry when the status says so', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow({ status: 'expired' })]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('expired');
      expect(res.text).not.toContain('upi://');
    });

    // The link row's TTL is authoritative, not its status column: expiry is
    // flipped by a cron, so between the deadline and the next pass the row is
    // still 'sent'. It must NOT be presented as payable in that window.
    it('reports expiry from expires_at even while the status is still sent', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow({
        status: 'sent', expires_at: new Date(Date.now() - 60_000),
      })]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('expired');
      expect(res.text).not.toContain('upi://');
    });
  });

  describe('cancelled', () => {
    it('reports cancellation and offers no payment link', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow({ status: 'cancelled' })]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('cancelled');
      expect(res.text).not.toContain('upi://');
    });
  });

  describe('invalid — no token-enumeration oracle', () => {
    it('returns the uniform 404 page for an unknown token', async () => {
      queryRawUnsafe.mockResolvedValue([]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.text).toBe(INVALID_LINK_PAGE);
    });

    it('returns a BYTE-IDENTICAL response for a malformed token, without querying the link table', async () => {
      queryRawUnsafe.mockResolvedValue([]);
      const unknown = await request(app).get(`/pay/${TOKEN}`);

      queryRawUnsafe.mockClear();
      const malformed = await request(app).get('/pay/not-a-real-token!!');

      expect(malformed.status).toBe(unknown.status);
      expect(malformed.text).toBe(unknown.text);
      // A malformed token is rejected on shape — it never reaches the link
      // table. Filter by SQL rather than counting all prisma traffic: other
      // global middleware may issue unrelated queries during the request.
      const linkQueries = queryRawUnsafe.mock.calls
        .filter(([sql]) => String(sql).includes('billing_payment_links'));
      expect(linkQueries).toEqual([]);
    });

    it('renders a retry page (never a stack trace or JSON envelope) when the lookup fails', async () => {
      queryRawUnsafe.mockRejectedValue(new Error('connection refused at 127.0.0.1:5432'));
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).not.toContain('connection refused');
      expect(res.text).not.toContain('"success"');
    });
  });

  describe('PHI allowlist', () => {
    it('publishes no patient-identifying field, only invoice reference and amount', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      const leaked = Object.entries(PHI_POISON)
        .filter(([, value]) => res.text.includes(value))
        .map(([field]) => field);
      expect(leaked).toEqual([]);
      // The bearer token itself is never echoed into the page either.
      expect(res.text).not.toContain(TOKEN);
    });

    it('never SELECTs a PHI column in the first place', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      await request(app).get(`/pay/${TOKEN}`);

      const sql = String(queryRawUnsafe.mock.calls[0][0]).toLowerCase();
      const selected = ['patient_uid', 'patient_phone', 'notes', 'created_by', 'paid_reference']
        .filter((column) => sql.includes(column));
      expect(selected).toEqual([]);
      // Explicit columns only — never SELECT *.
      expect(sql).not.toContain('select *');
    });

    // The token in the URL is the link's bearer credential. Putting a page at
    // /pay/:token means every global request-logger now sees it, so the audit
    // middleware skips this path (auditLog.js SKIP_PATHS). Guard that here: a
    // regression would persist a live credential into audit_logs.
    it('never persists the bearer token through any other query', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      queryRawUnsafe.mockClear();
      await request(app).get(`/pay/${TOKEN}`);
      // The audit writer is fire-and-forget; give it a tick to have run.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const leaks = queryRawUnsafe.mock.calls.filter(([sql, ...params]) =>
        !String(sql).includes('billing_payment_links')
        && JSON.stringify(params ?? []).includes(TOKEN));
      expect(leaks).toEqual([]);
      // It is only ever bound as a parameter, never interpolated into SQL.
      expect(queryRawUnsafe.mock.calls.filter(([sql]) => String(sql).includes(TOKEN))).toEqual([]);
    });
  });

  describe('browser-surface hardening', () => {
    it('sets no-store, noindex and an inline-script-free body under the app CSP', async () => {
      queryRawUnsafe.mockResolvedValue([linkRow()]);
      const res = await request(app).get(`/pay/${TOKEN}`);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      // Helmet is mounted globally; script-src is 'self' with no 'unsafe-inline',
      // so the page must carry zero inline script. Inline <style> is allowed.
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.text).not.toContain('<script');
      expect(res.text).toContain('<style>');
    });

    it('is mounted behind the patient rate-limit profile', async () => {
      // Structural proof of wiring: the shared `patient` profile deliberately
      // skips inside jest (rateLimitMiddleware `isTestEnv`), so a live 429 is
      // not observable here — assert the limiter instance sits on the /pay
      // chain instead of asserting a status code it cannot produce.
      //
      // Express 5 Layers carry no readable `regexp` (path-to-regexp v8 matchers
      // are opaque functions — the same fact the OpenAPI enumerator works
      // around), so identify the mount by handler identity and ORDER:
      // app.use('/pay', patientRateLimiter, payRouter) registers the limiter
      // layer immediately before the router layer.
      const { default: payRouter } = await import('../routes/billing/publicPaymentPageRoutes.js');
      const routerIndex = app.router.stack.findIndex((layer) => layer.handle === payRouter);

      expect(routerIndex).toBeGreaterThan(0);
      expect(app.router.stack[routerIndex - 1].handle).toBe(patientRateLimiter);
    });
  });
});
