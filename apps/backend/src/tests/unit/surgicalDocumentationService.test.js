/**
 * Tier B PR1 — surgicalDocumentationService unit tests.
 *
 * Mocks prisma.$queryRawUnsafe so we can drive validation, mapping,
 * and update branches without a live DB. The service writes to seven
 * surgery / OR tables added in migration 116.
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

// Each surgical mutation now emits a canonical timeline + audit event in the
// same setTenantTx (audit 2026-06-18 §3 fix #1). Those writes are covered
// end-to-end in theatre-clinical-safety.deep.test.js; mock them here so they
// don't consume the per-test queryUnsafeMock sequence that asserts the
// detail-row SQL.
const recordCanonicalClinicalEventMock = jest.fn(async () => ({ timeline: null, audit: null }));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const {
  acknowledgeComplicationAlert,
  detectSiteSideMismatch,
  createIntraopNote,
  createPostopNote,
  finalizeIntraopNote,
  finalizePostopNote,
  getAnesthesiaRecord,
  getPreopChecklist,
  listImplants,
  listSafetyChecklist,
  recordComplicationAlert,
  recordImplant,
  recordImplantRemoval,
  resolveComplicationAlert,
  upsertAnesthesiaRecord,
  upsertPreopChecklist,
  upsertSafetyChecklistPhase,
} = await import('../../services/theatre/surgicalDocumentationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordCanonicalClinicalEventMock.mockClear();
  // Real $queryRawUnsafe always resolves to an array. Default any call beyond
  // the explicitly-queued ones (e.g. the post-insert patient_uid backfill in
  // emitSurgicalCanonicalEvent when the mocked insert row omits patient_uid)
  // to [] so it behaves like a real empty result instead of undefined.
  queryUnsafeMock.mockResolvedValue([]);
});

function mockSchedule() {
  // First call in every flow is ensureScheduleVisible.
  queryUnsafeMock.mockResolvedValueOnce([{ id: 42 }]);
}

// ---------------------------------------------------------------------------
// WHO time-out wrong-site gate (finding 2026-05-22-surgical-day-care-ot-staff-e410248f)
// ---------------------------------------------------------------------------

describe('detectSiteSideMismatch', () => {
  it('flags scheduled right vs marked left', () => {
    expect(detectSiteSideMismatch({ scheduled_side: 'right', marked_side: 'left' }))
      .toEqual({ scheduled: 'right', marked: 'left' });
  });
  it('passes matching sides', () => {
    expect(detectSiteSideMismatch({ scheduled_side: 'right', marked_side: 'right' })).toBeNull();
  });
  it('normalizes ophthalmic OD/OS aliases', () => {
    expect(detectSiteSideMismatch({ scheduled_eye: 'OD', marked_eye: 'OS' }))
      .toEqual({ scheduled: 'right', marked: 'left' });
  });
  it('never flags bilateral / unknown / missing sides', () => {
    expect(detectSiteSideMismatch({ scheduled_side: 'bilateral', marked_side: 'left' })).toBeNull();
    expect(detectSiteSideMismatch({ scheduled_side: 'right' })).toBeNull();
    expect(detectSiteSideMismatch({})).toBeNull();
    expect(detectSiteSideMismatch(null)).toBeNull();
  });
});

describe('upsertSafetyChecklistPhase — WHO time-out wrong-site gate', () => {
  it('rejects completing a time-out with a documented side mismatch (no override)', async () => {
    mockSchedule();
    await expect(upsertSafetyChecklistPhase({
      tenantId: TENANT, otScheduleId: 42, phase: 'time_out',
      allItemsConfirmed: true,
      metadata: { scheduled_side: 'right', marked_side: 'left' },
    })).rejects.toMatchObject({ statusCode: 400, code: 'SURGICAL_SITE_SIDE_MISMATCH' });
  });

  it('allows completing a matched-side time-out', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, phase: 'time_out', status: 'complete' }]);
    const row = await upsertSafetyChecklistPhase({
      tenantId: TENANT, otScheduleId: 42, phase: 'time_out',
      allItemsConfirmed: true,
      metadata: { scheduled_side: 'right', marked_side: 'right' },
    });
    expect(row.status).toBe('complete');
  });

  it('allows a mismatched time-out only with an explicit clinical override', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 8, phase: 'time_out', status: 'complete' }]);
    const row = await upsertSafetyChecklistPhase({
      tenantId: TENANT, otScheduleId: 42, phase: 'time_out',
      allItemsConfirmed: true,
      metadata: { scheduled_side: 'right', marked_side: 'left' },
      overrideReason: 'Surgeon reconfirmed site with imaging; mark corrected intra-op',
      overrideAuthorizedBy: USER,
    });
    expect(row.id).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// preop_checklists
// ---------------------------------------------------------------------------

describe('upsertPreopChecklist', () => {
  it('rejects invalid ot_schedule_id', async () => {
    await expect(upsertPreopChecklist({ tenantId: TENANT, otScheduleId: 'abc' }))
      .rejects.toThrow(/ot_schedule_id must be a positive integer/);
  });

  it('rejects unknown status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(upsertPreopChecklist({ tenantId: TENANT, otScheduleId: 1, status: 'weird' }))
      .rejects.toThrow(/status must be one of/);
  });

  it('writes booleans + JSON arrays into the upsert', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 9, status: 'in_progress' }]);
    const row = await upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      consentSigned: true,
      siteMarked: false,
      pendingItems: [{ item: 'cross-match' }],
    });
    expect(row.id).toBe(9);
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/INSERT INTO preop_checklists/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, ot_schedule_id\)/);
  });

  it('persists day-care nursing glucose and eye-drop fields', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 9,
      blood_glucose_mg_dl: '146.50',
      eye_drops_given: true,
    }]);
    const row = await upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      bloodGlucoseMgDl: '146.5',
      bloodGlucoseCheckedAt: '2026-05-23T08:30:00.000Z',
      eyeDropsGiven: true,
      eyeDropsGivenAt: '2026-05-23T08:45:00.000Z',
      eyeDropsNotes: 'Moxifloxacin and dilating drops given',
    });
    expect(row.eye_drops_given).toBe(true);
    const [sql, ...params] = queryUnsafeMock.mock.calls[1];
    expect(sql).toMatch(/blood_glucose_mg_dl/);
    expect(sql).toMatch(/blood_glucose_checked_at/);
    expect(sql).toMatch(/eye_drops_given/);
    expect(sql).toMatch(/eye_drops_given_at/);
    expect(sql).toMatch(/eye_drops_notes/);
    expect(params).toContain(146.5);
    expect(params).toContain('2026-05-23T08:30:00.000Z');
    expect(params).toContain('2026-05-23T08:45:00.000Z');
    expect(params).toContain('Moxifloxacin and dilating drops given');
  });

  it('marks completed_at when status flips to complete', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 9 }]);
    await upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      status: 'complete',
      siteMarked: true,
      completedBy: USER,
    });
    // The completed_at param is a non-null ISO timestamp. Find it among the
    // bound params: positions are by add() order — completed_at is added
    // right after completed_by.
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    const completedAt = params.find((p, idx, arr) => arr[idx - 1] === USER && typeof p === 'string' && /Z$/.test(p));
    expect(completedAt).toBeTruthy();
  });

  it('rejects completing the checklist without the surgical site mark', async () => {
    mockSchedule();
    await expect(upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      status: 'complete',
      siteMarked: false,
      completedBy: USER,
    })).rejects.toMatchObject({ statusCode: 400, code: 'SURGICAL_SITE_MARK_REQUIRED' });
    // Gate fires before the INSERT — only ensureScheduleVisible ran.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects flagging OT-ready via metadata without the surgical site mark', async () => {
    mockSchedule();
    await expect(upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      status: 'in_progress',
      metadata: { ot_ready: true },
    })).rejects.toMatchObject({ statusCode: 400, code: 'SURGICAL_SITE_MARK_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows incomplete_with_override without the site mark (explicit escape hatch)', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, status: 'incomplete_with_override' }]);
    const row = await upsertPreopChecklist({
      tenantId: TENANT,
      otScheduleId: 42,
      status: 'incomplete_with_override',
      overrideReason: 'Site mark deferred — bilateral procedure documented in plan',
    });
    expect(row.id).toBe(11);
  });
});

describe('getPreopChecklist', () => {
  it('returns null when row missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await getPreopChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(row).toBeNull();
  });

  it('returns row when present', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 9, status: 'complete' }]);
    const row = await getPreopChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(row.id).toBe(9);
  });

  it('degrades to null on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "preop_checklists" does not exist'));
    const row = await getPreopChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// intraop_notes
// ---------------------------------------------------------------------------

describe('createIntraopNote', () => {
  it('inserts with default status=draft', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'draft' }]);
    const row = await createIntraopNote({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      surgeon: USER,
      procedurePerformed: 'Lap appendectomy',
      estimatedBloodLossMl: 50,
    });
    expect(row.status).toBe('draft');
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/INSERT INTO intraop_notes/);
  });

  it('blocks incision/start recording until WHO time-out is complete', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(createIntraopNote({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      surgeon: USER,
      startTime: '2026-05-23T10:00:00.000Z',
    })).rejects.toMatchObject({ statusCode: 400, code: 'WHO_TIMEOUT_REQUIRED' });
  });

  it('allows finalized intra-op note creation only after WHO time-out completion', async () => {
    mockSchedule();
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 77, phase: 'time_out', status: 'complete' }])
      .mockResolvedValueOnce([{ id: 1, status: 'finalized' }]);

    const row = await createIntraopNote({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      surgeon: USER,
      status: 'finalized',
      procedurePerformed: 'Lap appendectomy',
    });

    expect(row.status).toBe('finalized');
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/FROM surgical_safety_checklists/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO intraop_notes/);
  });

  it('rejects invalid technique value', async () => {
    mockSchedule();
    await expect(createIntraopNote({
      tenantId: TENANT, otScheduleId: 42, technique: undefined,
      procedureCodes: 'not-an-array',
    })).rejects.toThrow(/procedure_codes must be a JSON array/);
  });
});

describe('finalizeIntraopNote', () => {
  it('flips status to finalized on existing draft', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 1, ot_schedule_id: 42 }])
      .mockResolvedValueOnce([{ id: 77, phase: 'time_out', status: 'complete' }])
      .mockResolvedValueOnce([{ id: 1, status: 'finalized' }]);
    const row = await finalizeIntraopNote({ tenantId: TENANT, id: 1, finalizedBy: USER });
    expect(row.status).toBe('finalized');
  });

  it('throws not-found when nothing is updated', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(finalizeIntraopNote({ tenantId: TENANT, id: 999 }))
      .rejects.toThrow(/not found or already finalized/);
  });

  it('blocks finalization if the WHO time-out is still missing', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 1, ot_schedule_id: 42 }])
      .mockResolvedValueOnce([]);

    await expect(finalizeIntraopNote({ tenantId: TENANT, id: 1, finalizedBy: USER }))
      .rejects.toMatchObject({ statusCode: 400, code: 'WHO_TIMEOUT_REQUIRED' });
  });
});

// ---------------------------------------------------------------------------
// postop_notes
// ---------------------------------------------------------------------------

describe('createPostopNote', () => {
  it('rejects pain_score >10', async () => {
    mockSchedule();
    await expect(createPostopNote({
      tenantId: TENANT, otScheduleId: 42, painScore: 11,
    })).rejects.toThrow(/pain_score must be <= 10/);
  });

  it('inserts a phase1 PACU note', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, recovery_phase: 'phase1' }]);
    const row = await createPostopNote({
      tenantId: TENANT,
      otScheduleId: 42,
      recoveryPhase: 'phase1',
      painScore: 4,
      vitals: { hr: 80, sbp: 120 },
    });
    expect(row.recovery_phase).toBe('phase1');
  });

  it('persists long handover notes without disposition truncation', async () => {
    mockSchedule();
    const longHandover = `SBAR handover to ward recovery nurse: ${'observe airway, pain, nausea, wound, IOL shield, escort readiness; '.repeat(8)}`.trim();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, handover_notes: longHandover }]);
    const row = await createPostopNote({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      authoredBy: USER,
      recoveryPhase: 'phase1',
      disposition: 'ward recovery',
      handoverNotes: longHandover,
    });
    expect(row.handover_notes).toBe(longHandover);
    const [sql, ...params] = queryUnsafeMock.mock.calls[1];
    expect(sql).toMatch(/handover_notes/);
    expect(params).toContain(longHandover);
    expect(longHandover.length).toBeGreaterThan(160);
  });

  it('rejects unknown recovery_phase', async () => {
    mockSchedule();
    await expect(createPostopNote({
      tenantId: TENANT, otScheduleId: 42, recoveryPhase: 'spaceship',
    })).rejects.toThrow(/recovery_phase must be one of/);
  });
});

describe('finalizePostopNote', () => {
  it('throws when row already finalized', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(finalizePostopNote({ tenantId: TENANT, id: 99 }))
      .rejects.toThrow(/not found or already finalized/);
  });
});

// ---------------------------------------------------------------------------
// anesthesia_records
// ---------------------------------------------------------------------------

describe('upsertAnesthesiaRecord', () => {
  it('rejects invalid ASA grade', async () => {
    mockSchedule();
    await expect(upsertAnesthesiaRecord({
      tenantId: TENANT, otScheduleId: 42, asaGrade: 'XII',
    })).rejects.toThrow(/asa_grade must be one of/);
  });

  it('rejects invalid technique', async () => {
    mockSchedule();
    await expect(upsertAnesthesiaRecord({
      tenantId: TENANT, otScheduleId: 42, technique: 'voodoo',
    })).rejects.toThrow(/technique must be one of/);
  });

  it('upserts with ASA III + general technique', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, asa_grade: 'III', technique: 'general' }]);
    const row = await upsertAnesthesiaRecord({
      tenantId: TENANT,
      otScheduleId: 42,
      asaGrade: 'III',
      technique: 'general',
      airwayManaged: 'ett_oral',
    });
    expect(row.asa_grade).toBe('III');
  });
});

describe('getAnesthesiaRecord', () => {
  it('returns row when present', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7 }]);
    const row = await getAnesthesiaRecord({ tenantId: TENANT, otScheduleId: 42 });
    expect(row.id).toBe(7);
  });

  it('returns null when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await getAnesthesiaRecord({ tenantId: TENANT, otScheduleId: 42 });
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// surgical_implants
// ---------------------------------------------------------------------------

describe('recordImplant', () => {
  it('rejects missing implant_type', async () => {
    mockSchedule();
    await expect(recordImplant({ tenantId: TENANT, otScheduleId: 42 }))
      .rejects.toThrow(/implant_type is required/);
  });

  it('rejects unknown side', async () => {
    mockSchedule();
    await expect(recordImplant({
      tenantId: TENANT, otScheduleId: 42, implantType: 'knee_prosthesis', side: 'top',
    })).rejects.toThrow(/side must be one of/);
  });

  it('inserts a knee prosthesis with UDI', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, status: 'in_situ' }]);
    const row = await recordImplant({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      implantType: 'knee_prosthesis',
      manufacturer: 'AcmeMed',
      lotNumber: 'LOT-AM-2026-04',
      udi: '(01)00644290000019(11)260101',
      side: 'left',
    });
    expect(row.status).toBe('in_situ');
  });
});

describe('listImplants', () => {
  it('filters by patient_uid + status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, status: 'in_situ' }]);
    const result = await listImplants({
      tenantId: TENANT, patientUid: PATIENT, status: 'in_situ',
    });
    expect(result.implants).toHaveLength(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/patient_uid = \$2::uuid/);
  });

  it('degrades to empty list on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "surgical_implants" does not exist'));
    const result = await listImplants({ tenantId: TENANT });
    expect(result).toEqual({ implants: [], count: 0 });
  });
});

describe('recordImplantRemoval', () => {
  it('flips status to removed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11, status: 'removed', removal_reason: 'infection' }]);
    const row = await recordImplantRemoval({
      tenantId: TENANT, id: 11, removalReason: 'infection',
    });
    expect(row.status).toBe('removed');
  });

  it('throws not-found when implant not in_situ', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(recordImplantRemoval({ tenantId: TENANT, id: 11 }))
      .rejects.toThrow(/not found or not in_situ/);
  });
});

// ---------------------------------------------------------------------------
// surgical_safety_checklists (WHO 3-phase)
// ---------------------------------------------------------------------------

describe('upsertSafetyChecklistPhase', () => {
  it('requires phase', async () => {
    mockSchedule();
    await expect(upsertSafetyChecklistPhase({ tenantId: TENANT, otScheduleId: 42 }))
      .rejects.toThrow(/phase is required/);
  });

  it('rejects unknown phase', async () => {
    mockSchedule();
    await expect(upsertSafetyChecklistPhase({
      tenantId: TENANT, otScheduleId: 42, phase: 'sign_now',
    })).rejects.toThrow(/phase must be one of/);
  });

  it('infers status=complete when outstanding empty + all confirmed', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, phase: 'sign_in', status: 'complete' }]);
    const row = await upsertSafetyChecklistPhase({
      tenantId: TENANT,
      otScheduleId: 42,
      phase: 'sign_in',
      items: [{ item: 'patient_id', confirmed: true }],
      outstandingItems: [],
      allItemsConfirmed: true,
    });
    expect(row.status).toBe('complete');
  });

  it('infers status=incomplete_with_override when overrideReason given', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, status: 'incomplete_with_override' }]);
    const row = await upsertSafetyChecklistPhase({
      tenantId: TENANT,
      otScheduleId: 42,
      phase: 'time_out',
      items: [{ item: 'site_marked', confirmed: false }],
      outstandingItems: [{ item: 'site_marked' }],
      allItemsConfirmed: false,
      overrideReason: 'emergency rupture',
      overrideAuthorizedBy: USER,
    });
    expect(row.status).toBe('incomplete_with_override');
  });
});

describe('listSafetyChecklist', () => {
  it('returns phases ordered sign_in -> time_out -> sign_out', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, phase: 'sign_in' },
      { id: 2, phase: 'time_out' },
      { id: 3, phase: 'sign_out' },
    ]);
    const result = await listSafetyChecklist({ tenantId: TENANT, otScheduleId: 42 });
    expect(result.phases.map((p) => p.phase)).toEqual(['sign_in', 'time_out', 'sign_out']);
  });
});

// ---------------------------------------------------------------------------
// postop_complication_alerts
// ---------------------------------------------------------------------------

describe('recordComplicationAlert', () => {
  it('rejects missing complication_type', async () => {
    mockSchedule();
    await expect(recordComplicationAlert({ tenantId: TENANT, otScheduleId: 42 }))
      .rejects.toThrow(/complication_type is required/);
  });

  it('rejects unknown complication_type', async () => {
    mockSchedule();
    await expect(recordComplicationAlert({
      tenantId: TENANT, otScheduleId: 42, complicationType: 'space_invasion',
    })).rejects.toThrow(/complication_type must be one of/);
  });

  it('rejects unknown Clavien-Dindo grade', async () => {
    mockSchedule();
    await expect(recordComplicationAlert({
      tenantId: TENANT, otScheduleId: 42,
      complicationType: 'sepsis', clavienDindoGrade: 'X',
    })).rejects.toThrow(/clavien_dindo_grade must be one of/);
  });

  it('inserts an open critical PE alert', async () => {
    mockSchedule();
    queryUnsafeMock.mockResolvedValueOnce([{ id: 31, complication_type: 'pe', status: 'open', severity: 'critical' }]);
    const row = await recordComplicationAlert({
      tenantId: TENANT,
      otScheduleId: 42,
      patientUid: PATIENT,
      complicationType: 'pe',
      severity: 'critical',
      detectionSource: 'imaging',
      description: 'CTPA confirms saddle PE',
    });
    expect(row.status).toBe('open');
    expect(row.severity).toBe('critical');
  });
});

describe('acknowledgeComplicationAlert', () => {
  it('requires acknowledged_by', async () => {
    await expect(acknowledgeComplicationAlert({ tenantId: TENANT, id: 31 }))
      .rejects.toThrow(/acknowledged_by is required/);
  });

  it('flips status to acknowledged', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 31, status: 'acknowledged' }]);
    const row = await acknowledgeComplicationAlert({
      tenantId: TENANT, id: 31, acknowledgedBy: USER,
    });
    expect(row.status).toBe('acknowledged');
  });

  it('throws not-found when row not open', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(acknowledgeComplicationAlert({
      tenantId: TENANT, id: 31, acknowledgedBy: USER,
    })).rejects.toThrow(/not found or not open/);
  });
});

describe('resolveComplicationAlert', () => {
  it('rejects unknown outcome', async () => {
    await expect(resolveComplicationAlert({
      tenantId: TENANT, id: 31, outcome: 'transmuted',
    })).rejects.toThrow(/outcome must be one of/);
  });

  it('flips status to resolved with intervention', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 31, status: 'resolved', outcome: 'resolved' }]);
    const row = await resolveComplicationAlert({
      tenantId: TENANT, id: 31, outcome: 'resolved',
      intervention: 'IVC filter + heparin', clavienDindoGrade: 'IIIb',
    });
    expect(row.status).toBe('resolved');
  });
});
