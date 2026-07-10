/**
 * Phase D4 — edOperationsService unit tests.
 *
 * Covers ED visit lifecycle, triage recording, ambulance state machine,
 * and MLC police-report + certification flow. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  certifyMlcRecord,
  createAmbulanceRequest,
  createEmergencyVisit,
  createMlcRecord,
  listAmbulanceRequests,
  listEmergencyVisits,
  listMlcRecords,
  listTriageAssessments,
  recordPoliceReport,
  recordTriageAssessment,
  setVisitTriagePriority,
  transitionAmbulanceRequest,
  transitionEmergencyVisit,
  __testing__,
} = await import('../../services/ed/edOperationsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Emergency visits
// ---------------------------------------------------------------------------

describe('createEmergencyVisit', () => {
  it('rejects missing visit_number', async () => {
    await expect(createEmergencyVisit({ tenantId: TENANT }))
      .rejects.toThrow(/visit_number is required/);
  });

  it('rejects unknown arrival_mode', async () => {
    await expect(createEmergencyVisit({
      tenantId: TENANT, visitNumber: 'V1', arrivalMode: 'helicopter_stretcher',
    })).rejects.toThrow(/arrival_mode must be one of/);
  });

  it('inserts an arriving visit', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'arriving', arrival_mode: 'walk_in', visit_number: 'V1',
    }]);
    const row = await createEmergencyVisit({
      tenantId: TENANT, visitNumber: 'V1', patientUid: PATIENT, chiefComplaint: 'chest pain',
    });
    expect(row.status).toBe('arriving');
  });

  it('throws conflict on duplicate visit_number', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createEmergencyVisit({
      tenantId: TENANT, visitNumber: 'V1',
    })).rejects.toThrow(/already exists/);
  });
});

describe('VISIT_TRANSITIONS map', () => {
  it('arriving allows in_triage / awaiting_treatment / lwbs', () => {
    expect(__testing__.VISIT_TRANSITIONS.arriving).toEqual(
      expect.arrayContaining(['in_triage', 'awaiting_treatment', 'lwbs']),
    );
  });

  it('archived is terminal', () => {
    expect(__testing__.VISIT_TRANSITIONS.archived).toEqual([]);
  });
});

describe('transitionEmergencyVisit', () => {
  it('rejects illegal transition (archived -> in_triage)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'archived' }]);
    await expect(transitionEmergencyVisit({
      tenantId: TENANT, id: 1, nextStatus: 'in_triage',
    })).rejects.toThrow(/transition/i);
  });

  it('flips arriving -> in_triage and stamps triage_started_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'arriving' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_triage' }]);
    await transitionEmergencyVisit({
      tenantId: TENANT, id: 1, nextStatus: 'in_triage',
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/triage_started_at = \$\d::timestamptz/);
  });

  it('flips in_treatment -> discharged and stamps disposition + departure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_treatment' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'discharged' }]);
    await transitionEmergencyVisit({
      tenantId: TENANT, id: 1, nextStatus: 'discharged', disposition: 'discharged_home',
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/disposition_at = \$\d::timestamptz/);
    expect(sql).toMatch(/departure_at = \$\d::timestamptz/);
    expect(sql).toMatch(/disposition = \$\d/);
  });

  it('admitted does NOT stamp departure_at (patient stays in hospital)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_treatment' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'admitted' }]);
    await transitionEmergencyVisit({
      tenantId: TENANT, id: 1, nextStatus: 'admitted', disposition: 'admitted_ward',
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/disposition_at = \$\d::timestamptz/);
    expect(sql).not.toMatch(/departure_at = \$\d::timestamptz/);
  });
});

describe('setVisitTriagePriority', () => {
  it('rejects unknown priority', async () => {
    await expect(setVisitTriagePriority({
      tenantId: TENANT, id: 1, triagePriority: 'esi_99',
    })).rejects.toThrow(/triage_priority must be one of/);
  });

  it('flips priority + stamps updated_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ canonical_triage_scale: 'esi' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, triage_priority: 'esi_2' }]);
    const row = await setVisitTriagePriority({
      tenantId: TENANT, id: 1, triagePriority: 'esi_2',
    });
    expect(row.triage_priority).toBe('esi_2');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM tenant_ed_policies/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE emergency_visits/);
  });
});

describe('listEmergencyVisits', () => {
  it('openOnly filter excludes terminal statuses', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listEmergencyVisits({ tenantId: TENANT, openOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status NOT IN \('discharged', 'transferred'/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "emergency_visits" does not exist'));
    expect(await listEmergencyVisits({ tenantId: TENANT })).toEqual({ visits: [], count: 0 });
  });

  // Regression — D46 (finding ff98a21a). Untriaged arrivals (NULL
  // triage_priority) used to be ranked at the bottom (rank 9) so on
  // a busy ED with > DEFAULT_LIST_LIMIT (50) visits, the patient who
  // just walked in was invisibly paginated off the screen. The fix
  // moves NULL triage_priority into an "untriaged" bucket that sorts
  // FIRST, with oldest-arrival inside the bucket.
  it('orders untriaged arrivals (NULL priority) FIRST and oldest-arrival first within the bucket', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listEmergencyVisits({ tenantId: TENANT, openOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    // The untriaged bucket comes first in the ORDER BY chain.
    expect(sql).toMatch(/triage_priority IS NULL THEN 1 ELSE 2 END[\s\S]*ASC/);
    // Within the untriaged bucket, oldest arrival_at first so the
    // longest-waiting unassessed patient surfaces immediately.
    expect(sql).toMatch(/CASE WHEN triage_priority IS NULL THEN arrival_at END ASC/);
    // Triaged visits keep their existing rank-then-arrival_at DESC
    // ordering for already-assessed patients (most recent within
    // urgency bucket first).
    expect(sql).toMatch(/arrival_at DESC/);
    // The CASE for triaged ranks no longer assigns NULL → 9 (the old
    // "bottom" rank) — the bucket-separation handles NULL ordering.
    expect(sql).not.toMatch(/triage_priority[\s\S]*ELSE 9 END ASC, arrival_at DESC\s+LIMIT/);
  });
});

// ---------------------------------------------------------------------------
// Triage assessments
// ---------------------------------------------------------------------------

describe('recordTriageAssessment', () => {
  it('rejects missing level', async () => {
    await expect(recordTriageAssessment({
      tenantId: TENANT, emergencyVisitId: 1,
    })).rejects.toThrow(/level is required/);
  });

  it('rejects unknown assessment_kind', async () => {
    await expect(recordTriageAssessment({
      tenantId: TENANT, emergencyVisitId: 1, level: 'esi_2', assessmentKind: 'magic',
    })).rejects.toThrow(/assessment_kind must be one of/);
  });

  it('rejects pain_score > 10', async () => {
    await expect(recordTriageAssessment({
      tenantId: TENANT, emergencyVisitId: 1, level: 'esi_2', painScore: 15,
    })).rejects.toThrow(/pain_score must be <= 10/);
  });

  it('inserts an ESI-2 assessment with airway concern', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ canonical_triage_scale: 'esi' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, level: 'esi_2', airway_concern: true, assessment_kind: 'esi',
    }]);
    const row = await recordTriageAssessment({
      tenantId: TENANT, emergencyVisitId: 1, level: 'esi_2',
      painScore: 8, airwayConcern: true,
      vitals: { hr: 110, sbp: 90, sat: 88 },
      redFlags: ['stridor', 'low_sat'],
      assessedByUid: USER,
    });
    expect(row.airway_concern).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM tenant_ed_policies/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO triage_assessments/);
  });

  it('listTriageAssessments degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "triage_assessments" does not exist'));
    expect(await listTriageAssessments({ tenantId: TENANT })).toEqual({ assessments: [], count: 0 });
  });

  it('synthesizes ATS triage assessment from nurse vitals when no formal row exists', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        emergency_visit_id: 7,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        chief_complaint: 'Crushing chest pain',
        triage_priority: 'ats_2',
        triage_started_at: '2026-05-23T10:00:00.000Z',
        vitals_id: 99,
        triage_acuity: 2,
        recorded_at: '2026-05-23T10:03:00.000Z',
        recorded_by: USER,
        heart_rate: 120,
        systolic_bp: 88,
        diastolic_bp: 56,
        temperature: '37.1',
        spo2: 92,
        respiratory_rate: 24,
        pain_score: 9,
        gcs_score: 15,
      }]);

    const result = await listTriageAssessments({ tenantId: TENANT, emergencyVisitId: 7 });

    expect(result.count).toBe(1);
    expect(result.assessments[0]).toMatchObject({
      id: null,
      assessment_kind: 'australian',
      level: 'ATS-2',
      presenting_complaint: 'Crushing chest pain',
      pain_score: 9,
      metadata: {
        source: 'vitals_chart',
        vitals_id: 99,
        triage_priority: 'ats_2',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Ambulance requests
// ---------------------------------------------------------------------------

describe('createAmbulanceRequest', () => {
  it('rejects missing request_number', async () => {
    await expect(createAmbulanceRequest({ tenantId: TENANT }))
      .rejects.toThrow(/request_number is required/);
  });

  it('rejects out-of-range geo coordinates', async () => {
    await expect(createAmbulanceRequest({
      tenantId: TENANT, requestNumber: 'AR1', pickupGeoLat: 100,
    })).rejects.toThrow(/pickup_geo_lat must be <= 90/);
  });

  it('inserts a high-priority transfer-out request', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'requested', priority: 'high', request_kind: 'transfer_out',
    }]);
    const row = await createAmbulanceRequest({
      tenantId: TENANT, requestNumber: 'AR1', requestKind: 'transfer_out',
      priority: 'high', callerName: 'Reception',
    });
    expect(row.priority).toBe('high');
  });
});

describe('AMBULANCE_TRANSITIONS map', () => {
  it('requested -> dispatched / cancelled / failed', () => {
    expect(__testing__.AMBULANCE_TRANSITIONS.requested).toEqual(['dispatched', 'cancelled', 'failed']);
  });

  it('completed is terminal', () => {
    expect(__testing__.AMBULANCE_TRANSITIONS.completed).toEqual([]);
  });
});

describe('transitionAmbulanceRequest', () => {
  it('rejects illegal transition (cancelled -> dispatched)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);
    await expect(transitionAmbulanceRequest({
      tenantId: TENANT, id: 1, nextStatus: 'dispatched',
    })).rejects.toThrow(/transition/i);
  });

  it('dispatch stamps dispatched_at + driver/attendant', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'requested' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'dispatched' }]);
    await transitionAmbulanceRequest({
      tenantId: TENANT, id: 1, nextStatus: 'dispatched',
      ambulanceUnitId: 'UNIT-7', driverName: 'Driver A', attendantName: 'EMT B',
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/dispatched_at = \$\d::timestamptz/);
    expect(sql).toMatch(/ambulance_unit_id = \$\d/);
  });

  it('cancel captures cancelled_reason', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'requested' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);
    await transitionAmbulanceRequest({
      tenantId: TENANT, id: 1, nextStatus: 'cancelled', cancelledReason: 'patient took taxi',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('patient took taxi');
  });
});

describe('listAmbulanceRequests', () => {
  it('openOnly filter narrows to active dispatch states', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listAmbulanceRequests({ tenantId: TENANT, openOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status IN \('requested', 'dispatched', 'en_route', 'on_scene', 'returning'\)/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "ambulance_requests" does not exist'));
    expect(await listAmbulanceRequests({ tenantId: TENANT })).toEqual({ requests: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// MLC records
// ---------------------------------------------------------------------------

describe('createMlcRecord', () => {
  it('rejects missing mlc_number', async () => {
    await expect(createMlcRecord({ tenantId: TENANT, mlcKind: 'rta' }))
      .rejects.toThrow(/mlc_number is required/);
  });

  it('rejects unknown mlc_kind', async () => {
    await expect(createMlcRecord({
      tenantId: TENANT, mlcNumber: 'MLC-1', mlcKind: 'jellyfish_sting',
    })).rejects.toThrow(/mlc_kind must be one of/);
  });

  it('inserts an open RTA record + mirrors is_mlc=true on parent visit', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, mlc_number: 'MLC-1', mlc_kind: 'rta', status: 'open',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // mirror update
    const row = await createMlcRecord({
      tenantId: TENANT, emergencyVisitId: 5, mlcNumber: 'MLC-1', mlcKind: 'rta',
      historySummary: 'two-wheeler collision',
    });
    expect(row.status).toBe('open');
    const mirrorCall = queryUnsafeMock.mock.calls[1][0];
    expect(mirrorCall).toMatch(/UPDATE emergency_visits[\s\S]*SET is_mlc = true/);
  });

  it('skips visit mirror when emergency_visit_id missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, mlc_number: 'MLC-2', mlc_kind: 'poisoning', status: 'open',
    }]);
    await createMlcRecord({
      tenantId: TENANT, mlcNumber: 'MLC-2', mlcKind: 'poisoning',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('recordPoliceReport', () => {
  it('stamps reported_to_police_at + police info', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, reported_to_police_at: new Date(),
      police_station: 'Bannerghatta PS', police_report_number: 'FIR-2026/123',
    }]);
    const row = await recordPoliceReport({
      tenantId: TENANT, id: 1,
      policeStation: 'Bannerghatta PS', policeReportNumber: 'FIR-2026/123',
      ipcSections: ['IPC-279', 'IPC-337'],
    });
    expect(row.police_report_number).toBe('FIR-2026/123');
  });

  it('throws 404 when MLC record is closed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(recordPoliceReport({
      tenantId: TENANT, id: 1, policeStation: 'X',
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('certifyMlcRecord', () => {
  it('rejects missing certified_by_uid', async () => {
    await expect(certifyMlcRecord({ tenantId: TENANT, id: 1 }))
      .rejects.toThrow(/certified_by_uid is required/);
  });

  it('flips status to certified', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 99,
      completeness_status: 'complete',
      certification_blocked: false,
      missing_required_fields: [],
      certificate_signer_uid: USER,
      reviewed_by_uid: USER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'certified', certified_by_uid: USER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await certifyMlcRecord({
      tenantId: TENANT, id: 1, certifiedByUid: USER,
    });
    expect(row.status).toBe('certified');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM mlc_completeness_reviews/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE mlc_records/);
  });

  it('throws 404 when already certified/closed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 99,
      completeness_status: 'complete',
      certification_blocked: false,
      missing_required_fields: [],
      certificate_signer_uid: USER,
      reviewed_by_uid: USER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(certifyMlcRecord({
      tenantId: TENANT, id: 1, certifiedByUid: USER,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listMlcRecords', () => {
  it('unreportedOnly narrows to police-pending', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listMlcRecords({ tenantId: TENANT, unreportedOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/reported_to_police_at IS NULL/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "mlc_records" does not exist'));
    expect(await listMlcRecords({ tenantId: TENANT })).toEqual({ records: [], count: 0 });
  });
});
