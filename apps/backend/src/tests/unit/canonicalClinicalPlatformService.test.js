import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const loggerWarnMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();
const getLegacyPatientTimelineMock = jest.fn();

// Tenant-scoped transaction client — separate from the base mock so tests can
// assert which statements ran after the RLS boundary was installed.
const txQueryUnsafeMock = jest.fn();
const __prismaTxMock = { $queryRawUnsafe: txQueryUnsafeMock };
const transactionMock = jest.fn(async (fn) => fn(__prismaTxMock));
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaTxMock));

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $transaction: transactionMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: loggerWarnMock,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  getPatientTimeline: getLegacyPatientTimelineMock,
}));

const {
  evaluateMedicationSafety,
  getClinicalDocumentationTemplates,
  getClinicalDowntimePolicy,
  listClinicalAuditEvents,
  listMedicationSafetyReviews,
  listWorkflowSlaInstances,
  readCanonicalPatientTimeline,
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
  transitionEncounter,
} = await import('../../services/clinical/canonicalClinicalPlatformService.js');
const { runInTenantContext } = await import('../../lib/tenantContext.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryUnsafeMock.mockReset().mockResolvedValue([]);
  txQueryUnsafeMock.mockReset().mockResolvedValue([]);
  transactionMock.mockClear();
  setTenantTxMock.mockClear();
  loggerWarnMock.mockReset();
  validatePrescriptionSafetyMock.mockReset().mockResolvedValue({ safe: true, warnings: [], blockers: [] });
  getLegacyPatientTimelineMock.mockReset().mockResolvedValue([]);
});

