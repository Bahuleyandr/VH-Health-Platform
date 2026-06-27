import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('admin:ed-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['admin:ed-board']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:ed-board'].roles).toBe('admin');
  });

  test('is allowed for admins and denied for non-admins', () => {
    expect(authorizeChannel('admin:ed-board', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('admin:ed-board', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
    expect(authorizeChannel('admin:ed-board', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(false);
  });
});
