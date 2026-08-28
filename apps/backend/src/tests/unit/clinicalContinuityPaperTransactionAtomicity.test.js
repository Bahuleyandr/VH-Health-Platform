import { jest } from '@jest/globals';

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  context: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  encounter: '10000000-0000-4000-8000-000000000014',
  fact: '10000000-0000-4000-8000-000000000004',
  incident: '10000000-0000-4000-8000-000000000005',
  item: '10000000-0000-4000-8000-000000000006',
  packet: '10000000-0000-4000-8000-000000000007',
  patient: '10000000-0000-4000-8000-000000000008',
  policy: '10000000-0000-4000-8000-000000000009',
  range: '10000000-0000-4000-8000-000000000010',
  timeline: '10000000-0000-4000-8000-000000000011',
  audit: '10000000-0000-4000-8000-000000000012',
  tenant: '10000000-0000-4000-8000-000000000013',
});

let state;
let transactionTail = Promise.resolve();
let activeParsed;

function freshState() {
  return {
    failAt: null,
    receipt: null,
    domainEffects: 0,
    facts: 0,
    timelines: 0,
    audits: 0,
    outbox: 0,
    effectEvidence: 0,
    paperApplied: 0,
    attempts: 0,
    domainConflict: false,
    reconciliationItems: 0,
    serializeTransactions: false,
  };
}

function snapshotAuthoritativeState() {
  const { failAt: _ignored, ...authoritative } = state;
  return structuredClone(authoritative);
}

function restoreAuthoritativeState(snapshot) {
  const failAt = state.failAt;
  Object.assign(state, structuredClone(snapshot), { failAt });
}

function crashAt(boundary) {
  if (state.failAt === boundary) {
    throw new Error(`fault injection after ${boundary}`);
  }
}

