import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:lab channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:lab']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:lab'].roles).toBe('staff');
  });

  test('is allowed for lab staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:lab', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'LAB_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:lab', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
