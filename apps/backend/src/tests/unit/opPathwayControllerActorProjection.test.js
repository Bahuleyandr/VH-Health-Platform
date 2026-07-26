import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000001';

const getAppointmentPathwayWork = jest.fn();
const success = jest.fn((_res, data) => data);
const relayAppError = jest.fn();

jest.unstable_mockModule('../../services/appointment/opPathwayWorkService.js', () => ({
  getAppointmentPathwayWork,
}));
jest.unstable_mockModule('../../services/appointment/opInpatientTransferService.js', () => ({
  acceptOpInpatientTransfer: jest.fn(),
  requestOpInpatientTransfer: jest.fn(),
}));
jest.unstable_mockModule('../../services/appointment/opVisitClosureEvidenceService.js', () => ({
  recordOpVisitClosureEvidence: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: jest.fn(() => TENANT_ID),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/responseHelper.js', () => ({
  relayAppError,
  success,
}));

const { getPathwayWork } = await import(
  '../../controllers/appointment/appointmentPathwayController.js'
);

beforeEach(() => {
  getAppointmentPathwayWork.mockReset();
  success.mockClear();
  relayAppError.mockReset();
});

test('passes the authenticated actor identity into the OP work projection', async () => {
  const projection = { prior_admission_pending_results: [] };
  getAppointmentPathwayWork.mockResolvedValueOnce(projection);
  const req = {
    params: { id: '71' },
    user: { uid: ACTOR_UID, role: 'doctor' },
  };
  const res = {};

  await getPathwayWork(req, res);

  expect(getAppointmentPathwayWork).toHaveBeenCalledWith({
    tenantId: TENANT_ID,
    appointmentId: '71',
    actorUid: ACTOR_UID,
    actorRole: 'doctor',
  });
  expect(success).toHaveBeenCalledWith(
    res,
    projection,
    'Appointment pathway work retrieved',
  );
  expect(relayAppError).not.toHaveBeenCalled();
});