const tx = {
  $executeRawUnsafe: jest.fn(async (sql) => {
    if (sql.includes('clinical_continuity_replay_effect_evidence')) {
      state.effectEvidence += 1;
    } else if (sql.includes('clinical_continuity_replay_attempts')) {
      state.attempts += 1;
    }
    return 1;
  }),
  $queryRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('SELECT item.*, incident.version')) {
      return [{
        id: IDS.item,
        tenant_id: IDS.tenant,
        facility_id: 17,
        incident_id: IDS.incident,
        packet_id: IDS.packet,
        paper_range_id: IDS.range,
        paper_item_id: 'WARD-01/0007',
        patient_uid: IDS.patient,
        temporary_identity_id: null,
        encounter_id: activeParsed.normalized.encounter_id,
        action_id: activeParsed.actionId,
        evidence_hash: 'a'.repeat(64),
        original_actor_uid: IDS.actor,
        original_actor_role: 'NURSING_STAFF',
        occurred_at: '2026-07-31T03:00:00.000Z',
        lifecycle_state: 'reconciling',
        range_status: 'in_use',
        version: 1,
        incident_version: 3,
      }];
    }
    if (sql.includes('SELECT receipt.*, effect.')) {
      return state.receipt ? [state.receipt] : [];
    }
    if (sql.includes('SELECT id, uid::text FROM users')) {
      return [{ id: 901, uid: IDS.patient }];
    }
    if (sql.includes('SELECT uid::text, upper(role) AS role') && sql.includes('uid IN')) {
      return [
        { uid: params[1], role: 'NURSING_STAFF' },
        { uid: params[2], role: 'NURSING_STAFF' },
      ];
    }
    if (sql.includes('SELECT uid::text, upper(role) AS role')) {
      return [{ uid: params[1], role: String(params[2]).toUpperCase() }];
    }
    if (sql.includes('FROM medication_administrations') && sql.includes('FOR UPDATE')) {
      if (state.domainConflict) {
        return [{
          id: 42,
          patient_uid: IDS.patient,
          status: 'administered',
          administered_at: '2026-07-31T04:00:00.000Z',
          administered_by: IDS.device,
          medication_name: 'Paper medication',
          scheduled_time: '2026-07-31T03:00:00.000Z',
          tenant_id: IDS.tenant,
          witness_uid: IDS.context,
        }];
      }
      return [{
        id: 42,
        patient_uid: IDS.patient,
        status: state.domainEffects ? 'administered' : 'scheduled',
        administered_at: state.domainEffects ? '2026-07-31T03:00:00.000Z' : null,
        administered_by: state.domainEffects ? IDS.actor : null,
        medication_name: 'Paper medication',
        scheduled_time: '2026-07-31T03:00:00.000Z',
        tenant_id: IDS.tenant,
        witness_uid: state.domainEffects ? IDS.context : null,
      }];
    }
    if (sql.includes('FROM admissions')) {
      return [{
        id: 41,
        patient_uid: IDS.patient,
        encounter_id: activeParsed.normalized.encounter_id,
        admitted_at: '2026-07-30T03:00:00.000Z',
        discharged_at: null,
      }];
    }
    if (sql.includes('FROM medication_administrations')) return [];
    if (sql.includes('FROM investigations') && sql.includes('FOR UPDATE')) {
      return [{
        id: 43,
        patient_uid: IDS.patient,
        status: state.domainEffects ? 'COLLECTED' : 'REQUESTED',
        collected_at: state.domainEffects ? '2026-07-31T03:00:00.000Z' : null,
        collected_by: state.domainEffects ? IDS.actor : null,
        sample_barcode: state.domainEffects ? 'SPECIMEN-43' : null,
      }];
    }
    if (sql.includes('FROM blood_requests AS request')) {
      return [{
        id: 44,
        patient_uid: IDS.patient,
        status: 'issued',
        crossmatched_unit_id: 45,
        unit_id: 45,
        unit_number: 'UNIT-45',
      }];
    }
    if (sql.includes('FROM transfusion_verifications')) return [];
    if (sql.includes('clinical_continuity_paper_receipt_claim')) {
      if (state.receipt) return [{ claimed: false }];
      const receipt = JSON.parse(params[2]);
      state.receipt = { ...receipt, disposition: 'claimed' };
      crashAt('receipt');
      return [{ claimed: true }];
    }
    if (sql.includes('FROM clinical_continuity_reconciliation_config')) {
      return [{
        fallback_principal: 'role:quality_officer',
        clinical_safety_lead_uid: IDS.actor,
        needs_review_owner_principal: 'role:quality_officer',
        identity_owner_principal: 'role:medical_records',
        interface_owner_principal: 'role:it_admin',
      }];
    }
    if (sql.includes('INSERT INTO clinical_continuity_reconciliation_items')) {
      state.reconciliationItems += 1;
      return [{
        id: IDS.range,
        queue_type: 'needs_review',
        reason_code: 'CONTINUITY_MAR_STATE_CONFLICT',
        task_id: 501,
        version: 1,
      }];
    }
    if (sql.includes('UPDATE medication_administrations')) {
      state.domainEffects += 1;
      return [{
        id: 42,
        patient_uid: IDS.patient,
        medication_name: 'Paper medication',
        scheduled_time: '2026-07-31T03:00:00.000Z',
        administered_at: '2026-07-31T03:00:00.000Z',
        administered_by: IDS.actor,
        status: 'administered',
        notes: 'Signed MAR paper entry',
        witness_uid: IDS.context,
        override_reason: null,
        tenant_id: IDS.tenant,
        patient_scanned_at: null,
        medication_scanned_at: null,
      }];
    }
    if (sql.includes('UPDATE investigations')) {
      state.domainEffects += 1;
      return [{ id: 43 }];
    }
    if (sql.includes('INSERT INTO clinical_continuity_retrospective_facts')) {
      state.facts += 1;
      crashAt('fact');
      return [{ id: IDS.fact, recorded_at: '2026-08-01T03:00:00.000Z' }];
    }
    if (sql.includes('UPDATE clinical_continuity_paper_items')) {
      state.paperApplied += 1;
      return [{ id: IDS.item, version: 2, reconciliation_disposition: 'applied' }];
    }
    if (sql.includes('clinical_continuity_replay_receipt_finalize')) {
      state.receipt.disposition = 'applied';
      state.receipt.outcome_code = params[2];
      Object.assign(state.receipt, {
        retrospective_fact_id: IDS.fact,
        fact_resource_type: 'clinical_continuity_retrospective_fact',
        fact_resource_id: IDS.fact,
        clinical_timeline_event_id: IDS.timeline,
        clinical_audit_event_id: IDS.audit,
        retrospective_event_outbox_id: '71',
      });
      return [{ finalized: true }];
    }
    throw new Error(`Unexpected SQL in transaction test: ${sql.slice(0, 100)}`);
  }),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(async (_tenantId, callback) => {
    const run = async () => {
      const before = snapshotAuthoritativeState();
      try {
        return await callback(tx);
      } catch (error) {
        restoreAuthoritativeState(before);
        throw error;
      }
    };
    if (!state.serializeTransactions) return run();
    const prior = transactionTail;
    let release;
    transactionTail = new Promise(resolve => { release = resolve; });
    await prior;
    try {
      return await run();
    } finally {
      release();
    }
  }),
}));

