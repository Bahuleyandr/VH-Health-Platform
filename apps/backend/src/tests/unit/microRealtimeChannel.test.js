import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:micro channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:micro']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:micro'].roles).toBe('staff');
  });

  test('is allowed for lab/clinical staff + admins and denied for patients', () => {
    expect(authorizeChannel('staff:micro', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'LAB_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:micro', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });
});
