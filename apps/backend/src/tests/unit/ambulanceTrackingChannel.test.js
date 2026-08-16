import {
  authorizeChannel,
  CHANNEL_CATALOG,
} from '../../utils/websocket/channelAuth.js';

describe('ambulance tracking realtime channel', () => {
  it('catalogs staff:ambulance-tracking and keeps it staff-only', () => {
    expect(CHANNEL_CATALOG['staff:ambulance-tracking']).toMatchObject({
      roles: 'staff',
    });
    expect(authorizeChannel('staff:ambulance-tracking', { role: 'DRIVER', userId: 'crew-1' }))
      .toEqual({ allowed: true });
    expect(authorizeChannel('staff:ambulance-tracking', { role: 'NURSING_STAFF', userId: 'ed-1' }))
      .toEqual({ allowed: true });
    expect(authorizeChannel('staff:ambulance-tracking', { role: 'PATIENT', userId: 'patient-1' }))
      .toEqual({
        allowed: false,
        reason: 'Staff-only channel',
      });
  });
});
