// Audit 2026-08-10 NEWS2-divergence pins for recordAssessment in
// src/services/clinical/nursingAssessmentService.js:
//
//   * escalation parity — a NEWS2 charted through a nursing assessment drives
//     the SAME escalateNews2 the vitals path uses (post-commit, resourceType
//     'nursing_assessment' so the task dedup slot stays off the news2_scores
//     id space). Previously a NEWS2 of 8 rendered "emergency" text but raised
//     no tracked task. escalateNews2 runs REAL here; its downstream
//     results-inbox producer + CDS surfacing are mocked, so the pin covers
//     the full decision path (threshold, severity, resource slot).
//   * the scorer's scorable flag is honored — a zero-parameter NEWS2 is a 400,
//     not a fabricated "total 0 / low / 12-hourly" row.
//   * partial rows persist an explicit partial marker + missing params
//     (migration 652 columns), and carry it into the canonical payload.

import { jest } from '@jest/globals';

const enqueueCriticalResultTaskMock = jest.fn();
const surfaceNews2CdsMock = jest.fn();
const recordCanonicalMock = jest.fn();
const setTenantTxMock = jest.fn();
const usersFindUniqueMock = jest.fn();
const txQueryRawMock = jest.fn();

const PATIENT_UID = 'c1111111-2222-4333-8444-555555550009';
const NURSE_UID = 'd2222222-3333-4444-8555-666666660008';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const __txClient = { $queryRawUnsafe: txQueryRawMock };
const __prismaDefaultMock = {
  users: { findUnique: usersFindUniqueMock },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalMock,
}));
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));
jest.unstable_mockModule('../../services/cds/deteriorationEarlyWarningService.js', () => ({
  surfaceNews2Cds: surfaceNews2CdsMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { recordAssessment } = await import('../../services/clinical/nursingAssessmentService.js');

function resetAll() {
  enqueueCriticalResultTaskMock.mockReset();
  surfaceNews2CdsMock.mockReset();
  recordCanonicalMock.mockReset();
  setTenantTxMock.mockReset();
  usersFindUniqueMock.mockReset();
  txQueryRawMock.mockReset();

  usersFindUniqueMock.mockResolvedValue({ name: 'Nurse Example' });
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__txClient));
  // The nursing_assessments INSERT — echo back a saved row from the params.
  txQueryRawMock.mockImplementation(async (_sql, ...params) => ([{
    id: 4242,
    patient_uid: params[0],
    assessment_kind: params[2],
    total_score: params[4],
    band: params[5],
    partial_score: params[13],
    missing_params: params[14],
    assessed_at_epoch_ms: Date.now(),
  }]));
  recordCanonicalMock.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
  enqueueCriticalResultTaskMock.mockResolvedValue({ created: true, task: { id: 7 } });
  surfaceNews2CdsMock.mockResolvedValue(undefined);
}

describe('recordAssessment — NEWS2 escalation parity (audit 2026-08-10)', () => {
  it('a NEWS2 of 8 raises a tracked results-inbox task on the nursing_assessment slot', async () => {
    resetAll();

    // RR 26 → 3, SpO2 90 → 3, supp O2 → 2 = 8 on scale 1.
    const saved = await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: { rr: 26, spo2: 90, supplemental_o2: true, spo2_scale: 1 },
      assessed_by: NURSE_UID,
    });

    expect(saved.id).toBe(4242);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      source: 'news2',
      // The assessment row id rides its OWN resource slot — sharing
      // 'news2_score' would collide with unrelated news2_scores ids.
      resourceType: 'nursing_assessment',
      resourceId: 4242,
      severity: 'critical',
    }));
  });

  it('a low NEWS2 raises no task (escalateNews2 decides) but still surfaces to CDS', async () => {
    resetAll();

    await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: { rr: 16, spo2: 98, temp_c: 36.8, sbp: 120, hr: 72, consciousness: 'awake', spo2_scale: 1 },
      assessed_by: NURSE_UID,
    });

    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
    expect(surfaceNews2CdsMock).toHaveBeenCalledTimes(1);
  });

  it('non-NEWS2 kinds do not touch the NEWS2 escalation path', async () => {
    resetAll();

    await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'braden',
      inputs: { sensory: 2, moisture: 2, activity: 2, mobility: 2, nutrition: 2, friction: 1 },
      assessed_by: NURSE_UID,
    });

    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
    expect(surfaceNews2CdsMock).not.toHaveBeenCalled();
  });
});

describe('recordAssessment — scorable flag + partial marker (audit 2026-08-10)', () => {
  it('a zero-parameter NEWS2 is rejected 400 instead of persisting "total 0 / low"', async () => {
    resetAll();

    await expect(recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: {},
      assessed_by: NURSE_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/at least one core parameter/),
    });

    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(txQueryRawMock).not.toHaveBeenCalled();
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
  });

  it('a partial NEWS2 persists partial_score + missing_params and carries them in the canonical payload', async () => {
    resetAll();

    // Only SpO2 88 (scale 1 → 3): scorable, partial, everything else missing.
    await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: { spo2: 88, spo2_scale: 1 },
      assessed_by: NURSE_UID,
    });

    const insertParams = txQueryRawMock.mock.calls[0].slice(1);
    // $14 = partial_score, $15 = missing_params (0-indexed 13/14).
    expect(insertParams[13]).toBe(true);
    expect(insertParams[14]).toEqual(expect.arrayContaining([
      'respiration_rate', 'temperature', 'systolic_bp', 'heart_rate', 'consciousness',
    ]));

    const payload = recordCanonicalMock.mock.calls[0][0].payload;
    expect(payload.partial).toBe(true);
    expect(payload.missing_params).toEqual(expect.arrayContaining(['heart_rate']));
  });

  it('a complete NEWS2 persists partial_score=false with no missing params', async () => {
    resetAll();

    await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: { rr: 16, spo2: 98, temp_c: 36.8, sbp: 120, hr: 72, consciousness: 'awake', spo2_scale: 1 },
      assessed_by: NURSE_UID,
    });

    const insertParams = txQueryRawMock.mock.calls[0].slice(1);
    expect(insertParams[13]).toBe(false);
    expect(insertParams[14]).toBeNull();
  });
});
