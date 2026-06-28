import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:ed-board channel (DELTA-002)', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:ed-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:ed-board'].roles).toBe('staff');
  });

  test('is allowed for ED staff + admins and denied for patients', () => {
    // DELTA-002: the ED board is staff-facing (route minRank STAFF), so the
    // realtime channel must admit clinical staff (and admins), not admins only.
    expect(authorizeChannel('staff:ed-board', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:ed-board', { role: 'DOCTOR', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:ed-board', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:ed-board', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
  });
});

describe('admin:beds catalog parity', () => {
  test('admin:beds is listed in the channel catalog', () => {
    expect(CHANNEL_CATALOG['admin:beds']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:beds'].roles).toBe('admin');
  });
});
