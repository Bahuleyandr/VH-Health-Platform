import {
  authorizeChannel,
  CHANNEL_CATALOG,
} from '../../utils/websocket/channelAuth.js';

describe('transport realtime channel', () => {
  it('catalogs staff:transport and keeps it staff-only', () => {
    expect(CHANNEL_CATALOG['staff:transport']).toMatchObject({
      roles: 'staff',
    });
    expect(authorizeChannel('staff:transport', { role: 'DRIVER', userId: 'porter-1' })).toEqual({ allowed: true });
    expect(authorizeChannel('staff:transport', { role: 'RECEPTIONIST', userId: 'front-desk-1' })).toEqual({ allowed: true });
    expect(authorizeChannel('staff:transport', { role: 'PATIENT', userId: 'patient-1' })).toEqual({
      allowed: false,
      reason: 'Staff-only channel',
    });
  });
});
