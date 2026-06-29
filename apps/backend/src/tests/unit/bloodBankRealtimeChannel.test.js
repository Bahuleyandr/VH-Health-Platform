import { authorizeChannel, CHANNEL_CATALOG } from '../../utils/websocket/channelAuth.js';

describe('staff:blood-bank channel', () => {
  test('is listed in the channel catalog for discovery', () => {
    expect(CHANNEL_CATALOG['staff:blood-bank']).toBeDefined();
    expect(CHANNEL_CATALOG['staff:blood-bank'].roles).toBe('staff');
  });

  test('allowed for the blood-bank technician (isStaff, NOT isClinical) + nurses + doctors + admin, denied for patients', () => {
    // BLOOD_BANK_TECHNICIAN is the key case: isStaff true but isClinical false,
    // so staff:clinical:* would wrongly deny it — staff: must admit it.
    expect(authorizeChannel('staff:blood-bank', { role: 'BLOOD_BANK_TECHNICIAN', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'NURSING_STAFF', userId: '2' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'DOCTOR', userId: '3' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'ADMIN', userId: '4' }).allowed).toBe(true);
    expect(authorizeChannel('staff:blood-bank', { role: 'PATIENT', userId: '5' }).allowed).toBe(false);
  });

  test('SUPER_ADMIN may subscribe (slice-9 channel bypass)', () => {
    expect(authorizeChannel('staff:blood-bank', { role: 'SUPER_ADMIN', userId: '9' }).allowed).toBe(true);
  });
});
