// Audit 2026-08-09 finding F8 — the public payment page's data contract.
//
// The route test (src/tests/publicPaymentPage.deep.test.js) covers HTTP shape
// and rendering. This suite pins the two pure decisions underneath it:
//   * which fields may leave the service at all (the PHI allowlist), and
//   * how a link row maps to a display state — in particular that expires_at
//     beats status, because the expiry cron lags the deadline.

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  prismaReadOnly: { $queryRawUnsafe: queryRawUnsafe },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

const {
  isWellFormedPaymentLinkToken,
  resolvePaymentLinkPublicState,
  getPublicPaymentLinkView,
} = await import('../../services/billing/paymentLinkService.js');

// The complete set of fields the page is allowed to publish. Adding a key here
// is a PHI decision — it must be justified against audit F8's constraint that
// the page exposes nothing beyond a payer display name, invoice ref and amount.
const ALLOWED_VIEW_KEYS = [
  'amount', 'currency', 'expiresAt', 'hospitalName',
  'invoiceReference', 'paidAt', 'state', 'upiDeepLink',
];

// Deliberately low-entropy and self-describing. A realistic-looking random
// base64url fixture here reads as a live credential to secret scanners
// (GitGuardian flagged exactly that), and these tests only need a value that
// satisfies the token SHAPE — the base64url alphabet is covered separately.
const TOKEN = 'test-payment-link-token-000000';

const HOUR = 3600 * 1000;

function row(overrides = {}) {
  return {
    amount: '900.50',
    currency: 'INR',
    status: 'sent',
    expires_at: new Date(Date.now() + 24 * HOUR),
    paid_at: null,
    upi_deep_link: 'upi://pay?pa=hospital@upi&pn=Test&am=900.50&cu=INR',
    upi_payee_name: 'Test Hospital',
    invoice_number: 'INV-1',
    // Present on the real row / join; must never reach the view.
    patient_uid: '11111111-2222-4333-8444-555555555555',
    notes: 'Teleconsult post-consult payment: consult 91',
    ...overrides,
  };
}

beforeEach(() => queryRawUnsafe.mockReset());

describe('isWellFormedPaymentLinkToken', () => {
  it('accepts a real generateToken() output shape (24 bytes base64url)', () => {
    expect(isWellFormedPaymentLinkToken(TOKEN)).toBe(true);
    // generateToken() emits 24 random bytes as base64url → 32 chars. Same
    // length and alphabet as production, without looking like a live secret.
    expect(isWellFormedPaymentLinkToken('AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD')).toBe(true);
    expect(isWellFormedPaymentLinkToken('a-b_c1234567890123')).toBe(true);
  });

  it('rejects anything that is not an opaque token', () => {
    for (const bad of [
      '', 'short', '../../etc/passwd', 'tok en', "tok'or'1'='1",
      'a'.repeat(65), null, undefined, 12345, {},
    ]) {
      expect(isWellFormedPaymentLinkToken(bad)).toBe(false);
    }
  });
});

describe('resolvePaymentLinkPublicState', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('maps the live statuses', () => {
    expect(resolvePaymentLinkPublicState({ status: 'created' }, now)).toBe('payable');
    expect(resolvePaymentLinkPublicState({ status: 'sent' }, now)).toBe('payable');
    expect(resolvePaymentLinkPublicState({ status: 'paid' }, now)).toBe('paid');
    expect(resolvePaymentLinkPublicState({ status: 'cancelled' }, now)).toBe('cancelled');
    expect(resolvePaymentLinkPublicState({ status: 'expired' }, now)).toBe('expired');
  });

  // expireStaleLinks() is a cron: a link is past its deadline BEFORE the row
  // says so. Trusting status alone would present a dead link as payable.
  it('treats a past expires_at as expired even while status is still sent', () => {
    expect(resolvePaymentLinkPublicState(
      { status: 'sent', expires_at: new Date(now.getTime() - 1000) }, now,
    )).toBe('expired');
  });

  it('leaves a future or absent expires_at payable', () => {
    expect(resolvePaymentLinkPublicState(
      { status: 'sent', expires_at: new Date(now.getTime() + HOUR) }, now,
    )).toBe('payable');
    expect(resolvePaymentLinkPublicState({ status: 'sent', expires_at: null }, now)).toBe('payable');
  });

  it('never claims payable for an unrecognised status', () => {
    expect(resolvePaymentLinkPublicState({ status: 'refunded' }, now)).toBe('unavailable');
    expect(resolvePaymentLinkPublicState({}, now)).toBe('unavailable');
  });

  // 'paid' outranks expiry: a paid-then-expired link must not tell the patient
  // it expired, or they may pay a second time.
  it('reports paid ahead of expiry', () => {
    expect(resolvePaymentLinkPublicState(
      { status: 'paid', expires_at: new Date(now.getTime() - HOUR) }, now,
    )).toBe('paid');
  });
});

describe('getPublicPaymentLinkView', () => {
  it('returns ONLY the allowlisted keys — no patient_uid, no notes', async () => {
    queryRawUnsafe.mockResolvedValue([row()]);
    const view = await getPublicPaymentLinkView({ link_token: TOKEN });

    expect(Object.keys(view).sort()).toEqual(ALLOWED_VIEW_KEYS);
    expect(JSON.stringify(view)).not.toContain('11111111-2222-4333-8444-555555555555');
    expect(JSON.stringify(view)).not.toContain('Teleconsult');
  });

  it('looks the link up by token alone — a public page has no tenant to scope by', async () => {
    queryRawUnsafe.mockResolvedValue([row()]);
    await getPublicPaymentLinkView({ link_token: TOKEN });

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('pl.link_token = $1');
    expect(params).toEqual([TOKEN]);
    // link_token is globally UNIQUE, so exactly one row can match.
    expect(sql).toContain('LIMIT 1');
  });

  it('returns null for a malformed token WITHOUT querying the database', async () => {
    expect(await getPublicPaymentLinkView({ link_token: '../../etc/passwd' })).toBeNull();
    expect(await getPublicPaymentLinkView({ link_token: '' })).toBeNull();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns null for an unknown token', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    expect(await getPublicPaymentLinkView({ link_token: TOKEN })).toBeNull();
  });

  it('surfaces the UPI intent only while the link is payable', async () => {
    queryRawUnsafe.mockResolvedValue([row()]);
    const payable = await getPublicPaymentLinkView({ link_token: TOKEN });
    expect(payable.upiDeepLink).toMatch(/^upi:\/\/pay\?/);

    queryRawUnsafe.mockResolvedValue([row({ status: 'paid' })]);
    const paid = await getPublicPaymentLinkView({ link_token: TOKEN });
    expect(paid.upiDeepLink).toBeNull();
  });

  it('refuses a stored deep link that is not a upi:// intent', async () => {
    queryRawUnsafe.mockResolvedValue([row({ upi_deep_link: 'javascript:alert(1)' })]);
    const view = await getPublicPaymentLinkView({ link_token: TOKEN });
    expect(view.upiDeepLink).toBeNull();
  });

  it('reports an advance (invoice-less) link with a null reference, never a name', async () => {
    queryRawUnsafe.mockResolvedValue([row({ invoice_number: null })]);
    const view = await getPublicPaymentLinkView({ link_token: TOKEN });
    expect(view.invoiceReference).toBeNull();
    expect(view.hospitalName).toBe('Test Hospital');
  });
});