describe('canonical clinical platform service', () => {
  it('records a clinical write into timeline and clinical audit streams', async () => {
    const timelineRow = {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: TENANT,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      event_type: 'note.signed',
      source_table: 'clinical_notes',
      source_id: '7',
    };
    const auditRow = {
      id: '55555555-5555-4555-8555-555555555555',
      tenant_id: TENANT,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      action: 'note.signed',
      resource_table: 'clinical_notes',
      resource_id: '7',
    };
    queryUnsafeMock
      .mockResolvedValueOnce([timelineRow])
      .mockResolvedValueOnce([auditRow]);

    const result = await recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      encounterId: ENCOUNTER,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      resourceType: 'clinical_note',
      resourceId: 7,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      summary: 'OP note signed',
      payload: { note_type: 'op_consultation' },
      beforeState: { is_signed: false },
      afterState: { is_signed: true },
    });

    expect(result.timeline).toBe(timelineRow);
    expect(result.audit).toBe(auditRow);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('clinical_timeline_events');
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('clinical_audit_events');
  });

  it('reads back a timeline row after an invisible concurrent conflict', async () => {
    const timelineRow = { id: '44444444-4444-4444-8444-444444444444' };
    const auditRow = { id: '55555555-5555-4555-8555-555555555555' };
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([timelineRow])
      .mockResolvedValueOnce([auditRow]);

    const result = await recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      actorUid: ACTOR,
    }, { strict: true });

    expect(result).toEqual({ timeline: timelineRow, audit: auditRow });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('WHERE idempotency_key = $1');
  });

  it('reads back an audit row after an invisible concurrent conflict', async () => {
    const timelineRow = { id: '44444444-4444-4444-8444-444444444444' };
    const auditRow = { id: '55555555-5555-4555-8555-555555555555' };
    queryUnsafeMock
      .mockResolvedValueOnce([timelineRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([auditRow]);

    const result = await recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      actorUid: ACTOR,
    }, { strict: true });

    expect(result).toEqual({ timeline: timelineRow, audit: auditRow });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('clinical_audit_events');
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('WHERE idempotency_key = $1');
  });

  it('uses the active transaction tenant when the caller omits tenantId', async () => {
    const auditRow = { id: '55555555-5555-4555-8555-555555555555', tenant_id: TENANT };
    queryUnsafeMock.mockResolvedValueOnce([auditRow]);

    const result = await runInTenantContext(TENANT, () => recordClinicalAuditEvent({
      patientUid: PATIENT,
      action: 'note.signed',
      resourceTable: 'clinical_notes',
      resourceId: 7,
      actorUid: ACTOR,
    }, { db: __prismaDefaultMock }));

    expect(result).toBe(auditRow);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
  });

  it('uses the transaction GUC when no in-process tenant context exists', async () => {
    const auditRow = { id: '55555555-5555-4555-8555-555555555555', tenant_id: TENANT };
    queryUnsafeMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([auditRow]);

    const result = await recordClinicalAuditEvent({
      patientUid: PATIENT,
      action: 'note.signed',
      resourceTable: 'clinical_notes',
      resourceId: 7,
      actorUid: ACTOR,
    }, { db: __prismaDefaultMock });

    expect(result).toBe(auditRow);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain("current_setting('app.current_tenant_id'");
    expect(queryUnsafeMock.mock.calls[1][1]).toBe(TENANT);
  });

  it('rejects strict writes when the timeline row cannot be recorded', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      actorUid: ACTOR,
    }, { strict: true })).rejects.toMatchObject({
      code: 'CANONICAL_TIMELINE_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('enforces complete canonical pairs for patient writes on a transaction client', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'order.created',
      sourceTable: 'clinical_orders',
      sourceId: 9,
    }, { db: __prismaDefaultMock })).rejects.toMatchObject({
      code: 'CANONICAL_TIMELINE_REQUIRED',
    });
  });

  it('rejects strict writes when the audit row cannot be recorded', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 'timeline-row' }])
      .mockResolvedValueOnce([]);

    await expect(recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      actorUid: ACTOR,
    }, { strict: true })).rejects.toMatchObject({
      code: 'CANONICAL_AUDIT_REQUIRED',
    });
  });

  it('reads only the canonical patient timeline by default', async () => {
    // 1. merged-uid chain resolution (no merges — just the patient).
    queryUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: '66666666-6666-4666-8666-666666666666',
      patient_uid: PATIENT,
      event_type: 'prescription.created',
      event_subtype: null,
      event_status: 'draft',
      source_table: 'e_prescriptions',
      source_id: '18',
      resource_type: 'prescription',
      resource_id: '18',
      encounter_id: ENCOUNTER,
      occurred_at: new Date('2026-06-07T09:00:00.000Z'),
      clinical_summary: 'Prescription created',
      actor_uid: ACTOR,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: { title: 'E-prescription' },
      tags: ['op'],
    }]);
    const timeline = await readCanonicalPatientTimeline(PATIENT, { limit: 20 });

    expect(timeline.patient_uid).toBe(PATIENT);
    expect(timeline.source).toBe('canonical');
    expect(timeline.legacy_included).toBe(false);
    expect(timeline.counts).toEqual({
      canonical: 1,
      patient_generated: 0,
      legacy: 0,
      returned: 1,
    });
    expect(timeline.events.map((event) => event.event_type)).toEqual([
      'prescription.created',
    ]);
    expect(getLegacyPatientTimelineMock).not.toHaveBeenCalled();
  });

  it('merges legacy events only when compatibility mode is requested', async () => {
    // 1. merged-uid chain resolution (no merges — just the patient).
    queryUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: '66666666-6666-4666-8666-666666666666',
      patient_uid: PATIENT,
      event_type: 'prescription.created',
      event_subtype: null,
      event_status: 'draft',
      source_table: 'e_prescriptions',
      source_id: '18',
      resource_type: 'prescription',
      resource_id: '18',
      encounter_id: ENCOUNTER,
      occurred_at: new Date('2026-06-07T09:00:00.000Z'),
      clinical_summary: 'Prescription created',
      actor_uid: ACTOR,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: { title: 'E-prescription' },
      tags: ['op'],
    }]);
    getLegacyPatientTimelineMock.mockResolvedValueOnce([{
      id: 99,
      type: 'vitals',
      timestamp: '2026-06-07T08:30:00.000Z',
      title: 'Vitals recorded',
      summary: 'HR 82',
    }, {
      id: 100,
      event_type: 'clinical_note',
      timestamp: '2026-06-07T08:00:00.000Z',
      title: 'Progress note',
      summary: 'Review after rounds',
    }]);

    const timeline = await readCanonicalPatientTimeline(PATIENT, { limit: 20, includeLegacy: true });

    expect(timeline.legacy_included).toBe(true);
    expect(timeline.counts).toEqual({
      canonical: 1,
      patient_generated: 0,
      legacy: 2,
      returned: 3,
    });
    expect(timeline.events.map((event) => event.event_type)).toEqual([
      'prescription.created',
      'vitals.recorded',
      'clinical_note',
    ]);
  });

  it('adds patient-generated activity summaries to the canonical timeline read', async () => {
    queryUnsafeMock
      // 1. merged-uid chain resolution (no merges — just the patient).
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        user_uid: PATIENT,
        source_day: new Date('2026-06-06T00:00:00.000Z'),
        steps: 8420,
        distance_meters: 6315,
        sleep_minutes: 415,
        active_energy_kcal: 302.4,
        sources: 'health_connect',
        source_apps: 'Google Fit',
        source_devices: 'Pixel Watch',
        recorded_at_source: new Date('2026-06-06T22:30:00.000Z'),
      }]);

    const timeline = await readCanonicalPatientTimeline(PATIENT, { limit: 20 });

    expect(timeline.counts).toEqual({
      canonical: 0,
      patient_generated: 1,
      legacy: 0,
      returned: 1,
    });
    expect(timeline.events[0]).toMatchObject({
      event_type: 'patient_activity.daily_summary',
      event_status: 'unverified',
      patient_generated: true,
      resource_type: 'patient_activity',
      payload: {
        source_kind: 'patient_generated',
        verification_status: 'unverified',
        steps: 8420,
        distance_meters: 6315,
        sleep_minutes: 415,
      },
    });
    expect(timeline.events[0].clinical_summary).toContain('8,420 steps');
  });

  it('rejects invalid encounter lifecycle transitions', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'locked',
    }]);

    await expect(transitionEncounter(ENCOUNTER, 'active', {
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_ENCOUNTER_TRANSITION',
    });
  });

  it('runs the encounter UPDATE and canonical emits in one transaction when no client is supplied', async () => {
    // getEncounter pre-check runs on the base client.
    queryUnsafeMock.mockResolvedValueOnce([{
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'open',
    }]);
    const updatedRow = {
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'active',
      updated_at: new Date('2026-08-09T10:00:00.000Z'),
    };
    txQueryUnsafeMock
      .mockResolvedValueOnce([updatedRow])
      .mockResolvedValueOnce([{ id: 'timeline-1' }])
      .mockResolvedValueOnce([{ id: 'audit-1' }]);

    const result = await transitionEncounter(ENCOUNTER, 'active', {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    });

    expect(result).toBe(updatedRow);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(transactionMock).not.toHaveBeenCalled();
    // Base client only served the pre-check read; the UPDATE + both canonical
    // emits all ran through the transaction client.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('SELECT * FROM patient_encounters');
    expect(txQueryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(txQueryUnsafeMock.mock.calls[0][0]).toContain('UPDATE patient_encounters');
    expect(txQueryUnsafeMock.mock.calls[0][0]).toContain('AND status = $4::text');
    expect(txQueryUnsafeMock.mock.calls[1][0]).toContain('clinical_timeline_events');
    expect(txQueryUnsafeMock.mock.calls[2][0]).toContain('clinical_audit_events');
  });

  it('surfaces a conflict when the guarded UPDATE matches no row (concurrent transition)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'open',
    }]);
    // The status changed between the pre-check read and the UPDATE, so the
    // `AND status = $4` guard matches nothing.
    txQueryUnsafeMock.mockResolvedValueOnce([]);

    await expect(transitionEncounter(ENCOUNTER, 'active', {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_ENCOUNTER_TRANSITION',
    });
    // No canonical emit was attempted after the failed guard.
    expect(txQueryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('propagates canonical emit failures instead of resolving null', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'open',
    }]);
    txQueryUnsafeMock
      .mockResolvedValueOnce([{
        id: ENCOUNTER,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        status: 'active',
        updated_at: new Date('2026-08-09T10:00:00.000Z'),
      }])
      .mockRejectedValueOnce(new Error('timeline write failed'));

    await expect(transitionEncounter(ENCOUNTER, 'active', {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    })).rejects.toThrow('timeline write failed');
  });

  it('lists canonical audit, SLA, and medication safety rows for an encounter', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 'audit-1', action: 'note.signed' }])
      .mockResolvedValueOnce([{ id: 'sla-1', rule_code: 'referral_response' }])
      .mockResolvedValueOnce([{ id: 'safety-1', review_type: 'allergy' }]);

    const audit = await listClinicalAuditEvents({
      tenantId: TENANT,
      encounterId: ENCOUNTER,
      patientUid: PATIENT,
      action: 'note',
      limit: 20,
    });
    const slas = await listWorkflowSlaInstances({
      tenantId: TENANT,
      encounterId: ENCOUNTER,
      patientUid: PATIENT,
      status: 'active',
    });
    const safety = await listMedicationSafetyReviews({
      tenantId: TENANT,
      encounterId: ENCOUNTER,
      severity: 'high',
    });

    expect(audit.events).toHaveLength(1);
    expect(slas.slas).toHaveLength(1);
    expect(safety.reviews).toHaveLength(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('clinical_audit_events');
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('patient_uid IN (SELECT $2::uuid AS uid');
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('workflow_sla_instances');
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('patient_uid IN (SELECT $2::uuid AS uid');
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('medication_safety_reviews');
  });

  it('evaluates medication safety and records returned review findings', async () => {
    validatePrescriptionSafetyMock.mockResolvedValueOnce({
      safe: false,
      warnings: [{ type: 'RENAL_MEDICATION_REVIEW', medication: 'Gentamicin', message: 'Renal review' }],
      blockers: [{ type: 'ALLERGY_CONFLICT', medication: 'Penicillin', message: 'Allergy' }],
    });
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 'review-blocker', status: 'blocked' }])
      .mockResolvedValueOnce([{ id: 'review-warning', status: 'warning' }]);

    const result = await evaluateMedicationSafety({
      tenantId: TENANT,
      patientUid: PATIENT,
      encounterId: ENCOUNTER,
      patientId: 42,
      actorUid: ACTOR,
      medications: [{ name: 'Penicillin' }, { name: 'Gentamicin' }],
    });

    expect(result.safe).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.reviews).toHaveLength(2);
    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(
      42,
      [
        { name: 'Penicillin' },
        { name: 'Gentamicin' },
      ],
      { tenantId: TENANT, db: __prismaDefaultMock },
    );
  });

  it('uses one resolved tenant and the caller transaction for safety evaluation and review persistence', async () => {
    txQueryUnsafeMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ id: 'review-passed', status: 'passed' }]);

    const medications = [{ name: 'Paracetamol' }];
    const result = await evaluateMedicationSafety({
      patientUid: PATIENT,
      patientId: 42,
      actorUid: ACTOR,
      medications,
    }, { db: __prismaTxMock });

    expect(result.reviews).toEqual([{ id: 'review-passed', status: 'passed' }]);
    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(
      42,
      medications,
      { tenantId: TENANT, db: __prismaTxMock },
    );
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(txQueryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(txQueryUnsafeMock.mock.calls[0][0]).toContain("current_setting('app.current_tenant_id'");
    expect(txQueryUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO medication_safety_reviews');
    expect(txQueryUnsafeMock.mock.calls[1][1]).toBe(TENANT);
  });

  it('serves structured documentation templates and downtime policy guardrails', () => {
    const opTemplates = getClinicalDocumentationTemplates({
      context: 'op_consultation',
    });
    const downtime = getClinicalDowntimePolicy({ role: 'DOCTOR' });

    expect(opTemplates.templates).toHaveLength(1);
    expect(opTemplates.templates[0].sections.map((section) => section.id)).toEqual([
      'chief_complaints',
      'history',
      'examination',
      'diagnosis',
      'plan',
      'follow_up',
      'safety_net',
    ]);
    expect(downtime.blocked_offline).toContain('prescription_sign_or_dispense');
    expect(downtime.local_draft_only).toContain('op_prescription_draft');
    expect(downtime.role).toBe('DOCTOR');
  });
});
