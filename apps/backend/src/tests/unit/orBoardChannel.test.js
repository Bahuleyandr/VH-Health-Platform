import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:or-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:or-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:or-board'].roles).toBe('staff');
  });

  test('is allowed for theatre staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:or-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:or-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
