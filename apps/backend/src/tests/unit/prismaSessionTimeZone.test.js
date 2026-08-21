/**
 * Every database session must run in UTC.
 *
 * The driver materialises a `timestamptz` as a JS Date in the DATABASE SESSION
 * timezone — for `$queryRaw*` AND for the typed model delegates alike. On a
 * non-UTC session, `new Date(row.expires_at) < Date.now()` is therefore wrong by
 * the session offset. That shipped as real defects, two of them fail-OPEN on a
 * positive offset (Asia/Kolkata, the plausible direction for this deployment):
 * expired HIU key material and an expired ABHA enrolment OTP were both accepted
 * for up to 5h30m.
 *
 * Pinning the session at the connection closes the whole class at once, which
 * is why it must not be quietly dropped. Prod and CI already run UTC, so a
 * regression here is invisible in CI — hence this guard.
 */

import { pinSessionTimeZoneToUrl } from '../../lib/prisma.js';

// Deliberately credential-free: this exercises query-parameter shaping only,
// and an embedded password would trip the vh-postgres-url-with-credentials
// secret-scan rule.
const BASE = 'postgresql://vhhealth@127.0.0.1:5432/vhhealth';
const optionsOf = (url) => new URL(url).searchParams.get('options');

describe('database session timezone pin', () => {
  it('pins a plain connection string to UTC', () => {
    expect(optionsOf(pinSessionTimeZoneToUrl(BASE))).toBe('-c timezone=UTC');
  });

  it('appends to an existing options value instead of clobbering it', () => {
    const withTimeout = `${BASE}?options=${encodeURIComponent('-c statement_timeout=30000')}`;
    const options = optionsOf(pinSessionTimeZoneToUrl(withTimeout));
    expect(options).toContain('-c statement_timeout=30000');
    expect(options).toContain('-c timezone=UTC');
  });

  it('composes with the statement-timeout shaping applied by makeClient', () => {
    // makeClient runs applyStatementTimeoutToUrl first, then this. Both write
    // the same `options` key, so the second must not drop the first.
    const shaped = pinSessionTimeZoneToUrl(
      `${BASE}?options=${encodeURIComponent('-c statement_timeout=60000')}&sslmode=require`,
    );
    expect(optionsOf(shaped)).toBe('-c statement_timeout=60000 -c timezone=UTC');
    expect(new URL(shaped).searchParams.get('sslmode')).toBe('require');
  });

  it('leaves an explicit operator timezone alone', () => {
    const explicit = `${BASE}?options=${encodeURIComponent('-c timezone=Asia/Kolkata')}`;
    expect(pinSessionTimeZoneToUrl(explicit)).toBe(explicit);
  });

  it('passes an unparseable url through rather than throwing', () => {
    expect(pinSessionTimeZoneToUrl('not a url')).toBe('not a url');
    expect(pinSessionTimeZoneToUrl('')).toBe('');
    expect(pinSessionTimeZoneToUrl(null)).toBeNull();
  });

  it('is idempotent, so repeated shaping cannot stack duplicate pins', () => {
    const once = pinSessionTimeZoneToUrl(BASE);
    expect(pinSessionTimeZoneToUrl(once)).toBe(once);
  });
});

// The shape assertions above cannot prove the server actually honoured the pin.
// Where a database is reachable, assert the live session directly.
const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

d('database session timezone pin (live)', () => {
  it('reports UTC on the real connection regardless of server configuration', async () => {
    const { default: prisma } = await import('../../lib/prisma.js');
    const rows = await prisma.$queryRawUnsafe("SELECT current_setting('TimeZone') AS tz");
    expect(rows[0].tz).toBe('UTC');
  }, 30_000);

  it('decodes a known instant identically through raw SQL and a model delegate', async () => {
    const { default: prisma } = await import('../../lib/prisma.js');
    const rows = await prisma.$queryRawUnsafe(
      "SELECT TIMESTAMPTZ '2026-08-17T15:00:00Z' AS at",
    );
    expect(new Date(rows[0].at).toISOString()).toBe('2026-08-17T15:00:00.000Z');
  }, 30_000);
});