const recordCanonicalClinicalEvent = jest.fn(async () => {
  state.timelines += 1;
  crashAt('timeline');
  state.audits += 1;
  crashAt('audit');
  return { timeline: { id: IDS.timeline }, audit: { id: IDS.audit } };
});
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent: jest.fn(async () => ({ id: IDS.audit })),
  recordMedicationSafetyReviews: jest.fn(),
}));

const publishEvent = jest.fn(async () => {
  state.outbox += 1;
  crashAt('outbox');
  return { id: 71 };
});
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent,
}));

const createTask = jest.fn();
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  claimMarMedicationExceptionTaskTx: jest.fn(),
  completeTaskFromDomainEvidence: jest.fn(),
  createApproval: jest.fn(),
  createMarMedicationExceptionTaskTx: jest.fn(),
  createTask,
  recordApprovalDecision: jest.fn(),
  transitionTask: jest.fn(),
}));

jest.unstable_mockModule('../../services/downtime/clinicalContinuityPolicyService.js', () => ({
  INCIDENT_PACKET_SIGNING_KEY_PURPOSE: 'clinical_continuity_incident_packet_signing',
  INCIDENT_PACKET_SIGNING_PURPOSE: 'vhhealth/continuity/incident-packet/v1',
  loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(),
  requireClinicalContinuityIncidentPacketPolicy: jest.fn(),
}));

const { applyClinicalContinuityPaperBackEntry } = await import(
  '../../services/downtime/clinicalContinuityReconciliationService.js'
);
const { parseClinicalContinuityPaperCommand } = await import(
  '../../validators/clinicalContinuityPaperSchemas.js'
);

const parsed = parseClinicalContinuityPaperCommand({
  actionId: 'mar.administration.backfill',
  incidentId: IDS.incident,
  paperItemId: 'WARD-01/0007',
  body: {
    expected_version: 1,
    occurred_at: '2026-07-31T03:00:00.000Z',
    original_actor_uid: IDS.actor,
    original_actor_role: 'NURSING_STAFF',
    patient_uid: IDS.patient,
    encounter_id: null,
    evidence_hash: 'a'.repeat(64),
    admission_id: 41,
    medication_administration_id: 42,
    checker_uid: IDS.context,
    checker_role: 'NURSING_STAFF',
    notes: 'Signed MAR paper entry',
  },
});
const parsedLab = parseClinicalContinuityPaperCommand({
  actionId: 'lab.specimen_collection.backfill',
  incidentId: IDS.incident,
  paperItemId: 'WARD-01/0007',
  body: {
    expected_version: 1,
    occurred_at: '2026-07-31T03:00:00.000Z',
    original_actor_uid: IDS.actor,
    original_actor_role: 'NURSING_STAFF',
    patient_uid: IDS.patient,
    encounter_id: null,
    evidence_hash: 'a'.repeat(64),
    investigation_id: 43,
    specimen_barcode: 'SPECIMEN-43',
    checker_uid: IDS.context,
    checker_role: 'NURSING_STAFF',
    collection_notes: 'Paper collection evidence',
  },
});
const parsedTransfusion = parseClinicalContinuityPaperCommand({
  actionId: 'blood.transfusion_verification.backfill',
  incidentId: IDS.incident,
  paperItemId: 'WARD-01/0007',
  body: {
    expected_version: 1,
    occurred_at: '2026-07-31T03:00:00.000Z',
    original_actor_uid: IDS.actor,
    original_actor_role: 'NURSING_STAFF',
    patient_uid: IDS.patient,
    encounter_id: IDS.encounter,
    evidence_hash: 'a'.repeat(64),
    blood_request_id: 44,
    blood_unit_id: 45,
    first_verifier_uid: IDS.context,
    second_verifier_uid: IDS.device,
    scanned_unit_number: 'UNIT-45',
    unit_match: true,
    patient_match: true,
    group_compatible: true,
    expiry_ok: true,
  },
});

