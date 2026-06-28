import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:icu-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:icu-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:icu-board'].roles).toBe('staff');
  });

  test('is allowed for ICU staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:icu-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:icu-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
