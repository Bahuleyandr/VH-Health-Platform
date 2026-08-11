import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DIAGNOSIS_PATIENT_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PATIENT_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const queryMock = jest.fn(async (sql, ...params) => {
  if (sql.includes('FROM oncology_completion_settings')) return [{ enabled: true }];
  if (sql.includes('FROM oncology_diagnoses')) {
    return [{ id: 73, patient_uid: DIAGNOSIS_PATIENT_UID, encounter_id: null }];
  }
  if (sql.includes('FROM ap_reports r')) {
    return [{
      id: 81,
      ap_case_id: 82,
      patient_uid: DIAGNOSIS_PATIENT_UID,
      encounter_id: null,
      malignancy_flag: 'malignant',
      synoptic_fields: {},
    }];
  }
  if (sql.includes('SELECT uid FROM users')) return [{ uid: params[1] }];
  if (sql.includes('INSERT INTO oncology_diagnoses')) {
    return [{ id: 101, patient_uid: params[1], pathology_report_id: params[7], encounter_id: null }];
  }
  if (sql.includes('INSERT INTO oncology_toxicity_events')) {
    return [{ id: 99, patient_uid: params[1], diagnosis_id: params[3], encounter_id: null }];
  }
  if (sql.includes('canonical_timeline_event_id')) return [];
  throw new Error(`Unexpected query: ${sql}`);
});

const txMock = { $queryRawUnsafe: queryMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenant: async (_tenantId, fn) => fn(txMock),
  setTenantTx: async (_tenantId, fn) => fn(txMock),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId,
}));

const {
  createOncologyDiagnosis,
  createToxicityEvent,
} = await import('../../services/oncology/oncologyCompletionService.js');

beforeEach(() => {
  queryMock.mockClear();
  recordCanonicalClinicalEventMock.mockClear();
});

describe('oncology toxicity patient identity', () => {
  test('rejects a caller patient that differs from the tenant-scoped diagnosis owner', async () => {
    await expect(createToxicityEvent({
      tenantId: TENANT_ID,
      patientUid: OTHER_PATIENT_UID,
      diagnosisId: 73,
      toxicityTerm: 'Nausea',
      ctcaeGrade: 2,
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' }))
      .rejects.toMatchObject({ code: 'ONCOLOGY_TOXICITY_PATIENT_MISMATCH' });

    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO oncology_toxicity_events'))).toBe(false);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  test('infers the patient from the diagnosis when patient_uid is omitted', async () => {
    const event = await createToxicityEvent({
      tenantId: TENANT_ID,
      diagnosisId: 73,
      toxicityTerm: 'Neuropathy',
      ctcaeGrade: 2,
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' });

    const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO oncology_toxicity_events'));
    expect(insert[2]).toBe(DIAGNOSIS_PATIENT_UID);
    expect(event.patient_uid).toBe(DIAGNOSIS_PATIENT_UID);
  });

  test('accepts an explicitly supplied equivalent UUID regardless of hex casing', async () => {
    const uppercasePatientUid = DIAGNOSIS_PATIENT_UID.toUpperCase();
    const event = await createToxicityEvent({
      tenantId: TENANT_ID,
      patientUid: uppercasePatientUid,
      diagnosisId: 73,
      toxicityTerm: 'Neuropathy',
      ctcaeGrade: 2,
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' });

    const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO oncology_toxicity_events'));
    expect(insert[2]).toBe(uppercasePatientUid);
    expect(event.patient_uid).toBe(uppercasePatientUid);
  });

  test('preserves direct patient-only toxicity creation', async () => {
    const event = await createToxicityEvent({
      tenantId: TENANT_ID,
      patientUid: OTHER_PATIENT_UID,
      toxicityTerm: 'Fatigue',
      ctcaeGrade: 1,
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' });

    const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO oncology_toxicity_events'));
    expect(insert[2]).toBe(OTHER_PATIENT_UID);
    expect(insert[4]).toBeNull();
    expect(event.patient_uid).toBe(OTHER_PATIENT_UID);
  });
});

describe('oncology diagnosis patient identity', () => {
  test('rejects a caller patient that differs from the tenant-scoped pathology owner', async () => {
    await expect(createOncologyDiagnosis({
      tenantId: TENANT_ID,
      patientUid: OTHER_PATIENT_UID,
      pathologyReportId: 81,
      cancerSite: 'Breast',
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' }))
      .rejects.toMatchObject({ code: 'ONCOLOGY_PATHOLOGY_PATIENT_MISMATCH' });

    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO oncology_diagnoses'))).toBe(false);
  });

  test('preserves pathology-only patient inference', async () => {
    const diagnosis = await createOncologyDiagnosis({
      tenantId: TENANT_ID,
      pathologyReportId: 81,
      cancerSite: 'Breast',
    }, { actorUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorRole: 'DOCTOR' });

    const insert = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO oncology_diagnoses'));
    expect(insert[2]).toBe(DIAGNOSIS_PATIENT_UID);
    expect(diagnosis.patient_uid).toBe(DIAGNOSIS_PATIENT_UID);
  });
});
