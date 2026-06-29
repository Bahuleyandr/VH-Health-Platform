import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('clinical-alerts board channels', () => {
  test('both channels are in the catalog with staff scope', () => {
    expect(CHANNEL_CATALOG['staff:clinical-alerts']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:clinical-alerts'].roles).toBe('staff');
    expect(CHANNEL_CATALOG['staff:code-blue']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:code-blue'].roles).toBe('staff');
  });

  test('allowed for clinical staff + admins, denied for patients', () => {
    for (const ch of ['staff:clinical-alerts', 'staff:code-blue']) {
      expect(authorizeChannel(ch, { role: 'NURSING_STAFF', userId: '1' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'ADMIN', userId: '3' }).allowed).toBe(true);
      expect(authorizeChannel(ch, { role: 'PATIENT', userId: '4' }).allowed).toBe(false);
    }
  });
});
