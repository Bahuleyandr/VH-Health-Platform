import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('admin:daily-ops channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['admin:daily-ops']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:daily-ops'].roles).toBe('admin');
  });

  test('is allowed for admins and denied for non-admins', () => {
    expect(authorizeChannel('admin:daily-ops', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('admin:daily-ops', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
    expect(authorizeChannel('admin:daily-ops', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(false);
  });
});
