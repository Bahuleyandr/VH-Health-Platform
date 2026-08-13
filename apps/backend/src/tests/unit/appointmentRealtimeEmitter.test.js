import { jest } from '@jest/globals';
const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({ broadcast, sendToUser: jest.fn() }));
const { emitAppointmentEvent, emitQueuePosition } = await import('../../utils/websocket/realtimeEmitter.js');
const { authorizeChannel } = await import('../../utils/websocket/channelAuth.js');

describe('emitAppointmentEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  test('broadcasts on staff:appointments with the kind + explicit tenantId', () => {
    emitAppointmentEvent('confirm', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('staff:appointments', expect.objectContaining({ kind: 'confirm' }), { tenantId: 't1' });
  });
  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitAppointmentEvent('walk-in-created', { tenantId: 't1' })).not.toThrow();
  });
  test('still notifies the patient when the staff broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('staff fanout down'); });
    emitAppointmentEvent('confirm', {
      tenantId: 't1',
      patientUid: 'patient-uid-1',
      appointmentId: 42,
      status: 'CONFIRMED',
    });
    expect(broadcast).toHaveBeenCalledWith(
      'patient:patient-uid-1:appointments',
      expect.objectContaining({ appointmentId: '42', status: 'CONFIRMED' }),
      { tenantId: 't1' },
    );
  });
  test('addresses patient appointment and queue channels by uid with tenant scope', () => {
    emitAppointmentEvent('confirm', {
      tenantId: 't1',
      patientUid: 'patient-uid-1',
      appointmentId: 42,
      status: 'CONFIRMED',
    });
    emitQueuePosition({
      tenantId: 't1',
      patientUid: 'patient-uid-1',
      appointmentId: 42,
      position: 3,
      etaMinutes: 25,
    });

    expect(broadcast).toHaveBeenCalledWith(
      'patient:patient-uid-1:appointments',
      expect.objectContaining({
        kind: 'confirm',
        appointmentId: '42',
        status: 'CONFIRMED',
      }),
      { tenantId: 't1' },
    );
    expect(broadcast).toHaveBeenCalledWith(
      'patient:patient-uid-1:queue',
      expect.objectContaining({
        appointmentId: '42',
        position: 3,
        etaMinutes: 25,
      }),
      { tenantId: 't1' },
    );
  });
  test('patient subscription ownership uses the JWT uid, not numeric patient id', () => {
    const uid = '33333333-3333-4333-8333-333333333333';
    expect(authorizeChannel(`patient:${uid}:appointments`, {
      role: 'PATIENT',
      userId: uid,
    })).toEqual({ allowed: true });
    expect(authorizeChannel('patient:51:appointments', {
      role: 'PATIENT',
      userId: uid,
    })).toEqual({ allowed: false, reason: 'Not your channel' });
    expect(authorizeChannel('appointment-updates', {
      role: 'PATIENT',
      userId: uid,
    })).toEqual({ allowed: false, reason: 'Staff-only legacy channel' });
  });
});
