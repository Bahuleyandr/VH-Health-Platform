// NL-14 P2 — resuscitationEventService unit tests (spec §4.3).
//
// Proves, with mocked prisma/canonical/realtime layers:
//   * explicit trigger creates the DURABLE event + canonical timeline/audit
//     pair, then emits the WS notification with the durable event id
//     (notification-only, post-commit);
//   * the per-tenant flag fails closed (writes 403; the critical-vital hook
//     silently no-ops);
//   * the critical-vital hook persists the event, links the clinical-alert
//     evidence, and is idempotent per triggering alert;
//   * timeline appends are ordered (seq) and MAR-SAFE: resus medication rows
//     REFERENCE administered MAR doses (never inserting into
//     medication_administrations), reject cross-patient or already-linked
//     MAR rows, and unlinked emergency doses enter MAR reconciliation;
//   * finalization is blocked without a team leader AND recorder;
//   * the QA/debrief review fails closed without approved template content.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const timelineMock = jest.fn();
const auditMock = jest.fn();
const emitCodeBlueMock = jest.fn();

const txMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId || '00000000-0000-4000-8000-000000000001'
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordTimelineEvent: timelineMock,
  recordClinicalAuditEvent: auditMock
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitCodeBlue: emitCodeBlueMock
}));

const {
  appendTimelineEntry,
  clearResuscitationFlagCache,
  createEventFromCriticalVital,
  createResuscitationEvent,
  finalizeResuscitationEvent,
  isResuscitationEnabled,
  upsertQaReview,
  upsertTeamRole
} = await import('../../services/clinical/resuscitationEventService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const LEADER = '44444444-4444-4444-8444-444444444444';
const RECORDER = '55555555-5555-4555-8555-555555555555';

const ENABLED_ROW = [{ enabled: true }];

function eventRow(overrides = {}) {
  return {
    id: 9,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    encounter_id: null,
    admission_id: 44,
    emergency_visit_id: null,
    event_kind: 'code_blue',
    trigger_source: 'explicit_staff',
    trigger_clinical_alert_id: null,
    ward_snapshot: 'ICU-A',
    bed_snapshot: 'B12',
    reason: 'unresponsive',
    is_drill: false,
    started_at: new Date('2026-07-09T11:00:00.000Z'),
    ended_at: null,
    outcome: null,
    status: 'active',
    team_leader_uid: null,
    team_leader_name: null,
    recorder_uid: null,
    recorder_name: null,
    post_event_note_status: 'pending',
    finalized_at: null,
    finalized_by: null,
    ...overrides
  };
}

function sqlCalls(mock) {
  return mock.mock.calls.map(call => String(call[0]));
}

describe('resuscitationEventService', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    timelineMock.mockReset();
    auditMock.mockReset();
    emitCodeBlueMock.mockReset();
    clearResuscitationFlagCache();
    setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(txMock));
    timelineMock.mockResolvedValue({ id: 1 });
    auditMock.mockResolvedValue({ id: 2 });
    executeRawMock.mockResolvedValue(1);
  });

  it('explicit trigger creates the durable event + canonical pair and emits a notification with the event id', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW) // flag check
      .mockResolvedValueOnce([{ uid: PATIENT, id: 42, name: 'Pat' }]) // patient
      .mockResolvedValueOnce([{ id: 44, ward: 'ICU-A', bed_number: 'B12' }]) // location snapshot
      .mockResolvedValueOnce([eventRow()]); // INSERT RETURNING

    const row = await createResuscitationEvent({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'doctor',
      patient_uid: PATIENT,
      reason: 'unresponsive'
    });

    expect(row.id).toBe(9);
    expect(row.status).toBe('active');
    const inserts = sqlCalls(queryRawMock).filter(sql => sql.includes('INSERT INTO resuscitation_events'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("'explicit_staff'");
    // canonical timeline + audit written in the same tx
    expect(timelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'resuscitation.event_started',
        patientUid: PATIENT,
        tenantId: TENANT
      }),
      { db: txMock }
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'resuscitation.event.started' }),
      { db: txMock }
    );
    // notification-only WS push carries the durable event id
    expect(emitCodeBlueMock).toHaveBeenCalledTimes(1);
    expect(emitCodeBlueMock.mock.calls[0][0]).toMatchObject({
      eventId: 9,
      ward: 'ICU-A',
      bedNumber: 'B12',
      reason: 'unresponsive'
    });
  });

  it('write paths fail closed when the tenant flag is off', async () => {
    queryRawMock.mockResolvedValueOnce([{ enabled: false }]);
    await expect(
      createResuscitationEvent({
        tenantId: TENANT,
        actorUid: ACTOR,
        patient_uid: PATIENT
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'RESUS_DISABLED' });
    expect(emitCodeBlueMock).not.toHaveBeenCalled();
  });

  it('drill events stay silent (no notification fan-out)', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([{ uid: PATIENT, id: 42, name: 'Pat' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([eventRow({ is_drill: true })]);

    await createResuscitationEvent({
      tenantId: TENANT,
      actorUid: ACTOR,
      patient_uid: PATIENT,
      is_drill: true
    });
    expect(emitCodeBlueMock).not.toHaveBeenCalled();
  });

  it('critical-vital hook no-ops silently when the tenant flag is off', async () => {
    queryRawMock.mockResolvedValueOnce([{ enabled: false }]);
    const result = await createEventFromCriticalVital({
      tenantId: TENANT,
      patientUid: PATIENT,
      clinicalAlertId: 71,
      reason: 'SpO2 62%'
    });
    expect(result).toBeNull();
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(sqlCalls(queryRawMock).some(sql => sql.includes('INSERT INTO resuscitation_events'))).toBe(false);
  });

  it('critical-vital hook persists the durable event and links the alert evidence', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW) // flag
      .mockResolvedValueOnce([{ uid: ACTOR }]) // recorder int id -> uid
      .mockResolvedValueOnce([]) // idempotency probe (no existing event)
      .mockResolvedValueOnce([{ id: 44, ward: 'ICU-A', bed_number: 'B12' }]) // location
      .mockResolvedValueOnce([
        eventRow({ trigger_source: 'critical_vital', trigger_clinical_alert_id: 71 })
      ]) // INSERT event
      .mockResolvedValueOnce([]); // INSERT device link (ON CONFLICT DO NOTHING)

    const row = await createEventFromCriticalVital({
      tenantId: TENANT,
      patientUid: PATIENT,
      patientId: 42,
      clinicalAlertId: 71,
      reason: 'SpO2 62%',
      recordedBy: '17'
    });

    expect(row.trigger_clinical_alert_id).toBe(71);
    const calls = sqlCalls(queryRawMock);
    expect(calls.some(sql => sql.includes('INSERT INTO resuscitation_events') && sql.includes("'critical_vital'"))).toBe(true);
    expect(calls.some(sql => sql.includes('INSERT INTO resuscitation_device_links') && sql.includes("'clinical_alert'"))).toBe(true);
    expect(timelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'resuscitation.event_started' }),
      { db: txMock }
    );
  });

  it('critical-vital hook is idempotent per triggering clinical alert', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([{ id: 9 }]); // idempotency probe hits (no recordedBy -> no uid lookup)

    const row = await createEventFromCriticalVital({
      tenantId: TENANT,
      patientUid: PATIENT,
      clinicalAlertId: 71,
      reason: 'SpO2 62%'
    });

    expect(row).toEqual({ id: 9 });
    expect(sqlCalls(queryRawMock).some(sql => sql.includes('INSERT INTO resuscitation_events'))).toBe(false);
  });

  it('critical-vital hook never throws — a persistence failure degrades to the WS-only path', async () => {
    queryRawMock.mockResolvedValueOnce(ENABLED_ROW);
    setTenantTxMock.mockRejectedValueOnce(new Error('db down'));
    const row = await createEventFromCriticalVital({
      tenantId: TENANT,
      patientUid: PATIENT,
      clinicalAlertId: 71,
      reason: 'SpO2 62%'
    });
    expect(row).toBeNull();
  });

  it('appends ordered timeline entries and REFERENCES the MAR administration (no parallel med-admin lane)', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW) // flag
      .mockResolvedValueOnce([eventRow()]) // assertEvent FOR UPDATE
      .mockResolvedValueOnce([
        {
          id: 501,
          patient_uid: PATIENT,
          medication_name: 'Adrenaline (epinephrine)',
          dose: '1 mg',
          dosage: null,
          route: 'IV',
          status: 'administered'
        }
      ]) // MAR row
      .mockResolvedValueOnce([]) // not already linked
      .mockResolvedValueOnce([{ next_seq: 3 }]) // seq
      .mockResolvedValueOnce([
        {
          id: 31,
          seq: 3,
          entry_type: 'medication',
          medication_name: 'Adrenaline (epinephrine)',
          dose: '1 mg',
          route: 'IV',
          occurred_at: new Date('2026-07-09T11:03:00.000Z'),
          energy_joules: null,
          rhythm: null
        }
      ]) // INSERT timeline
      .mockResolvedValueOnce([
        {
          id: 61,
          link_kind: 'mar_administration',
          mar_administration_id: 501,
          reconciliation_status: 'not_required'
        }
      ]); // INSERT med link

    const result = await appendTimelineEntry({
      tenantId: TENANT,
      eventId: 9,
      actorUid: ACTOR,
      actorRole: 'nurse',
      entry_type: 'medication',
      mar_administration_id: 501
    });

    expect(result.entry.seq).toBe(3);
    expect(result.medication_link.link_kind).toBe('mar_administration');
    expect(result.medication_link.mar_administration_id).toBe(501);

    const calls = sqlCalls(queryRawMock);
    // The MAR row is READ and REFERENCED — never re-administered.
    expect(calls.some(sql => /INSERT INTO medication_administrations/i.test(sql))).toBe(false);
    expect(calls.some(sql => /UPDATE medication_administrations/i.test(sql))).toBe(false);
    expect(calls.some(sql => sql.includes('INSERT INTO resuscitation_medication_links'))).toBe(true);
  });

  it('rejects a MAR administration belonging to a different patient', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([eventRow()])
      .mockResolvedValueOnce([
        { id: 501, patient_uid: '99999999-9999-4999-8999-999999999999', status: 'administered' }
      ]);

    await expect(
      appendTimelineEntry({
        tenantId: TENANT,
        eventId: 9,
        actorUid: ACTOR,
        entry_type: 'medication',
        mar_administration_id: 501
      })
    ).rejects.toMatchObject({ code: 'RESUS_MAR_PATIENT_MISMATCH', statusCode: 409 });
  });

  it('rejects double-linking a MAR administration (no double-administration accounting)', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([eventRow()])
      .mockResolvedValueOnce([
        { id: 501, patient_uid: PATIENT, status: 'administered', medication_name: 'Adrenaline' }
      ])
      .mockResolvedValueOnce([{ id: 61 }]); // already linked

    await expect(
      appendTimelineEntry({
        tenantId: TENANT,
        eventId: 9,
        actorUid: ACTOR,
        entry_type: 'medication',
        mar_administration_id: 501
      })
    ).rejects.toMatchObject({ code: 'RESUS_MAR_ALREADY_LINKED', statusCode: 409 });
  });

  it('documents unlinked emergency doses into MAR reconciliation', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([eventRow()])
      .mockResolvedValueOnce([{ next_seq: 1 }])
      .mockResolvedValueOnce([
        { id: 32, seq: 1, entry_type: 'fluid_bolus', medication_name: 'Normal saline', occurred_at: new Date() }
      ])
      .mockResolvedValueOnce([
        {
          id: 62,
          link_kind: 'unlinked_emergency',
          mar_administration_id: null,
          reconciliation_status: 'pending_mar_reconciliation'
        }
      ]);

    const result = await appendTimelineEntry({
      tenantId: TENANT,
      eventId: 9,
      actorUid: ACTOR,
      entry_type: 'fluid_bolus',
      medication_name: 'Normal saline'
    });

    expect(result.medication_link.link_kind).toBe('unlinked_emergency');
    expect(result.medication_link.reconciliation_status).toBe('pending_mar_reconciliation');
  });

  it('rejects appends on a finalized event (append-only lifecycle)', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([eventRow({ status: 'finalized' })]);

    await expect(
      appendTimelineEntry({
        tenantId: TENANT,
        eventId: 9,
        actorUid: ACTOR,
        entry_type: 'note'
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
  });

  it('blocks finalization when the team leader or recorder is missing', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([
        eventRow({ status: 'ended', ended_at: new Date(), outcome: 'rosc', team_leader_uid: LEADER })
      ]);

    await expect(
      finalizeResuscitationEvent({ tenantId: TENANT, eventId: 9, actorUid: ACTOR })
    ).rejects.toMatchObject({ code: 'RESUS_FINALIZE_BLOCKED', statusCode: 409 });
    expect(sqlCalls(queryRawMock).some(sql => sql.includes("status = 'finalized'"))).toBe(false);
  });

  it('finalizes an ended event once both team leader and recorder are on record', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)
      .mockResolvedValueOnce([
        eventRow({
          status: 'ended',
          ended_at: new Date(),
          outcome: 'rosc',
          team_leader_uid: LEADER,
          recorder_uid: RECORDER
        })
      ])
      .mockResolvedValueOnce([
        eventRow({
          status: 'finalized',
          ended_at: new Date(),
          outcome: 'rosc',
          team_leader_uid: LEADER,
          recorder_uid: RECORDER,
          finalized_at: new Date(),
          finalized_by: ACTOR
        })
      ]);

    const row = await finalizeResuscitationEvent({ tenantId: TENANT, eventId: 9, actorUid: ACTOR });
    expect(row.status).toBe('finalized');
    expect(timelineMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'resuscitation.event_finalized' }),
      { db: txMock }
    );
  });

  it('QA review FAILS CLOSED without approved template content', async () => {
    queryRawMock.mockResolvedValueOnce(ENABLED_ROW);
    await expect(
      upsertQaReview({
        tenantId: TENANT,
        eventId: 9,
        actorUid: ACTOR,
        review_status: 'draft'
        // no template_source / template_version supplied
      })
    ).rejects.toMatchObject({ code: 'RESUS_QA_TEMPLATE_UNAVAILABLE', statusCode: 409 });
  });

  it('flag helper fails closed on query errors and does not cache the failure', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('boom'));
    await expect(isResuscitationEnabled(TENANT)).resolves.toBe(false);
    queryRawMock.mockResolvedValueOnce(ENABLED_ROW);
    await expect(isResuscitationEnabled(TENANT)).resolves.toBe(true);
  });
});

describe('upsertTeamRole signature binding (Sol Ultra LD-RRB-02)', () => {
  it('refuses to sign another clinician\'s participation', async () => {
    queryRawMock
      .mockResolvedValueOnce(ENABLED_ROW)    // assertEnabled
      .mockResolvedValueOnce([eventRow()]);  // assertEvent FOR UPDATE
    await expect(
      upsertTeamRole({
        tenantId: TENANT, eventId: 9, actorUid: ACTOR,
        staff_uid: '44444444-4444-4444-8444-444444444444',
        role: 'team_leader', sign: true,
      })
    ).rejects.toMatchObject({ code: 'RESUS_SIGN_NOT_SELF' });
  });
});
