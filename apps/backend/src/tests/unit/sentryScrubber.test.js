import {
  normalizeSentryPath,
  scrubSentryEvent,
  scrubSentryText
} from '../../utils/sentryScrubber.js';

describe('sentryScrubber', () => {
  it('redacts obvious PHI and secrets from text', () => {
    const value = scrubSentryText(
      'Patient VH-000123 called +911234567890 at test@example.com with token eyJabc.def.ghi'
    );

    expect(value).toContain('[REDACTED_HOSPITAL_ID]');
    expect(value).toContain('[REDACTED_PHONE]');
    expect(value).toContain('[REDACTED_EMAIL]');
    expect(value).toContain('[REDACTED_JWT]');
    expect(value).not.toContain('+911234567890');
    expect(value).not.toContain('test@example.com');
  });

  it('normalizes ids out of request paths', () => {
    expect(normalizeSentryPath('/api/v1/patients/123456/timeline?date=1')).toBe(
      '/api/v1/patients/:id/timeline'
    );
    expect(normalizeSentryPath('/api/v1/emr/vitals/a1f04cf1-3f2a-4a85-a2d3-7fd06c928017')).toBe(
      '/api/v1/emr/vitals/:uuid'
    );
  });

  it('removes SMS callback bearer tokens from Sentry paths', () => {
    expect(normalizeSentryPath(
      '/webhooks/sms/twilio-status/tok_abcdefghijklmnopqrstuvwxyz01?retry=1'
    )).toBe('/webhooks/sms/twilio-status/[REDACTED]');
  });

  it('scrubs event request, user, extra and transaction fields', () => {
    const event = scrubSentryEvent({
      transaction: '/api/v1/patients/123456/timeline',
      user: { id: 'staff-uid', email: 'staff@example.com', username: '+911234567890' },
      request: {
        method: 'POST',
        url: '/api/v1/patients/123456/timeline?phone=1234567890',
        headers: { Authorization: 'Bearer secret', role: 'DOCTOR' },
        data: { patientName: 'Priya Iyer', note: 'private clinical note' }
      },
      extra: {
        phone: '+911234567890',
        safeCode: 'queue-opened'
      }
    });

    expect(event.transaction).toBe('/api/v1/patients/:id/timeline');
    expect(event.request.url).toBe('/api/v1/patients/:id/timeline');
    expect(event.request.data).toBeUndefined();
    expect(event.request.headers.Authorization).toBe('[Filtered]');
    expect(event.user).toEqual({ id: 'staff-uid', role: undefined });
    expect(event.extra.phone).toBe('[Filtered]');
    expect(event.extra.safeCode).toBe('queue-opened');
  });
});
