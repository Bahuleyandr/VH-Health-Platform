import { redactSensitiveQueryParams } from '../../utils/urlRedaction.js';

describe('redactSensitiveQueryParams', () => {
  it('redacts a Firebase idToken value while keeping the path', () => {
    expect(
      redactSensitiveQueryParams('/api/v1/auth/firebase/verify-token?idToken=eyJhbGciOi.secret.sig'),
    ).toBe('/api/v1/auth/firebase/verify-token?idToken=[REDACTED]');
  });

  it('passes through a URL with no query string unchanged', () => {
    expect(redactSensitiveQueryParams('/api/v1/users/me')).toBe('/api/v1/users/me');
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

  it('matches the param name case-insensitively', () => {
    expect(redactSensitiveQueryParams('/x?IdToken=abc')).toBe('/x?IdToken=[REDACTED]');
    expect(redactSensitiveQueryParams('/x?ACCESS_TOKEN=abc')).toBe('/x?ACCESS_TOKEN=[REDACTED]');
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