const facilityContext = Object.freeze({
  actorUid: IDS.actor,
  tenantId: IDS.tenant,
  facilityId: 17,
  contextId: IDS.context,
  contextRevision: 4,
  deviceId: IDS.device,
  policyId: IDS.policy,
  policyVersion: '3',
  policyChecksum: 'b'.repeat(64),
  policySigningKeyId: 'continuity-test-key',
  revocationEpoch: '2',
});

const policy = Object.freeze({
  id: IDS.policy,
  policyVersion: '3',
  policyChecksum: 'b'.repeat(64),
  policySigningKeyId: 'continuity-test-key',
  effectiveFrom: '2026-07-01T00:00:00.000Z',
  effectiveUntil: '2026-09-01T00:00:00.000Z',
  supersedesPolicyId: null,
  revocationEpoch: '2',
  actionRegistryVersion: '1',
  actionRegistryChecksum: 'c'.repeat(64),
  policyDocument: { minimumAppVersion: 'paper-workbench/v1' },
  trustedNow: '2026-08-01T03:00:00.000Z',
});

function apply({
  policyOverride = policy,
  patientAuthorizer = async () => true,
  parsedOverride = parsed,
} = {}) {
  activeParsed = parsedOverride;
  return applyClinicalContinuityPaperBackEntry({
    tenantId: IDS.tenant,
    facilityId: 17,
    actorUid: IDS.actor,
    actorRole: 'NURSING_STAFF',
    facilityContext,
    parsed: parsedOverride,
    patientAuthorizer,
    policyLoader: async () => policyOverride,
  });
}

