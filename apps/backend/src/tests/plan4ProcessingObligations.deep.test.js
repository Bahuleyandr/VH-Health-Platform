import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  admitActualUseTx,
  discardDeviceTx,
  evaluateOutstandingObligationsTx,
  placeHoldTx,
  registerDeviceTx,
  releaseHoldTx,
  releaseToAvailableTx,
  recordRetrospectiveReturnTx,
  reserveDeviceTx,
  restoreUnusedCaptureTx,
  returnDeviceTx,
} from '../services/clinical/reprocessableDeviceService.js';
import {
  createProtocolDeviceScopeTx,
  createProtocolRevisionTx,
} from '../services/clinical/reprocessingProtocolService.js';
import { evaluateReuseEligibility } from '../services/clinical/reprocessableDeviceRules.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('Plan 4 processing obligations', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tx = { $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows };
  let tenantId;
  let actor;
  let protocol;
  let scope;
  let device;
  let patientId;

  beforeAll(() => client.connect());
  afterAll(() => client.end());
  beforeEach(async () => {
    await client.query('BEGIN');
    tenantId = randomUUID();
    actor = { uid: randomUUID(), role: 'INFECTION_CONTROL_OFFICER' };
    await client.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Processing obligations')",
      [tenantId, randomUUID()]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1, $2, $3, 'Processing patient', 'INFECTION_CONTROL_OFFICER', TRUE, 'active', NOW())`,
      [actor.uid, tenantId, randomUUID().replaceAll('-', '').slice(0, 14)],
    );
    patientId = (await client.query(
      "INSERT INTO dialysis_patients (tenant_id, patient_uid, modality) VALUES ($1, $2, 'hd') RETURNING id",
      [tenantId, actor.uid],
    )).rows[0].id;
    protocol = await createProtocolRevisionTx(tx, {
      tenantId,
      input: {
        protocol_key: randomUUID(), domain: 'dialysis', category: 'dialyser',
        name: 'Processing obligations', basis: 'manufacturer_ifu', reference: 'IFU-OBLIGATIONS',
        approved_by: actor.uid, approved_role: actor.role,
        approved_at: new Date().toISOString(), status: 'active',
        tcv_min_pct: 80, baseline_tcv_required: true, mid_life_enrolment_rule: 'refuse',
        residual_test_required: true, integrity_test_required: true,
        agents: [{ agent: 'peracetic_acid', min_concentration_pct: 0.2,
          max_concentration_pct: 0.4, min_contact_minutes: 11 }],
        reuse_matrix: { hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse' },
        surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 90 },
        surveillance_overdue_blocks_reuse: true, prion_rule: 'discard', created_by: actor.uid,
      },
    });
    scope = await createProtocolDeviceScopeTx(tx, {
      tenantId, protocolId: protocol.id,
      input: { category: 'dialyser', manufacturer: 'Maker', model_name: 'Model',
        ifu_reference: protocol.reference, nominal_tcv_ml: 100, single_use: false,
        approved_at: new Date().toISOString(), created_by: actor.uid },
    });
    await client.query(
      `INSERT INTO reprocessing_domain_policies
         (tenant_id, domain, category, reprocessable, allowed_cycle_types, protocol_id)
       VALUES ($1, 'dialysis', 'dialyser', TRUE, ARRAY['chemical'], $2)`,
      [tenantId, protocol.id],
    );
    device = await mint();
  });
  afterEach(() => client.query('ROLLBACK'));

  function mint(input = {}) {
    return registerDeviceTx(tx, { tenantId, actor, input: {
      domain: 'dialysis', category: 'dialyser', manufacturer: 'Maker', model_name: 'Model',
      manufacturer_serial: randomUUID(), protocol_device_scope_id: scope.id,
      enrolled_via: 'session_capture', ...input,
    } });
  }

  async function capture(current = device, residualTest = 'negative') {
    const session = (await client.query(
      `INSERT INTO dialysis_sessions (tenant_id, dialysis_patient_id, modality)
       VALUES ($1, $2, 'hd') RETURNING id`, [tenantId, patientId],
    )).rows[0];
    return reserveDeviceTx(tx, { tenantId, deviceId: current.id,
      expectedVersion: current.version, patientUid: actor.uid,
      owner: { dialysis_session_id: session.id }, captureSource: 'staff_app',
      preUseResidualTest: residualTest, actor });
  }

  async function endedUse() {
    const captured = await capture();
    const returned = await returnDeviceTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: captured.device.version, actor, disposition: 'sent_for_reprocessing' });
    device = returned.device;
    return returned.usage;
  }

  function processing(usage, overrides = {}, eligibility = { verdict: 'eligible', reason_codes: [] }, recordingMode = 'performed') {
    return releaseToAvailableTx(tx, {
      tenantId, deviceId: device.id, expectedVersion: device.version, actor, protocol, scope,
      eligibility, recordingMode,
      evidence: { baseline_tcv_ml: 100, baseline_tcv_source: 'pre_use', measured_tcv_ml: 90,
        integrity_test_result: 'pass',
        reprocessing_agent: 'peracetic_acid', disinfectant_concentration_pct: 0.3,
        disinfectant_contact_minutes: 12 },
      occurrence: { kind: 'chemical_reprocessing', protocol_id: protocol.id,
        cycle_type: 'chemical', recorded_via: 'dialysis_record', device_usage_id: usage.id,
        device_last_returned_at: usage.returned_at, ...overrides },
    });
  }

  test('exposureReleaseProcessingSatisfiesAndReissuesWithoutErasingHistory', async () => {
    const usage = await endedUse();
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'bloodborne_exposure',
      reasonCode: 'exposure_at_return', placedVia: 'return', placedBy: actor.uid });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor, approval: {
        approved_by: actor.uid, approved_role: actor.role, approved_at: new Date().toISOString(),
        adjudication: 'Approved new processing', protocol_id: protocol.id, requires_processing: true,
      } });
    device = released.device;
    expect(device.status).toBe('awaiting_reprocessing');
    const processed = await processing(usage);
    expect(processed.criteria).toEqual({ verdict: 'released', missing_evidence: [] });
    expect(processed.obligations).toEqual([]);
    expect(processed.device).toMatchObject({ status: 'available', exposure_flag: true,
      cycle_count: 1, residual_test_pending: true });
    const satisfaction = (await client.query(
      `SELECT hold_id, device_id, required_protocol_id, processing_event_id
         FROM reprocessable_hold_satisfactions WHERE tenant_id = $1`, [tenantId],
    )).rows;
    expect(satisfaction).toHaveLength(1);
    expect(satisfaction[0]).toMatchObject({ hold_id: held.hold.id, device_id: device.id,
      required_protocol_id: protocol.id, processing_event_id: processed.event.id });
    const storedUsage = (await client.query(
      'SELECT post_use_processing_event_id FROM reprocessable_device_usages WHERE tenant_id = $1 AND id = $2',
      [tenantId, usage.id],
    )).rows[0];
    expect(storedUsage.post_use_processing_event_id).toBe(processed.event.id);
    const recaptured = await capture(processed.device);
    expect(recaptured.device).toMatchObject({ status: 'in_case', residual_test_pending: false });
  });

  test('deactivatedPolicyRecordsOccurrenceWithoutGrantingReadiness', async () => {
    const usage = await endedUse();
    await client.query('UPDATE reprocessing_domain_policies SET reprocessable = FALSE WHERE tenant_id = $1', [tenantId]);
    const result = await processing(usage);
    expect(result.event.initial_outcome).toBe('passed');
    expect(result.criteria.verdict).toBe('not_established');
    expect(result.obligations).toContain('policy_inactive');
    expect(result.device.status).toBe('awaiting_reprocessing');
    expect(result.device.last_processing_event_id).toBeNull();
  });

  test('activeHoldKeepsProcessingOccurrenceHistorical', async () => {
    const usage = await endedUse();
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'manual', reasonCode: 'manual_cssd', placedVia: 'manual' });
    device = held.device;
    const result = await processing(usage);
    expect(result.event.initial_outcome).toBe('passed');
    expect(result.device.status).toBe('quarantined');
    expect(result.device.last_processing_event_id).toBeNull();
    expect(result.obligations).toContain(`active_hold:${held.hold.id}`);
  });

  test('processingBeforeHoldAuthorizationCannotSatisfyIt', async () => {
    await client.query("UPDATE users SET role = 'QUALITY_OFFICER' WHERE tenant_id = $1 AND uid = $2", [tenantId, actor.uid]);
    const usage = await endedUse();
    await client.query('UPDATE reprocessable_device_usages SET returned_at = $3 WHERE tenant_id = $1 AND id = $2',
      [tenantId, usage.id, '2026-01-01T00:00:00Z']);
    usage.returned_at = new Date('2026-01-01T00:00:00Z');
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'sterilization_failed', reasonCode: 'load_failed', placedVia: 'manual' });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor: { ...actor, role: 'QUALITY_OFFICER' }, approval: {
        approved_by: actor.uid, approved_role: 'QUALITY_OFFICER', approved_at: new Date().toISOString(),
        adjudication: 'Processing required', protocol_id: protocol.id,
      } });
    device = released.device;
    const result = await processing(usage, { occurred_at: '2026-02-01T00:00:00Z' });
    expect(result.criteria.verdict).toBe('not_established');
    expect(result.obligations).toContain(`released_hold_processing:${held.hold.id}`);
    expect((await client.query('SELECT id FROM reprocessable_hold_satisfactions WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
  });

  test('notConnectedClearsEpisodeResidualEvidenceAndRequiresFreshProcessing', async () => {
    const captured = await capture();
    const restored = await restoreUnusedCaptureTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: captured.device.version, packCondition: 'not_connected', actor });
    expect(restored.device.status).toBe('awaiting_reprocessing');
    expect(restored.usage.pre_use_residual_test).toBeNull();
    const obligations = await evaluateOutstandingObligationsTx(tx, { tenantId, deviceId: device.id });
    expect(obligations).toContain('dirty_return');
    expect(obligations).toContain('residual_test_pending');
  });

  test('actualUseMutationHasVersionAndOperationReceipt', async () => {
    const captured = await capture();
    const admitted = await admitActualUseTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: captured.device.version });
    expect(admitted.device.version).toBe(captured.device.version + 1);
    expect(admitted.receipt).toMatchObject({ action: 'admit_actual_use',
      version_before: captured.device.version, version_after: admitted.device.version });
    expect(Number(admitted.receipt.audit_id)).toBeGreaterThan(0);
    const audits = (await client.query(
      `SELECT a.id, a.action FROM reprocessable_device_operations o
       JOIN audit_logs a ON a.tenant_id = o.tenant_id AND a.id = o.audit_id
       WHERE o.tenant_id = $1 AND o.device_id = $2 ORDER BY o.version_after`,
      [tenantId, device.id],
    )).rows;
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.action)).toEqual(['register', 'reserve', 'admit_actual_use']);
  });

  test('ordinaryProcessingNeverSatisfiesPrionPathway', async () => {
    await client.query("UPDATE users SET role = 'CONSULTANT' WHERE tenant_id = $1 AND uid = $2", [tenantId, actor.uid]);
    const usage = await endedUse();
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'prion_exposure',
      reasonCode: 'manual_ic', placedVia: 'manual' });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor: { ...actor, role: 'CONSULTANT' }, approval: {
        approved_by: actor.uid, approved_role: 'CONSULTANT', approved_at: new Date().toISOString(),
        adjudication: 'Only specifically authorised pathway may satisfy', protocol_id: protocol.id,
      } });
    device = released.device;
    const processed = await processing(usage);
    expect(processed.criteria.verdict).toBe('not_established');
    expect(processed.obligations).toContain(`released_hold_processing:${held.hold.id}`);
    expect((await client.query('SELECT id FROM reprocessable_hold_satisfactions WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
  });

  test('holdSatisfactionPinsExactRequiredProtocolRevision', async () => {
    const usage = await endedUse();
    const anotherProtocol = await createProtocolRevisionTx(tx, { tenantId, input: {
      ...protocol, protocol_key: randomUUID(), supersedes_protocol_id: null,
      approved_by: actor.uid, approved_role: actor.role, approved_at: new Date().toISOString(),
    } });
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'bloodborne_exposure',
      reasonCode: 'exposure_at_return', placedVia: 'return' });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor, approval: {
        approved_by: actor.uid, approved_role: actor.role, approved_at: new Date().toISOString(),
        adjudication: 'A different immutable revision is required', protocol_id: anotherProtocol.id,
      } });
    device = released.device;
    const processed = await processing(usage);
    expect(processed.criteria.verdict).toBe('not_established');
    expect(processed.obligations).toContain('release_protocol_mismatch');
    expect((await client.query('SELECT id FROM reprocessable_hold_satisfactions WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
  });

  test('erroneousHoldReleaseCannotEraseIndependentDirtyResidualOrInvalidatedReadiness', async () => {
    await client.query("UPDATE users SET role = 'QUALITY_OFFICER' WHERE tenant_id = $1 AND uid = $2", [tenantId, actor.uid]);
    const usage = await endedUse();
    const processed = await processing(usage);
    device = processed.device;
    await client.query(
      `INSERT INTO device_processing_event_revisions
         (tenant_id, processing_event_id, device_id, load_revision, outcome, reason,
          observed_at, source_load_updated_at)
       VALUES ($1, $2, $3, 1, 'invalidated', 'Independent invalidation',
          clock_timestamp(), clock_timestamp())`,
      [tenantId, processed.event.id, device.id],
    );
    await client.query('UPDATE reprocessable_devices SET residual_test_pending = TRUE WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id]);
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'sterilization_failed',
      reasonCode: 'load_failed', placedVia: 'manual' });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor: { ...actor, role: 'QUALITY_OFFICER' }, approval: {
        approved_by: actor.uid, approved_role: 'QUALITY_OFFICER', approved_at: new Date().toISOString(),
        adjudication: 'This one hold was entered in error', requires_processing: false,
      } });
    expect(released.device.status).toBe('awaiting_reprocessing');
    const obligations = await evaluateOutstandingObligationsTx(tx, { tenantId, deviceId: device.id });
    expect(obligations).toHaveLength(3);
    expect(obligations).toEqual(['dirty_return', 'readiness_invalidated', 'residual_test_pending']);
  });

  test('midLifeMintPreservesCountAndEnrolmentProvenance', async () => {
    const enrolled = await mint({ initial_cycle_count: 2, max_cycles_snapshot: 2 });
    expect(enrolled.cycle_count).toBe(2);
    expect(enrolled.metadata.enrolled_mid_life).toBe(true);
    await expect(mint({ initial_cycle_count: 3, max_cycles_snapshot: 2 }))
      .rejects.toMatchObject({ code: 'RPD_MAX_CYCLES_REACHED' });
  });

  test('physicalProcessingNeverSubstitutesForFreshCaptureResidualEvidence', async () => {
    const usage = await endedUse();
    const processed = await processing(usage);
    expect(processed.criteria).toEqual({ verdict: 'released', missing_evidence: [] });
    expect(processed.device.residual_test_pending).toBe(true);
    await expect(capture(processed.device, null)).rejects.toMatchObject({ code: 'RPD_RESIDUAL_TEST_REQUIRED' });
    const captured = await capture(processed.device);
    expect(captured.device.residual_test_pending).toBe(false);
    const restored = await restoreUnusedCaptureTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: captured.device.version, packCondition: 'sealed_unopened', actor });
    expect(restored.device).toMatchObject({ status: 'available', residual_test_pending: true });
    expect(restored.usage.pre_use_residual_test).toBeNull();
    await expect(capture(restored.device, null)).rejects.toMatchObject({ code: 'RPD_RESIDUAL_TEST_REQUIRED' });
  });

  test('missingPatientReuseDecisionCannotAuthorizeProcessingRelease', async () => {
    const usage = await endedUse();
    const processed = await processing(usage, {}, null);
    expect(processed.event.initial_outcome).toBe('passed');
    expect(processed.criteria.verdict).toBe('not_established');
    expect(processed.obligations).toContain('reuse_not_established');
    expect(processed.device.status).toBe('awaiting_reprocessing');
  });

  test('rnaEvidenceRefusalKeepsReleaseEventReceiptAndAuditMarkerFreeByValue', async () => {
    const usage = await endedUse();
    const eligibility = evaluateReuseEligibility({
      protocol: { ...protocol, reuse_matrix: { ...protocol.reuse_matrix, hcv: 'dedicated_reuse' } },
      decision: { status: 'restricted', isolation_class: 'hcv', evidence_dated_on: '2026-09-08' },
      device, patientUid: actor.uid, dedicatedPatientUid: actor.uid,
      asOf: '2026-09-08T12:00:00.000Z',
    });
    expect(eligibility.verdict).toBe('not_established');
    const processed = await processing(usage, {}, eligibility);
    expect(processed.criteria).toEqual({ verdict: 'not_established',
      missing_evidence: ['residual_test_pending', ...eligibility.reason_codes] });
    expect(processed.device.status).toBe('awaiting_reprocessing');
    const events = (await client.query(
      'SELECT * FROM device_processing_events WHERE tenant_id = $1 AND device_id = $2',
      [tenantId, device.id],
    )).rows;
    const receipts = (await client.query(
      'SELECT * FROM reprocessable_device_operations WHERE tenant_id = $1 AND device_id = $2 ORDER BY version_after',
      [tenantId, device.id],
    )).rows;
    const audits = (await client.query(
      `SELECT a.* FROM audit_logs a JOIN reprocessable_device_operations o
         ON o.tenant_id = a.tenant_id AND o.audit_id = a.id
       WHERE o.tenant_id = $1 AND o.device_id = $2 ORDER BY o.version_after`,
      [tenantId, device.id],
    )).rows;
    expect(events).toHaveLength(1);
    expect(receipts).toHaveLength(4);
    expect(audits).toHaveLength(4);
    const surfaces = [processed, events, receipts, audits, eligibility];
    expect(surfaces).toHaveLength(5);
    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
      expect(serialized).not.toMatch(/hbsag|\bhbv\b|hcv|hiv|hepatitis|isolation_mixed/i);
    }
    expect(eligibility).toEqual({ verdict: 'not_established', reason_codes: ['RPD_REUSE_EVIDENCE_REQUIRED'] });
  });

  test('invalidatedSatisfactionReopensExactProtocolObligation', async () => {
    const usage = await endedUse();
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'bloodborne_exposure',
      reasonCode: 'exposure_at_return', placedVia: 'return' });
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor, approval: {
        approved_by: actor.uid, approved_role: actor.role, approved_at: new Date().toISOString(),
        adjudication: 'Processing under this exact revision is required', protocol_id: protocol.id,
      } });
    device = released.device;
    const processed = await processing(usage);
    expect(processed.device.status).toBe('available');
    device = processed.device;
    await client.query(
      `INSERT INTO device_processing_event_revisions
         (tenant_id, processing_event_id, device_id, load_revision, outcome, reason,
          observed_at, source_load_updated_at)
       VALUES ($1, $2, $3, 1, 'invalidated', 'Satisfaction evidence invalidated',
          clock_timestamp(), clock_timestamp())`,
      [tenantId, processed.event.id, device.id],
    );
    const obligations = await evaluateOutstandingObligationsTx(tx, {
      tenantId, deviceId: device.id, protocolId: protocol.id, protocolDeviceScopeId: scope.id,
    });
    expect(obligations).toContain(`released_hold_processing:${held.hold.id}`);
    const corrected = await processing(usage);
    expect(corrected.device.status).toBe('available');
    const satisfactions = (await client.query(
      `SELECT processing_event_id FROM reprocessable_hold_satisfactions
        WHERE tenant_id = $1 AND hold_id = $2 ORDER BY id`, [tenantId, held.hold.id],
    )).rows;
    expect(satisfactions).toHaveLength(2);
    expect(satisfactions.map((row) => row.processing_event_id)).toEqual([processed.event.id, corrected.event.id]);
  });

  test('administrativeHoldReleaseRequiresDistinctCurrentlyAssignedClinicalApprover', async () => {
    const held = await placeHoldTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, holdType: 'bloodborne_exposure',
      reasonCode: 'manual_ic', placedVia: 'manual' });
    const roles = ['ADMIN', 'SUPER_ADMIN'];
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      await client.query('UPDATE users SET role = $3 WHERE tenant_id = $1 AND uid = $2',
        [tenantId, actor.uid, role]);
      await expect(releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
        expectedVersion: held.device.version, actor: { ...actor, role }, approval: {
          approved_by: actor.uid, approved_role: 'INFECTION_CONTROL_OFFICER',
          approved_at: new Date().toISOString(), adjudication: 'Forged clinical authority',
          protocol_id: protocol.id,
        } })).rejects.toMatchObject({ code: 'RPD_ACCOUNTABLE_APPROVAL_REQUIRED' });
    }
    const approverUid = randomUUID();
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1, $2, $3, 'Actual IC approver', 'INFECTION_CONTROL_OFFICER', TRUE, 'active', NOW())`,
      [approverUid, tenantId, randomUUID().replaceAll('-', '').slice(0, 14)],
    );
    await client.query("UPDATE users SET role = 'DOCTOR' WHERE tenant_id = $1 AND uid = $2", [tenantId, approverUid]);
    const distinctApproval = { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor: { ...actor, role: 'SUPER_ADMIN' }, approval: {
        approved_by: approverUid, approved_role: 'INFECTION_CONTROL_OFFICER',
        approved_at: new Date().toISOString(), adjudication: 'Actual approved clinical decision',
        protocol_id: protocol.id,
      } };
    await expect(releaseHoldTx(tx, distinctApproval)).rejects.toMatchObject({ code: 'RPD_ACCOUNTABLE_APPROVAL_REQUIRED' });
    await client.query("UPDATE users SET role = 'INFECTION_CONTROL_OFFICER', is_active = FALSE WHERE tenant_id = $1 AND uid = $2", [tenantId, approverUid]);
    await expect(releaseHoldTx(tx, distinctApproval)).rejects.toMatchObject({ code: 'RPD_ACCOUNTABLE_APPROVAL_REQUIRED' });
    await client.query('UPDATE users SET is_active = TRUE WHERE tenant_id = $1 AND uid = $2', [tenantId, approverUid]);
    const released = await releaseHoldTx(tx, { tenantId, holdId: held.hold.id,
      expectedVersion: held.device.version, actor: { ...actor, role: 'SUPER_ADMIN' }, approval: {
        approved_by: approverUid, approved_role: 'INFECTION_CONTROL_OFFICER',
        approved_at: new Date().toISOString(), adjudication: 'Actual approved clinical decision',
        protocol_id: protocol.id,
      } });
    expect(released.hold.status).toBe('released');
    expect(released.hold.release_evidence.accountable_approval.approved_by).toBe(approverUid);
    expect(released.hold.release_evidence.administrative_applicator.applied_by).toBe(actor.uid);
  });

  test('retrospectiveReturnRecordsNonAvailableStateWithoutProcessingCycle', async () => {
    const usage = await endedUse();
    await client.query(
      `UPDATE reprocessable_device_usages SET capture_provenance = 'retrospective',
         actual_use_started_at = returned_at - INTERVAL '1 hour' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, usage.id],
    );
    const returned = await recordRetrospectiveReturnTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, usageId: usage.id, actor });
    expect(returned.device).toMatchObject({ status: 'awaiting_reprocessing', cycle_count: 0,
      residual_test_pending: true, last_processing_event_id: null });
    expect(returned.receipt.action).toBe('record_retrospective_return');
    expect(Number(returned.receipt.audit_id)).toBeGreaterThan(0);
    expect((await client.query('SELECT id FROM device_processing_events WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
  });

  test('discardedRetrospectiveExposureIsRecordedWithoutCreatingNewHoldOrReadiness', async () => {
    const usage = await endedUse();
    await client.query(
      `UPDATE reprocessable_device_usages SET capture_provenance = 'retrospective',
         actual_use_started_at = returned_at - INTERVAL '1 hour' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, usage.id],
    );
    const discarded = await discardDeviceTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: device.version, reason: 'other', actor });
    expect(discarded.device).toMatchObject({ status: 'discarded', exposure_flag: false });
    const returned = await recordRetrospectiveReturnTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: discarded.device.version, usageId: usage.id, exposureDetected: true, actor });
    expect(returned.device).toMatchObject({ status: 'discarded', exposure_flag: true,
      cycle_count: 0, last_processing_event_id: null });
    expect(returned.receipt.version_after).toBe(discarded.device.version + 1);
    expect(Number(returned.receipt.audit_id)).toBeGreaterThan(0);
    const repeated = await recordRetrospectiveReturnTx(tx, { tenantId, deviceId: device.id,
      expectedVersion: returned.device.version, usageId: usage.id, exposureDetected: false, actor });
    expect(repeated.device).toMatchObject({ status: 'discarded', exposure_flag: true, cycle_count: 0 });
    expect((await client.query('SELECT id FROM reprocessable_device_holds WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
    expect((await client.query('SELECT id FROM device_processing_events WHERE tenant_id = $1', [tenantId])).rows)
      .toHaveLength(0);
  });

  test('performedOverCeilingOccurrenceIsMarkedAndCannotAuthorizeAvailability', async () => {
    const limits = [1, 2];
    expect(limits).toHaveLength(2);
    for (const limit of limits) {
      device = await mint({ initial_cycle_count: limit, max_cycles_snapshot: limit });
      const usage = await endedUse();
      await expect(processing(usage, {}, { verdict: 'eligible', reason_codes: [] }, 'prospective'))
        .rejects.toMatchObject({ code: 'RPD_MAX_CYCLES_REACHED' });
      const before = (await client.query(
        'SELECT id FROM device_processing_events WHERE tenant_id = $1 AND device_id = $2',
        [tenantId, device.id],
      )).rows;
      expect(before).toHaveLength(0);
      const unchanged = (await client.query(
        `SELECT d.version, d.cycle_count,
                (SELECT count(*)::int FROM reprocessable_device_operations o
                  WHERE o.tenant_id = d.tenant_id AND o.device_id = d.id) AS operation_count
           FROM reprocessable_devices d WHERE d.tenant_id = $1 AND d.id = $2`,
        [tenantId, device.id],
      )).rows[0];
      expect(unchanged).toEqual({ version: device.version, cycle_count: limit, operation_count: 3 });
      const recorded = await processing(usage);
      expect(recorded.event).toMatchObject({ over_ceiling: true, counts_cycle: true,
        cycle_before: limit, cycle_after: limit + 1, initial_outcome: 'passed' });
      expect(recorded.event.metadata.recording_mode).toBe('performed');
      expect(recorded.criteria.verdict).toBe('not_established');
      expect(recorded.obligations).toContain('max_cycles_reached');
      expect(recorded.device).toMatchObject({ cycle_count: limit + 1, max_cycles_snapshot: limit,
        status: 'awaiting_reprocessing', last_processing_event_id: null });
      await client.query('SAVEPOINT above_ceiling_availability');
      try {
        await expect(client.query(
          "UPDATE reprocessable_devices SET status = 'available' WHERE tenant_id = $1 AND id = $2",
          [tenantId, device.id],
        )).rejects.toMatchObject({ code: '23514',
          constraint: 'reprocessable_devices_available_cycle_ceiling_check' });
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT above_ceiling_availability');
        await client.query('RELEASE SAVEPOINT above_ceiling_availability');
      }
      const stillRecorded = (await client.query(
        'SELECT cycle_count, status FROM reprocessable_devices WHERE tenant_id = $1 AND id = $2',
        [tenantId, device.id],
      )).rows[0];
      expect(stillRecorded).toEqual({ cycle_count: limit + 1, status: 'awaiting_reprocessing' });
    }
  });

  test('unboundedProcessingCountIsNeverClassifiedAsOverCeiling', async () => {
    device = await mint({ initial_cycle_count: 3, max_cycles_snapshot: null });
    const usage = await endedUse();
    const recorded = await processing(usage);
    expect(recorded.event).toMatchObject({ over_ceiling: false, cycle_before: 3, cycle_after: 4 });
    expect(recorded.device).toMatchObject({ status: 'available', cycle_count: 4, max_cycles_snapshot: null });
    expect(recorded.criteria).toEqual({ verdict: 'released', missing_evidence: [] });
  });
});
