import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const recordVitalsMock = jest.fn();
const correctVitalsMock = jest.fn();
const logPhiAccessMock = jest.fn();
const recordPatientWearableVitalMock = jest.fn();
const correctPatientWearableVitalMock = jest.fn();

const TENANT = '55555555-5555-4555-8555-555555555555';
const PATIENT_UID = 'a1111111-2222-4333-8444-555555550003';
const NURSE_UID = 'b2222222-3333-4444-8555-666666660004';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/growthPercentileService.js', () => ({
  computeGrowthSnapshot: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../services/gamification/pointService.js', () => ({
  awardVitalsPoints: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/health/healthRecordService.js', () => ({}));
jest.unstable_mockModule('../../services/health/patientHealthService.js', () => ({}));
jest.unstable_mockModule('../../services/health/patientWearableVitalsService.js', () => ({
  correctPatientWearableVital: correctPatientWearableVitalMock,
  recordPatientWearableVital: recordPatientWearableVitalMock,
}));
jest.unstable_mockModule('../../services/emr/vitalsChartService.js', () => ({
  recordVitals: recordVitalsMock,
  correctVitals: correctVitalsMock,
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

const {
  correctPatientWearableVitals,
  recordPatientVitals,
  recordStaffVitals,
  updateStaffVitals,
} = await import(
  '../../controllers/health/patientHealthController.js'
);

function responseDouble() {
  return {
    req: { id: 'req-1' },
    statusCode: 200,
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
}

describe('recordPatientVitals wearable sources', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    logPhiAccessMock.mockReset();
    recordPatientWearableVitalMock.mockReset();
    correctPatientWearableVitalMock.mockReset();
    recordPatientWearableVitalMock.mockResolvedValue({
      row: {
        id: 902,
        recorded_at: new Date('2026-08-11T03:00:00.000Z'),
        source: 'health_connect',
        source_record_id: 'HEART_RATE:sample-902',
        recorded_at_source: new Date('2026-08-11T02:59:00.000Z'),
      },
      created: true,
      duplicate: false,
      receipt: {
        sourceRecordId: 'HEART_RATE:sample-902',
        sourceRecordHash: 'a'.repeat(64),
        duplicate: false,
      },
    });
  });

  it('accepts Android Health Connect as a wearable source', async () => {
    const req = {
      body: {
        heartRate: 72,
        source: 'health_connect',
        sourceRecordId: 'HEART_RATE:sample-902',
        recordedAtSource: '2026-08-11T02:59:00.000Z',
      },
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-health-connect',
    };
    const res = responseDouble();

    await recordPatientVitals(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 902,
      source: 'health_connect',
      sourceRecordId: 'HEART_RATE:sample-902',
    });
    expect(recordPatientWearableVitalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      heartRate: 72,
      source: 'health_connect',
      sourceRecordId: 'HEART_RATE:sample-902',
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    }));
  });

  it('rejects an impossible wearable value before the clinical write', async () => {
    const req = {
      body: {
        heartRate: 999,
        source: 'health_connect',
        sourceRecordId: 'HEART_RATE:impossible',
        recordedAtSource: '2026-08-11T02:59:00.000Z',
      },
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-impossible-health-connect',
    };
    const res = responseDouble();

    await recordPatientVitals(req, res);

    expect(res.statusCode).toBe(400);
    expect(recordPatientWearableVitalMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty blood pressure object', { bloodPressure: {} }],
    ['a wearable-tagged mood-only check-in', { mood: 'good' }],
  ])('rejects %s instead of creating an empty wearable clinical event', async (_label, body) => {
    const req = {
      body: {
        ...body,
        source: 'health_connect',
        sourceRecordId: 'empty-sample',
        recordedAtSource: '2026-08-11T02:59:00.000Z',
      },
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-empty-health-connect',
    };
    const res = responseDouble();

    await recordPatientVitals(req, res);

    expect(res.statusCode).toBe(400);
    expect(recordPatientWearableVitalMock).not.toHaveBeenCalled();
  });

  it('rejects an impossible wearable weight before the clinical write', async () => {
    const req = {
      body: {
        weight: 900,
        source: 'health_connect',
        sourceRecordId: 'WEIGHT:impossible',
        recordedAtSource: '2026-08-11T02:59:00.000Z',
      },
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-impossible-weight',
    };
    const res = responseDouble();

    await recordPatientVitals(req, res);

    expect(res.statusCode).toBe(400);
    expect(recordPatientWearableVitalMock).not.toHaveBeenCalled();
  });

  it('routes a receipt mismatch through the explicit patient correction service', async () => {
    correctPatientWearableVitalMock.mockResolvedValue({
      row: {
        id: 902,
        recorded_at: new Date('2026-08-11T03:00:00.000Z'),
        source: 'health_connect',
        source_record_id: 'HEART_RATE:sample-902',
        recorded_at_source: new Date('2026-08-11T02:59:00.000Z'),
      },
      corrected: true,
      duplicate: false,
      receipt: {
        sourceRecordId: 'HEART_RATE:sample-902',
        sourceRecordHash: 'a'.repeat(64),
        corrected: true,
      },
    });
    const req = {
      params: { sourceRecordId: 'HEART_RATE:sample-902' },
      body: {
        heartRate: 72,
        source: 'health_connect',
        recordedAtSource: '2026-08-11T02:59:00.000Z',
      },
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-correct-health-connect',
    };
    const res = responseDouble();

    await correctPatientWearableVitals(req, res);

    expect(res.statusCode).toBe(200);
    expect(correctPatientWearableVitalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT_UID,
        heartRate: 72,
        sourceRecordId: 'HEART_RATE:sample-902',
      }),
    );
    expect(res.body.data.syncReceipt).toMatchObject({ corrected: true });
  });
});

