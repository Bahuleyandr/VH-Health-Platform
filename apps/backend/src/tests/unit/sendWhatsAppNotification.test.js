/**
 * Phase E5 — WhatsApp provider unit tests.
 * Default ('logger') provider must never throw or attempt network.
 */

import { jest } from '@jest/globals';

const { sendWhatsApp, __testing__ } = await import('../../utils/notifications/sendWhatsAppNotification.js');

beforeEach(() => {
  delete process.env.WHATSAPP_PROVIDER;
});

afterAll(() => {
  delete process.env.WHATSAPP_PROVIDER;
});

describe('normalisePhoneE164', () => {
  it('passes through E.164 numbers', () => {
    expect(__testing__.normalisePhoneE164('+919876543210')).toBe('+919876543210');
  });
  it('prefixes 10-digit Indian numbers with +91', () => {
    expect(__testing__.normalisePhoneE164('9876543210')).toBe('+919876543210');
  });
  it('returns null for unrecognised shapes', () => {
    expect(__testing__.normalisePhoneE164('1234')).toBeNull();
    expect(__testing__.normalisePhoneE164(null)).toBeNull();
  });
  it('strips whitespace + dashes', () => {
    expect(__testing__.normalisePhoneE164('+91 98765-43210')).toBe('+919876543210');
  });
});

describe('maskPhoneForLog', () => {
  it('masks middle digits', () => {
    expect(__testing__.maskPhoneForLog('+919876543210')).toBe('+91***210');
  });
  it('handles empty input', () => {
    expect(__testing__.maskPhoneForLog(null)).toBe('<unknown>');
  });
});

describe('sendWhatsApp', () => {
  it('rejects missing fields', async () => {
    await expect(sendWhatsApp({ to: '', body: 'hi' })).rejects.toThrow(/to and body/);
  });

  it('logger provider returns status logged without network', async () => {
    const out = await sendWhatsApp({ to: '+919876543210', body: 'Reminder: appt at 10' });
    expect(out).toEqual({ status: 'logged' });
  });

  it('returns invalid_phone for unrecognisable numbers', async () => {
    const out = await sendWhatsApp({ to: '12', body: 'hi' });
    expect(out).toEqual({ status: 'invalid_phone' });
  });

  it('rejects unknown WHATSAPP_PROVIDER', async () => {
    process.env.WHATSAPP_PROVIDER = 'magic';
    await expect(sendWhatsApp({ to: '+919876543210', body: 'x' }))
      .rejects.toThrow(/Unknown WHATSAPP_PROVIDER/);
  });
});
