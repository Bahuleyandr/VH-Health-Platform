import {
  normalizeCanonicalIdentity,
  resolveCanonicalTokenIdentity,
} from '../../utils/tokenIdentity.js';

const UID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const CANONICAL_UID = UID.toLowerCase();
const HASURA = 'https://hasura.io/jwt/claims';

describe('canonical token identity resolution', () => {
  test.each([
    ['uid', { uid: UID }],
    ['Hasura', { [HASURA]: { 'x-hasura-user-id': UID } }],
    ['user_id', { user_id: UID }],
    ['userId', { userId: UID }],
    ['sub', { sub: UID }],
    ['id', { id: UID }],
  ])('accepts the %s identity alias alone', (_label, decoded) => {
    expect(resolveCanonicalTokenIdentity(decoded)).toEqual({
      identity: CANONICAL_UID,
      conflict: false,
    });
  });

  test('accepts identical strong aliases after trim and UUID case normalization', () => {
    expect(resolveCanonicalTokenIdentity({
      uid: ` ${UID} `,
      user_id: CANONICAL_UID,
      userId: UID,
      [HASURA]: { 'x-hasura-user-id': CANONICAL_UID },
    })).toEqual({ identity: CANONICAL_UID, conflict: false });
  });

  test.each([
    ['Hasura', { [HASURA]: { 'x-hasura-user-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }],
    ['user_id', { user_id: 'external-user' }],
    ['userId', { userId: 'external-user' }],
  ])('fails closed when uid conflicts with %s', (_label, extra) => {
    expect(resolveCanonicalTokenIdentity({ uid: UID, ...extra })).toEqual({
      identity: null,
      conflict: true,
    });
  });

  test('keeps provider sub as a fallback when a strong Hasura app identity exists', () => {
    expect(resolveCanonicalTokenIdentity({
      sub: 'oidc-provider-subject',
      [HASURA]: { 'x-hasura-user-id': UID },
    })).toEqual({ identity: CANONICAL_UID, conflict: false });
  });

  test('allows signed numeric DB-ID projections beside a canonical UUID', () => {
    expect(resolveCanonicalTokenIdentity({
      uid: UID,
      user_id: 41,
      userId: '41',
      id: 41,
    })).toEqual({ identity: CANONICAL_UID, conflict: false });
  });

  test('keeps sub-only non-UUID behavior and ignores a numeric DB-ID projection', () => {
    expect(resolveCanonicalTokenIdentity({ sub: 'legacy-user', id: 42 })).toEqual({
      identity: 'legacy-user',
      conflict: false,
    });
  });

  test('fails closed on two distinct fallback identities', () => {
    expect(resolveCanonicalTokenIdentity({ sub: 'legacy-user', id: 'other-user' })).toEqual({
      identity: null,
      conflict: true,
    });
  });

  test('normalizes UUID keys but preserves case-sensitive non-UUID realms', () => {
    expect(normalizeCanonicalIdentity(` ${UID} `)).toBe(CANONICAL_UID);
    expect(normalizeCanonicalIdentity(' Provider-Subject ')).toBe('Provider-Subject');
  });
});