describe('C5.2 single-transaction crash/retry contract', () => {
  beforeEach(() => {
    state = freshState();
    activeParsed = parsed;
    transactionTail = Promise.resolve();
    jest.clearAllMocks();
  });

  test.each(['receipt', 'fact', 'timeline', 'audit', 'outbox'])(
    'rolls back every authoritative boundary after a %s fault, then reaches one terminal outcome',
    async (boundary) => {
      state.failAt = boundary;
      await expect(apply()).rejects.toThrow(`fault injection after ${boundary}`);
      const expectedEmpty = freshState();
      delete expectedEmpty.failAt;
      expect(snapshotAuthoritativeState()).toEqual(expectedEmpty);

      state.failAt = null;
      const first = await apply();
      expect(first).toMatchObject({ disposition: 'applied', replayed: false });
      expect(state).toMatchObject({
        domainEffects: 1,
        facts: 1,
        timelines: 1,
        audits: 1,
        outbox: 1,
        effectEvidence: 1,
        paperApplied: 1,
      });
      expect(state.receipt).toMatchObject({ disposition: 'applied' });
      expect(state.receipt).toMatchObject({
        action_checksum: '26884e408883b51609058a037fe08e90d23223a04244f41a03eb3e3824a281b4',
        admission_id: 41,
        schema_version: 2,
      });

      const beforeDuplicate = snapshotAuthoritativeState();
      const duplicate = await apply();
      expect(duplicate).toMatchObject({ disposition: 'applied', replayed: true });
      expect(state.facts).toBe(beforeDuplicate.facts);
      expect(state.domainEffects).toBe(beforeDuplicate.domainEffects);
      expect(state.outbox).toBe(beforeDuplicate.outbox);
      expect(state.attempts).toBe(beforeDuplicate.attempts + 1);
    },
  );

  test('routes a current-domain-state conflict to review without claiming a receipt or creating an effect', async () => {
    state.domainConflict = true;
    const result = await apply();
    expect(result).toMatchObject({
      disposition: 'needs_review',
      code: 'CONTINUITY_MAR_STATE_CONFLICT',
    });
    expect(state).toMatchObject({
      receipt: null,
      domainEffects: 0,
      facts: 0,
      timelines: 0,
      audits: 0,
      outbox: 0,
      effectEvidence: 0,
      paperApplied: 0,
      reconciliationItems: 1,
      attempts: 1,
    });
  });

  test('rechecks current patient access before receipt visibility', async () => {
    const patientAuthorizer = jest.fn(async () => ({ allowed: false }));
    state.receipt = {
      action_id: parsed.actionId,
      receipt_fingerprint: 'receipt-must-remain-hidden',
    };

    await expect(apply({ patientAuthorizer })).rejects.toMatchObject({
      code: 'CONTINUITY_PAPER_PATIENT_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(patientAuthorizer).toHaveBeenCalledWith({
      patientUid: IDS.patient,
      patientId: 901,
    });
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('SELECT receipt.*, effect.'))).toBe(false);
    expect(state).toMatchObject({
      domainEffects: 0,
      facts: 0,
      timelines: 0,
      audits: 0,
      outbox: 0,
      effectEvidence: 0,
      paperApplied: 0,
      attempts: 0,
      reconciliationItems: 0,
    });
  });

  test('routes a paper fact outside the seven-day capture window to review without claiming a receipt', async () => {
    const result = await apply({
      policyOverride: {
        ...policy,
        trustedNow: '2026-08-07T03:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      disposition: 'needs_review',
      code: 'CONTINUITY_PAPER_ACCEPTANCE_EXPIRED',
    });
    expect(state).toMatchObject({
      receipt: null,
      domainEffects: 0,
      facts: 0,
      timelines: 0,
      audits: 0,
      outbox: 0,
      effectEvidence: 0,
      paperApplied: 0,
      reconciliationItems: 1,
      attempts: 1,
    });
  });

  test('serializes concurrent identical submissions into one fact and terminal duplicate receipts', async () => {
    state.serializeTransactions = true;
    const results = await Promise.all(Array.from({ length: 8 }, () => apply()));
    expect(results.filter(result => result.replayed === false)).toHaveLength(1);
    expect(results.filter(result => result.replayed === true)).toHaveLength(7);
    expect(state).toMatchObject({
      domainEffects: 1,
      facts: 1,
      timelines: 1,
      audits: 1,
      outbox: 1,
      effectEvidence: 1,
      paperApplied: 1,
      attempts: 8,
    });
    expect(state.receipt).toMatchObject({ disposition: 'applied' });
  });

  test('uses all three clocks and emits one typed late-pending disposition', async () => {
    await apply();
    expect(state.receipt).toMatchObject({
      captured_at: '2026-07-31T03:00:00.000Z',
      queued_at: '2026-07-31T03:00:00.000Z',
      received_at: '2026-08-01T03:00:00.000Z',
      expires_at: '2026-08-07T03:00:00.000Z',
    });
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'continuity.paper_fact.recorded',
        occurredAt: '2026-07-31T03:00:00.000Z',
        visibleToPatient: true,
        payload: expect.objectContaining({
          occurred_at: '2026-07-31T03:00:00.000Z',
          recorded_at: '2026-08-01T03:00:00.000Z',
          reviewed_at: null,
          decided_at: null,
          effect_disposition: 'late_pending_only',
          retrospective: true,
        }),
      }),
      { db: tx, strict: true },
    );
    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      occurredAt: '2026-07-31T03:00:00.000Z',
      retrospectiveEffectDisposition: 'late_pending_only',
      payload: expect.objectContaining({
        event_time_source: 'physical_occurrence',
        effect_disposition: 'late_pending_only',
      }),
      tx,
    }));
    expect(publishEvent.mock.calls[0][0].payload).not.toEqual(expect.objectContaining({
      suppress_sla_breach_alarm: expect.anything(),
      suppress_care_pathway_transition: expect.anything(),
      suppress_patient_notification: expect.anything(),
    }));
    expect(createTask).not.toHaveBeenCalled();
  });

  test('records a late specimen fact through its exact historical projection without a live handler', async () => {
    const result = await apply({ parsedOverride: parsedLab });
    expect(result).toMatchObject({ disposition: 'applied', replayed: false });
    expect(state).toMatchObject({
      domainEffects: 1,
      facts: 1,
      timelines: 1,
      audits: 1,
      outbox: 1,
      effectEvidence: 1,
      paperApplied: 1,
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  test('records transfusion verification only as retrospective evidence and never arms live verification', async () => {
    const result = await apply({ parsedOverride: parsedTransfusion });
    expect(result).toMatchObject({ disposition: 'applied', replayed: false });
    expect(state).toMatchObject({
      domainEffects: 0,
      facts: 1,
      timelines: 1,
      audits: 1,
      outbox: 1,
      effectEvidence: 1,
      paperApplied: 1,
    });
    expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => sql.includes('transfusion_verifications'))).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });
});