describe('recordStaffVitals canonical adapter', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    recordVitalsMock.mockReset();
    correctVitalsMock.mockReset();
    logPhiAccessMock.mockReset();
    queryRawMock.mockResolvedValue([{
      id: 77,
      uid: PATIENT_UID,
      birthday: null,
      gender: null,
      tenant_id: TENANT,
      role: 'PATIENT',
    }]);
    recordVitalsMock.mockResolvedValue({
      vitals: {
        id: 901,
        patient_uid: PATIENT_UID,
        recorded_at: new Date('2026-08-11T03:00:00.000Z'),
        source: 'staff',
        encounter_uid: null,
      },
      news2: { id: 81, total_score: 3 },
      alerts: [],
      growth: null,
    });
    correctVitalsMock.mockResolvedValue({
      id: 901,
      patient_uid: PATIENT_UID,
      systolic_bp: 0,
      diastolic_bp: 0,
      heart_rate: 0,
      temperature: 12,
      blood_glucose: 0,
      weight_kg: 70,
      spo2: 0,
      recorded_at: new Date('2026-08-11T03:00:00.000Z'),
      source: 'staff',
    });
  });

  it('maps the legacy request into recordVitals instead of patient_vitals', async () => {
    const req = {
      body: {
        patient_id: 77,
        vital_signs: {
          blood_pressure: { systolic: 0, diastolic: 0 },
          pulse: 0,
          temperature: 53.6,
          spo2: 0,
        },
        measurements: { weight: 70 },
        notes: 'peri-arrest entry',
      },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-1',
    };
    const res = responseDouble();

    await recordStaffVitals(req, res);

    expect(recordVitalsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT,
      patient_uid: PATIENT_UID,
      patient_id: 77,
      heart_rate: 0,
      systolic_bp: 0,
      diastolic_bp: 0,
      temperature: 53.6,
      temperature_unit: 'F',
      spo2: 0,
      weight_kg: 70,
      notes: 'peri-arrest entry',
      recorded_by: NURSE_UID,
      source: 'staff',
    }));
    expect(
      queryRawMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO patient_vitals')),
    ).toBe(false);
    expect(res.body.data).toMatchObject({
      id: 901,
      patientId: 77,
      patientUid: PATIENT_UID,
      source: 'staff',
      news2: { id: 81, total_score: 3 },
    });
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT_UID,
      action: 'CREATE',
      tenantId: TENANT,
    }));
  });

  it('preserves full decimal values supported by canonical numeric columns', async () => {
    const req = {
      body: {
        patient_id: '77',
        vital_signs: { pulse: '72.5', spo2: '98.25' },
        measurements: { weight: '70.25' },
      },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-decimal',
    };
    const res = responseDouble();

    await recordStaffVitals(req, res);

    expect(recordVitalsMock).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: 77,
      heart_rate: 72.5,
      spo2: 98.25,
      weight_kg: 70.25,
    }));
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['trailing junk', '72oops', /heart_rate must be a number/],
    ['non-finite text', 'Infinity', /heart_rate must be a number/],
    ['numeric overflow', '1e999', /heart_rate must be a finite number/],
  ])('POST rejects %s instead of partially coercing it', async (_label, pulse, message) => {
    const req = {
      body: { patient_id: 77, vital_signs: { pulse } },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-invalid-post',
    };
    const res = responseDouble();

    await recordStaffVitals(req, res);

    expect(recordVitalsMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
  });

  it('POST rejects a partially numeric patient ID', async () => {
    const req = {
      body: { patient_id: '77oops', vital_signs: { pulse: 72 } },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-invalid-patient-id',
    };
    const res = responseDouble();

    await recordStaffVitals(req, res);

    expect(queryRawMock).not.toHaveBeenCalled();
    expect(recordVitalsMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-patient target before the canonical clinical write', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 77,
      uid: PATIENT_UID,
      birthday: null,
      gender: null,
      tenant_id: TENANT,
      role: 'NURSING_STAFF',
    }]);
    const req = {
      body: {
        patient_id: 77,
        vital_signs: { pulse: 72 },
      },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-non-patient-target',
    };
    const res = responseDouble();

    await recordStaffVitals(req, res);

    expect(recordVitalsMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/patient_id must identify a patient/);
  });

  it('corrects the canonical ID returned by create instead of patient_vitals', async () => {
    const req = {
      params: { id: '901' },
      body: {
        vital_signs: {
          blood_pressure: { systolic: 0, diastolic: 0 },
          temperature: 53.6,
        },
      },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-2',
    };
    const res = responseDouble();

    await updateStaffVitals(req, res);

    expect(correctVitalsMock).toHaveBeenCalledWith(901, expect.objectContaining({
      systolic_bp: 0,
      diastolic_bp: 0,
      temperature: 53.6,
      temperature_unit: 'F',
      corrected_by: NURSE_UID,
      actor_role: 'NURSING_STAFF',
      tenantId: TENANT,
    }));
    expect(
      queryRawMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE patient_vitals')),
    ).toBe(false);
    expect(res.body.data).toMatchObject({
      id: 901,
      blood_pressure: { systolic: 0, diastolic: 0 },
      temperature: 53.6,
    });
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT_UID,
      action: 'UPDATE',
      tenantId: TENANT,
    }));
  });

  it.each([
    ['trailing junk', '80oops', /heart_rate must be a number/],
    ['non-finite text', 'NaN', /heart_rate must be a number/],
    ['numeric overflow', '1e999', /heart_rate must be a finite number/],
  ])('correction rejects %s instead of partially coercing it', async (_label, pulse, message) => {
    const req = {
      params: { id: '901' },
      body: { vital_signs: { pulse } },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-invalid-correction',
    };
    const res = responseDouble();

    await updateStaffVitals(req, res);

    expect(correctVitalsMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
  });

  it('correction rejects a partially numeric canonical ID', async () => {
    const req = {
      params: { id: '901oops' },
      body: { vital_signs: { pulse: 72 } },
      user: { uid: NURSE_UID, role: 'NURSING_STAFF' },
      tenantId: TENANT,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      id: 'req-invalid-vital-id',
    };
    const res = responseDouble();

    await updateStaffVitals(req, res);

    expect(correctVitalsMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

});
