/**
 * Unit tests for the Sentry beforeBreadcrumb scrubber (audit 2026-06-18 §4
 * Observability): beforeSend / beforeSendTransaction scrubbed events, but
 * there was no breadcrumb hook, so console.* and outbound-HTTP breadcrumbs
 * (captured by the default integrations) carried raw PHI/secrets into Sentry.
 * scrubBreadcrumb reuses the event scrubber's value logic.
 */

import { scrubBreadcrumb } from '../../utils/sentry.js';

describe('scrubBreadcrumb', () => {
  it('scrubs PHI/secrets out of breadcrumb message text', () => {
    const out = scrubBreadcrumb({
      category: 'console',
      level: 'log',
      message: 'login for +911234567890 / staff@example.com token eyJabc.def.ghi',
    });
    expect(out.message).not.toContain('+911234567890');
    expect(out.message).not.toContain('staff@example.com');
    expect(out.message).toContain('[REDACTED_PHONE]');
    expect(out.message).toContain('[REDACTED_EMAIL]');
    expect(out.message).toContain('[REDACTED_JWT]');
  });

  it('redacts sensitive keys in breadcrumb data and normalizes URLs', () => {
    const out = scrubBreadcrumb({
      category: 'http',
      data: {
        url: '/api/v1/patients/123456/timeline?phone=9876543210',
        method: 'GET',
        Authorization: 'Bearer secret',
        phone: '+911234567890',
        safeCode: 'queue-opened',
      },
    });
    expect(out.data.Authorization).toBe('[Filtered]');
    expect(out.data.phone).toBe('[Filtered]');
    expect(out.data.safeCode).toBe('queue-opened');
    // URL is path-normalized + query dropped of ids
    expect(out.data.url).toBe('/api/v1/patients/:id/timeline');
    expect(out.data.method).toBe('GET');
  });

  it('returns null/non-objects untouched and never throws', () => {
    expect(scrubBreadcrumb(null)).toBeNull();
    expect(scrubBreadcrumb(undefined)).toBeUndefined();
    expect(() => scrubBreadcrumb({})).not.toThrow();
  });
});
