// src/tests/unit/sosActingAsSelfService.test.js
//
// SOS self-service identity under an acting-as delegation hop (2026-08-18 P1
// defense in depth). An SOS — and its emergency contact / medical info /
// my-alerts / cancel — belongs to the person physically holding the phone.
// When `applyActingAsHop` has rewritten req.user to a minor dependent (whose
// users.phone is the synthetic `DEPEND-<hex>`), the SOS controller must
// resolve the SELF identity from the pre-hop guardian preserved on
// req.acting; before this fix the guardian's own body phone could never
// match the dependent's synthetic token phone, so every hospital-side SOS
// alert 403'd ("Can only manage SOS data for yourself") while a dependent
// profile was active. The patient app also stops sending X-Acting-As-Uid on
// /sos/* (vhhealth_core actingAsExemptPathPrefixes); this backend guard
// keeps SOS alive for older clients still sending it.
//
// Fully mocked — no DB / network.

import { jest } from '@jest/globals';

const createAlertMock = jest.fn();
const cancelAlertMock = jest.fn();
const getMyAlertsMock = jest.fn();
const getMedicalInfoMock = jest.fn();
const updateEmergencyContactsMock = jest.fn();
const getEmergencyContactsMock = jest.fn();
const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/sosService.js', () => ({
  createAlert: createAlertMock,
  cancelAlert: cancelAlertMock,
  getMyAlerts: getMyAlertsMock,
  getMedicalInfo: getMedicalInfoMock,
  updateEmergencyContacts: updateEmergencyContactsMock,
  getEmergencyContacts: getEmergencyContactsMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  resolveTenantOrThrow: () => '00000000-0000-0000-0000-000000000001',
}));

const {
  createEmergencyAlert,
  cancelAlert,
  getMyAlerts,
  getMedicalInfo,
} = await import('../../controllers/sosController.js');

const GUARDIAN_UID = '11111111-2222-3333-4444-555555555555';
const DEPENDENT_UID = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const GUARDIAN_PHONE = '+919876543210';

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** req as it looks AFTER applyActingAsHop rewrote req.user to the dependent. */
function actingAsReq(overrides = {}) {
  return {
    user: {
      uid: DEPENDENT_UID,
      id: 42,
      role: 'PATIENT',
      phone: 'DEPEND-1A2B3C4D',
    },
    acting: {
      actorUid: GUARDIAN_UID,
      actorId: 7,
      actorRole: 'PATIENT',
      actorRawRole: 'PATIENT',
      actorPhone: GUARDIAN_PHONE,
      actorEmail: null,
    },
    headers: {},
    socket: { remoteAddress: '10.0.0.1' },
    body: {},
    params: {},
    query: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SOS self-service identity under acting-as', () => {
  test('alert with the guardian body phone succeeds and binds to the guardian', async () => {
    createAlertMock.mockResolvedValue({ id: 1 });
    const req = actingAsReq({
      body: { phone: '9876543210', latitude: 12.97, longitude: 77.59 },
    });
    const res = makeRes();

    await createEmergencyAlert(req, res);

    expect(createAlertMock).toHaveBeenCalledTimes(1);
    const alertData = createAlertMock.mock.calls[0][0];
    // Pre-hop GUARDIAN identity, not the dependent's synthetic phone.
    expect(alertData.phone).toBe(GUARDIAN_PHONE);
    expect(alertData.createdBy).toBe(GUARDIAN_UID);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  test('alert for a THIRD party still 403s under acting-as', async () => {
    const req = actingAsReq({
      body: { phone: '9111111111', latitude: 12.97, longitude: 77.59 },
    });
    const res = makeRes();

    await createEmergencyAlert(req, res);

    expect(createAlertMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('without a hop the bearer phone still wins (no behaviour change)', async () => {
    createAlertMock.mockResolvedValue({ id: 2 });
    const req = actingAsReq({ body: { phone: '9876543210' } });
    delete req.acting;
    req.user = { uid: GUARDIAN_UID, role: 'PATIENT', phone: GUARDIAN_PHONE };
    const res = makeRes();

    await createEmergencyAlert(req, res);

    expect(createAlertMock).toHaveBeenCalledTimes(1);
    expect(createAlertMock.mock.calls[0][0].phone).toBe(GUARDIAN_PHONE);
  });

  test('a mismatched body phone without a hop still 403s (guard not weakened)', async () => {
    const req = actingAsReq({ body: { phone: '9111111111' } });
    delete req.acting;
    req.user = { uid: GUARDIAN_UID, role: 'PATIENT', phone: GUARDIAN_PHONE };
    const res = makeRes();

    await createEmergencyAlert(req, res);

    expect(createAlertMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('cancelAlert keys off the pre-hop guardian uid', async () => {
    cancelAlertMock.mockResolvedValue({ cancelled: true });
    const req = actingAsReq({ params: { alertId: '9' } });
    const res = makeRes();

    await cancelAlert(req, res);

    expect(cancelAlertMock).toHaveBeenCalledWith('9', GUARDIAN_UID);
  });

  test('getMyAlerts keys off the pre-hop guardian uid', async () => {
    getMyAlertsMock.mockResolvedValue([]);
    const req = actingAsReq();
    const res = makeRes();

    await getMyAlerts(req, res);

    expect(getMyAlertsMock).toHaveBeenCalledWith(
      GUARDIAN_UID,
      expect.objectContaining({ limit: expect.any(Number) }),
    );
  });

  test('getMedicalInfo returns the guardian\'s record, not the dependent\'s', async () => {
    getMedicalInfoMock.mockResolvedValue({ blood_group: 'O+' });
    const req = actingAsReq();
    const res = makeRes();

    await getMedicalInfo(req, res);

    expect(getMedicalInfoMock).toHaveBeenCalledWith(GUARDIAN_UID);
  });

  test('self-service uid falls back to the bearer when no hop is active', async () => {
    getMedicalInfoMock.mockResolvedValue({ blood_group: 'O+' });
    const req = actingAsReq();
    delete req.acting;
    req.user = { uid: GUARDIAN_UID, role: 'PATIENT', phone: GUARDIAN_PHONE };
    const res = makeRes();

    await getMedicalInfo(req, res);

    expect(getMedicalInfoMock).toHaveBeenCalledWith(GUARDIAN_UID);
  });
});
