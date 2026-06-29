import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:appointments channel', () => {
  test('is listed in the channel catalog', () => {
    expect(CHANNEL_CATALOG['staff:appointments']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:appointments'].roles).toBe('staff');
  });
  test('allowed for the front-desk receptionist (isStaff, NOT clinical) + doctor + nurse + admin, denied for patient', () => {
    expect(authorizeChannel('staff:appointments', { role: 'RECEPTIONIST', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'DOCTOR', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'NURSING_STAFF', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:appointments', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });
  test('SUPER_ADMIN may subscribe (slice-9 bypass)', () => {
    expect(authorizeChannel('staff:appointments', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
