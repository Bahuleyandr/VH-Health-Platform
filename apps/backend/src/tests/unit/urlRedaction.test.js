import {
  hasSensitiveQueryParameters,
  redactCredentialQueryValues,
  redactSensitiveQueryParams,
} from '../../utils/urlRedaction.js';

describe('redactSensitiveQueryParams', () => {
  it('redacts a Firebase idToken value while keeping the path', () => {
    expect(
      redactSensitiveQueryParams('/api/v1/auth/firebase/verify-token?idToken=eyJhbGciOi.secret.sig'),
    ).toBe('/api/v1/auth/firebase/verify-token?idToken=[REDACTED]');
  });

  it('passes through a URL with no query string unchanged', () => {
    expect(redactSensitiveQueryParams('/api/v1/users/me')).toBe('/api/v1/users/me');
  });

  it.each(['dlr', 'twilio-status'])('redacts the SMS %s callback token from the path', (route) => {
    const token = 'tok_abcdefghijklmnopqrstuvwxyz01';
    const result = redactSensitiveQueryParams(`/webhooks/sms/${route}/${token}?To=%2B919876543210`);
    expect(result).toBe(`/webhooks/sms/${route}/[REDACTED]`);
    expect(result).not.toContain(token);
    expect(result).not.toContain('9876543210');
  });

  it('drops callback query fields from an absolute URL as well', () => {
    expect(redactSensitiveQueryParams(
      'https://api.vhhealth.app/webhooks/sms/dlr/callback-secret?mobile=919876543210',
    )).toBe('https://api.vhhealth.app/webhooks/sms/dlr/[REDACTED]');
  });

  it('redacts the payment callback bearer path', () => {
    expect(redactSensitiveQueryParams(
      '/webhooks/payments/payment-callback-bearer?event=payment.captured',
    )).toBe('/webhooks/payments/[REDACTED]?event=payment.captured');
  });

  it('redacts only sensitive params and preserves the rest', () => {
    expect(
      redactSensitiveQueryParams('/x?page=2&access_token=abc123&note_type=progress'),
    ).toBe('/x?page=2&access_token=[REDACTED]&note_type=progress');
  });

  it('redacts multiple sensitive params in one URL', () => {
    expect(
      redactSensitiveQueryParams('/x?token=aaa&refresh_token=bbb&api_key=ccc'),
    ).toBe('/x?token=[REDACTED]&refresh_token=[REDACTED]&api_key=[REDACTED]');
  });

  it('redacts SMS and payment gateway configuration secret names', () => {
    expect(redactSensitiveQueryParams(
      '/x?auth_key=sms-secret&key_secret=provider-secret&webhook_secret=signing-secret',
    )).toBe('/x?auth_key=[REDACTED]&key_secret=[REDACTED]&webhook_secret=[REDACTED]');
  });

  it('matches the param name case-insensitively', () => {
    expect(redactSensitiveQueryParams('/x?IdToken=abc')).toBe('/x?IdToken=[REDACTED]');
    expect(redactSensitiveQueryParams('/x?ACCESS_TOKEN=abc')).toBe('/x?ACCESS_TOKEN=[REDACTED]');
  });

  it('preserves redaction for legacy unseparated token parameter names', () => {
    expect(redactSensitiveQueryParams(
      '/x?idtoken=id-secret&accesstoken=access-secret&refreshtoken=refresh-secret',
    )).toBe(
      '/x?idtoken=[REDACTED]&accesstoken=[REDACTED]&refreshtoken=[REDACTED]',
    );
  });

  it('normalizes camelCase, separators, and encoded separators before matching', () => {
    expect(redactSensitiveQueryParams(
      '/x?authHeader=bearer-a&refresh-token=bearer-b&auth%5Fheader=bearer-c&token_number=OP-17',
    )).toBe(
      '/x?authHeader=[REDACTED]&refresh-token=[REDACTED]&auth%5Fheader=[REDACTED]&token_number=OP-17',
    );
  });

  it('detects credential-bearing receiver URL queries without flagging workflow tokens', () => {
    expect(hasSensitiveQueryParameters(
      'https://receiver.example/hl7?auth%5Fheader=secret&tenant=one',
    )).toBe(true);
    expect(hasSensitiveQueryParameters(
      'https://receiver.example/hl7?auth%255Fheader=secret&tenant=one',
    )).toBe(true);
    expect(hasSensitiveQueryParameters(
      'https://receiver.example/hl7?token_number=OP-17&tenant=one',
    )).toBe(false);
  });

  it('redacts only credential values in stored receiver URL projections', () => {
    expect(redactCredentialQueryValues(
      'https://receiver.example/api/v1/hl7/receive?tenant=one&api_key=secret#status',
      '%5BREDACTED%5D',
    )).toBe(
      'https://receiver.example/api/v1/hl7/receive?tenant=one&api_key=%5BREDACTED%5D#status',
    );
  });

  it('handles a sensitive param with an empty value', () => {
    expect(redactSensitiveQueryParams('/x?idToken=')).toBe('/x?idToken=[REDACTED]');
  });

  it('leaves a non-sensitive query string untouched', () => {
    expect(redactSensitiveQueryParams('/x?page=2&limit=20')).toBe('/x?page=2&limit=20');
  });

  it('preserves a trailing fragment', () => {
    expect(redactSensitiveQueryParams('/x?idToken=abc#section')).toBe(
      '/x?idToken=[REDACTED]#section',
    );
  });

  it('returns non-string input unchanged', () => {
    expect(redactSensitiveQueryParams(undefined)).toBeUndefined();
    expect(redactSensitiveQueryParams(null)).toBeNull();
  });
});
