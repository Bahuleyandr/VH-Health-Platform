import { jest } from '@jest/globals';

const getAppointmentByIdMock = jest.fn();
const updateAppointmentStatusMock = jest.fn();
const validateStatusUpdateMock = jest.fn();
const logAuditMock = jest.fn();
const broadcastMock = jest.fn();
const sendToUserMock = jest.fn();

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/appointment/appointmentService.js', () => ({
  default: {
    getAppointmentById: getAppointmentByIdMock,
    updateAppointmentStatus: updateAppointmentStatusMock,
  },
}));

jest.unstable_mockModule('../../services/appointment/appointmentValidationService.js', () => ({
  default: {
    validateStatusUpdate: validateStatusUpdateMock,
  },
}));

jest.unstable_mockModule('../../services/gamification/pointService.js', () => ({
  awardAppointmentPoints: jest.fn().mockResolvedValue(undefined),
  awardOnTimeBonus: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../services/appointment/waitTimeService.js', () => ({
  getWaitingQueueForDoctor: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast: broadcastMock,
  sendToUser: sendToUserMock,
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitQueuePosition: jest.fn(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

const { updateAppointmentStatus } = await import(
  '../../controllers/appointment/appointmentStatusController.js'
);

function makeReq(overrides = {}) {
  return {
    id: 'req-status-audit-1',
    params: { id: '77' },
    body: { status: 'IN_PROGRESS', notes: 'Patient at counter' },
    tenantId: '00000000-0000-4000-8000-000000000001',
    user: {
      id: 9,
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'RECEPTIONIST',
      name: 'Reception Desk',
      deviceType: 'desktop',
    },
    ...overrides,
  };
}

function makeRes(req) {
  return {
    req,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('appointment status audit context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateStatusUpdateMock.mockReturnValue({
      valid: true,
      status: 'IN_PROGRESS',
    });
    getAppointmentByIdMock.mockResolvedValue({
      id: 77,
      uid: '22222222-2222-4222-8222-222222222222',
      patient_id: 51,
      patient_uid: '33333333-3333-4333-8333-333333333333',
      doctor_id: 12,
      status: 'CONFIRMED',
    });
    updateAppointmentStatusMock.mockResolvedValue({
      id: 77,
      uid: '22222222-2222-4222-8222-222222222222',
      patient_id: 51,
      patient_uid: '33333333-3333-4333-8333-333333333333',
      doctor_id: 12,
      status: 'IN_PROGRESS',
    });
    logAuditMock.mockResolvedValue(undefined);
  });

  it('attaches patient context so route-level PHI logging can identify the patient', async () => {
    const req = makeReq();
    const res = makeRes(req);

    await updateAppointmentStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(req.phiContext).toEqual(expect.objectContaining({
      appointmentId: 77,
      appointment_id: 77,
      patientId: 51,
      patient_id: 51,
      patientUid: '33333333-3333-4333-8333-333333333333',
      patient_uid: '33333333-3333-4333-8333-333333333333',
    }));
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_STATUS_UPDATED',
      expect.objectContaining({
        appointment_id: 77,
        appointment_uid: '22222222-2222-4222-8222-222222222222',
        patient_id: 51,
        patient_uid: '33333333-3333-4333-8333-333333333333',
        doctor_id: 12,
        prior_status: 'CONFIRMED',
        updated_status: 'IN_PROGRESS',
        note_present: true,
      }),
      { resource: 'appointment', resourceId: '77' },
    );
  });
});
