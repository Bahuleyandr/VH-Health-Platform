import { jest } from '@jest/globals';

const getConsultationsByUidMock = jest.fn();
const filterRecordsByAccessMock = jest.fn();

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/record/recordService.js', () => ({
  getRecordsByUID: jest.fn(),
  getHealthRecordsByPhone: jest.fn(),
  createHealthRecord: jest.fn(),
  getConsultationsByUid: getConsultationsByUidMock,
}));

jest.unstable_mockModule('../../services/record/accessControlService.js', () => ({
  canCreateRecord: jest.fn(),
  filterRecordsByAccess: filterRecordsByAccessMock,
}));

jest.unstable_mockModule('../../services/record/auditService.js', () => ({
  logAuditEntry: jest.fn(),
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (value) => value,
}));

const { getMyConsultations } = await import(
  '../../controllers/record/patientRecordController.js'
);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('patientRecordController.getMyConsultations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    filterRecordsByAccessMock.mockImplementation((records) => records);
  });

  it('uses the authenticated patient uid instead of local patient id state', async () => {
    const req = {
      params: {},
      query: {},
      user: {
        uid: '8a1f15fa-c3e8-4f39-9f2f-2b2e3fc6e2fd',
        role: 'PATIENT',
      },
    };
    const res = makeRes();
    const records = [{ id: 1, title: 'OP consultation' }];
    getConsultationsByUidMock.mockResolvedValueOnce(records);

    await getMyConsultations(req, res);

    expect(req.params.uid).toBe(req.user.uid);
    expect(getConsultationsByUidMock).toHaveBeenCalledWith(req.user.uid, {
      type: undefined,
      limit: 50,
      offset: 0,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          records,
          count: 1,
          uid: req.user.uid,
        }),
      }),
    );
  });

  it('returns a clear 400 when the JWT has no uid', async () => {
    const req = { params: {}, query: {}, user: { role: 'PATIENT' } };
    const res = makeRes();

    await getMyConsultations(req, res);

    expect(getConsultationsByUidMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Patient UID not available in token',
      }),
    );
  });
});
