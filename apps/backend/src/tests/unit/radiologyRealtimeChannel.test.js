import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:radiology channel', () => {
  test('is listed in the channel catalog', () => {
    expect(CHANNEL_CATALOG['staff:radiology']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:radiology'].roles).toBe('staff');
  });
  test('allowed for the radiographer (RADIOLOGY_STAFF, isStaff post-PR0, NOT clinical) + radiologist + doctor + admin, denied for patient', () => {
    expect(authorizeChannel('staff:radiology', { role: 'RADIOLOGY_STAFF', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'RADIOLOGIST', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'DOCTOR', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:radiology', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });
  test('SUPER_ADMIN may subscribe (slice-9 bypass)', () => {
    expect(authorizeChannel('staff:radiology', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
