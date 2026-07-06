import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('admin:teleconsult-ops channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['admin:teleconsult-ops']).toBeDefined();
    expect(CHANNEL_CATALOG['admin:teleconsult-ops'].roles).toBe('admin');
  });

  test('is allowed for admins and denied for non-admins', () => {
    expect(authorizeChannel('admin:teleconsult-ops', { role: 'ADMIN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('admin:teleconsult-ops', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
    expect(authorizeChannel('admin:teleconsult-ops', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(false);
  });
});
