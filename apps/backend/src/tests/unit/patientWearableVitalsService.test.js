import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const queryRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

const TENANT = '55555555-5555-4555-8555-555555555555';
const PATIENT_UID = 'a1111111-2222-4333-8444-555555550003';
const SAMPLE_ID = 'HEART_RATE:2d9fc124-6111-4301-8842-c72202c11564';
const SAMPLE_HASH = createHash('sha256')
  .update(JSON.stringify([
    'health_connect',
    '2026-08-11T02:59:00.000Z',
    null,
    72,
    null,
    null,
    null,
    null,
  ]))
  .digest('hex');
const EVENT_KEY_HASH = createHash('sha256')
  .update(`${TENANT}\0${PATIENT_UID}\0health_connect\0${SAMPLE_ID}`)
  .digest('hex');

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const { recordPatientWearableVital } = await import(
  '../../services/health/patientWearableVitalsService.js'
);

describe('recordPatientWearableVital', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    setTenantTxMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    setTenantTxMock.mockImplementation(async (tenantId, work) => {
      expect(tenantId).toBe(TENANT);
      return work({ $queryRawUnsafe: queryRawMock });
    });
    recordCanonicalClinicalEventMock.mockResolvedValue({
      timeline: { id: 'timeline-1' },
      audit: { id: 'audit-1' },
    });
  });

  it('atomically inserts a tenant-scoped receipt and canonical clinical pair', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 902,
      tenant_id: TENANT,
      patient_uid: PATIENT_UID,
      heart_rate: 72,
      source: 'health_connect',
      source_record_id: SAMPLE_ID,
      recorded_at: new Date('2026-08-11T03:00:00.000Z'),
      recorded_at_source: new Date('2026-08-11T02:59:00.000Z'),
    }]);

    const result = await recordPatientWearableVital({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      actorRole: 'PATIENT',
      heartRate: 72,
      source: 'health_connect',
      sourceRecordId: SAMPLE_ID,
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    });

    expect(result).toMatchObject({ created: true, duplicate: false });
    expect(queryRawMock.mock.calls[0][0]).toContain(
      'ON CONFLICT (tenant_id, patient_uid, source, source_record_id)',
    );
    expect(queryRawMock.mock.calls[0]).toEqual(expect.arrayContaining([
      TENANT,
      PATIENT_UID,
      'health_connect',
      SAMPLE_ID,
    ]));
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT_UID,
        eventType: 'vitals.recorded',
        eventStatus: 'unverified',
        sourceTable: 'patient_vitals',
        sourceId: '902',
        actorRole: 'PATIENT',
        occurredAt: new Date('2026-08-11T02:59:00.000Z'),
        visibleToPatient: true,
        timelineIdempotencyKey: `patient_vitals:${EVENT_KEY_HASH}:timeline`,
        auditIdempotencyKey: `patient_vitals:${EVENT_KEY_HASH}:audit`,
        tags: expect.arrayContaining([
          'patient-generated',
          'device-synced',
          'unverified',
        ]),
      }),
      { db: expect.objectContaining({ $queryRawUnsafe: queryRawMock }) },
    );
  });

  it('returns the durable receipt on retry without duplicating clinical effects', async () => {
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 902,
        tenant_id: TENANT,
        patient_uid: PATIENT_UID,
        heart_rate: 72,
        source: 'health_connect',
        source_record_id: SAMPLE_ID,
        source_record_hash: SAMPLE_HASH,
        recorded_at: new Date('2026-08-11T03:00:00.000Z'),
        recorded_at_source: new Date('2026-08-11T02:59:00.000Z'),
      }]);

    const result = await recordPatientWearableVital({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      actorRole: 'PATIENT',
      heartRate: 72,
      source: 'health_connect',
      sourceRecordId: SAMPLE_ID,
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    });

    expect(result).toMatchObject({ created: false, duplicate: true });
    expect(queryRawMock.mock.calls[1][0]).toContain('tenant_id = $1::uuid');
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects source record identifier reuse with a different payload', async () => {
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 902,
        tenant_id: TENANT,
        patient_uid: PATIENT_UID,
        heart_rate: 71,
        source: 'health_connect',
        source_record_id: SAMPLE_ID,
        source_record_hash: SAMPLE_HASH,
        recorded_at: new Date('2026-08-11T03:00:00.000Z'),
        recorded_at_source: new Date('2026-08-11T02:59:00.000Z'),
      }]);

    await expect(recordPatientWearableVital({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      actorRole: 'PATIENT',
      heartRate: 71,
      source: 'health_connect',
      sourceRecordId: SAMPLE_ID,
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WEARABLE_VITAL_RECEIPT_MISMATCH',
    });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('requires an explicit sample-scoped receipt instead of deriving one from clinical values', async () => {
    await expect(recordPatientWearableVital({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      actorRole: 'PATIENT',
      heartRate: 72,
      source: 'health_connect',
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'sourceRecordId is required for wearable vitals',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects a non-wearable source before opening the tenant transaction', async () => {
    await expect(recordPatientWearableVital({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      actorRole: 'PATIENT',
      heartRate: 72,
      source: 'manual',
      sourceRecordId: SAMPLE_ID,
      recordedAtSource: new Date('2026-08-11T02:59:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});
