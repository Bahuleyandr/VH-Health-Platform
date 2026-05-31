import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const {
  createPatient,
  updatePatient,
} = await import('../../controllers/patient/patientSearchController.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function makeRes() {
  const res = {
    req: { id: 'req-test' },
    statusCode: 200,
    body: undefined,
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

function makeReq({ body = {}, params = {}, tenantId = TENANT_ID } = {}) {
  return {
    body,
    params,
    tenantId,
    user: {
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'RECEPTIONIST',
      tenantId,
    },
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('patientSearchController front-office mutations', () => {
  it('creates a tenant-scoped patient and normalizes phone/gender', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 51, uid: PATIENT_UID }])
      .mockResolvedValueOnce([{
        id: 51,
        uid: PATIENT_UID,
        name: 'Codex Test Patient',
        phone: '+919876543210',
        gender: 'female',
        birthday: '1990-01-02',
        address: 'Ward Road',
        hospital_number: 'VH-000051',
        age: 36,
        abha_address: null,
      }]);

    const res = makeRes();
    await createPatient(makeReq({
      body: {
        name: 'Codex Test Patient',
        phone: '9876543210',
        gender: 'Female',
        birthday: '1990-01-02',
        address: 'Ward Road',
      },
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        patient: {
          uid: PATIENT_UID,
          phone: '+919876543210',
          gender: 'female',
          hospital_number: 'VH-000051',
        },
      },
    });

    const [duplicateSql, tenantParam, phoneParam] = queryUnsafeMock.mock.calls[0];
    expect(duplicateSql).toContain('WHERE tenant_id = $1::uuid');
    expect(tenantParam).toBe(TENANT_ID);
    expect(phoneParam).toBe('+919876543210');

    const [insertSql, insertedPhone, insertedName, insertedGender] =
      queryUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('tenant_id');
    expect(insertedPhone).toBe('+919876543210');
    expect(insertedName).toBe('Codex Test Patient');
    expect(insertedGender).toBe('female');
  });

  it('rejects creating a patient on a phone owned by staff', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 9,
      uid: '33333333-3333-4333-8333-333333333333',
      phone: '+919876543210',
      name: 'Staff User',
      role: 'NURSING_STAFF',
    }]);

    const res = makeRes();
    await createPatient(makeReq({
      body: { name: 'Duplicate', phone: '9876543210' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({
      success: false,
      message: 'This phone number belongs to a non-patient account',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('updates only the requested tenant patient and rejects duplicate phone reuse', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 51,
        uid: PATIENT_UID,
        name: 'Old Name',
        phone: '+919876543210',
        role: 'PATIENT',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 51,
        uid: PATIENT_UID,
        name: 'New Name',
        phone: '+919812345678',
        hospital_number: 'VH-000051',
      }]);

    const res = makeRes();
    await updatePatient(makeReq({
      params: { uid: PATIENT_UID },
      body: { name: 'New Name', phone: '9812345678' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.data.patient).toMatchObject({
      uid: PATIENT_UID,
      name: 'New Name',
      phone: '+919812345678',
    });

    const [duplicateSql, duplicateTenant, duplicateUid, duplicatePhone] =
      queryUnsafeMock.mock.calls[1];
    expect(duplicateSql).toContain('tenant_id = $1::uuid');
    expect(duplicateTenant).toBe(TENANT_ID);
    expect(duplicateUid).toBe(PATIENT_UID);
    expect(duplicatePhone).toBe('+919812345678');

    const [updateSql, nameParam, phoneParam, uidParam, tenantParam] =
      queryUnsafeMock.mock.calls[2];
    expect(updateSql).toContain('WHERE uid = $3::uuid');
    expect(updateSql).toContain('AND tenant_id = $4::uuid');
    expect(nameParam).toBe('New Name');
    expect(phoneParam).toBe('+919812345678');
    expect(uidParam).toBe(PATIENT_UID);
    expect(tenantParam).toBe(TENANT_ID);
  });

  it('returns conflict when update phone belongs to another account', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 51,
        uid: PATIENT_UID,
        name: 'Old Name',
        phone: '+919876543210',
        role: 'PATIENT',
      }])
      .mockResolvedValueOnce([{
        uid: '44444444-4444-4444-8444-444444444444',
        role: 'PATIENT',
      }]);

    const res = makeRes();
    await updatePatient(makeReq({
      params: { uid: PATIENT_UID },
      body: { phone: '9812345678' },
    }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.message).toBe('Phone number is already used by another account');
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });
});
