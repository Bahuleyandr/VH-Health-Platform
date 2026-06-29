import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:dialysis-board channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:dialysis-board']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:dialysis-board'].roles).toBe('staff');
  });

  test('allowed for clinical + nursing staff + admin, denied for patients', () => {
    expect(authorizeChannel('staff:dialysis-board', { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:dialysis-board', { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
  });

  test('SUPER_ADMIN may subscribe (slice-9 channel bypass)', () => {
    expect(authorizeChannel('staff:dialysis-board', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
