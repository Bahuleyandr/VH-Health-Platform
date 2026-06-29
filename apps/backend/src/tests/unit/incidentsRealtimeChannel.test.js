import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:incidents channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:incidents']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:incidents'].roles).toBe('staff');
  });

  test('is allowed for HR + clinical staff + admins, denied for patients', () => {
    expect(authorizeChannel('staff:incidents', { role: 'HR_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:incidents', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});

describe('SUPER_ADMIN channel bypass', () => {
  test('SUPER_ADMIN may subscribe to staff:incidents (isStaff is false for it)', () => {
    expect(authorizeChannel('staff:incidents', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
  test('the bypass is general — SUPER_ADMIN may subscribe to any channel namespace', () => {
    expect(authorizeChannel('staff:beds', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
    expect(authorizeChannel('admin:anything', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
    expect(authorizeChannel('patient:other-uid:vitals', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
  test('a non-super-admin is still gated normally', () => {
    expect(authorizeChannel('admin:anything', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(false);
  });
});
