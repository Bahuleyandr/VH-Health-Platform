import { randomUUID } from 'node:crypto';

import { cancelSession } from '../services/clinical/dialysisService.js';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import { isolationDecisionTx } from '../services/clinical/dialysisReuseService.js';
import {
  readDialyser,
  recordDialyserReprocessingAttempt,
  recordRetrospectiveDialyserUse,
  reprocessDialysisDevice,
} from '../services/clinical/dialysisDeviceLifecycleService.js';
import { discardDeviceTx, placeHoldTx } from '../services/clinical/reprocessableDeviceService.js';
import {
  assertMarkerFree,
  createPlan4DialysisFixture,
  describeWithDatabase,
  prisma,
  setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

const PROCESS_EVIDENCE = Object.freeze({
  integrity_test_result: 'pass', measured_tcv_ml: 95,
  reprocessing_agent: 'peracetic_acid', disinfectant_concentration_pct: 0.3,
  disinfectant_contact_minutes: 12, residual_test_result: 'negative',
});

describeWithDatabase('dialysis device lifecycle recovery', () => {
  const fixtures = [];

  async function createFixture(options) {
    const fixture = await createPlan4DialysisFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  async function processingSnapshot(fixture, deviceId) {
    return setTenantTx(fixture.tenantId, async tx => {
      const devices = await tx.$queryRawUnsafe(
        `SELECT id, status, version, cycle_count, last_processing_event_id
           FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $2`,
        fixture.tenantId, Number(deviceId),
      );
      const events = await tx.$queryRawUnsafe(
        `SELECT id, attempt_id, dialyzer_reuse_register_id, cycle_before, cycle_after
           FROM device_processing_events WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY id`,
        fixture.tenantId, Number(deviceId),
      );
      const attempts = await tx.$queryRawUnsafe(
        `SELECT id, attempt_no, verdict FROM dialyser_reprocessing_attempts
          WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY id`,
        fixture.tenantId, Number(deviceId),
      );
      const receipts = await tx.$queryRawUnsafe(
        `SELECT operation_id, action, version_before, version_after
           FROM reprocessable_device_operations
          WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY operation_id`,
        fixture.tenantId, Number(deviceId),
      );
      const timeline = await tx.$queryRawUnsafe(
        `SELECT id, event_type FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY id`,
        fixture.tenantId, fixture.patientUid,
      );
      const reviews = await tx.$queryRawUnsafe(
        `SELECT id, finding_code, override_reason FROM medication_safety_reviews
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY id`,
        fixture.tenantId, fixture.patientUid,
      );
      const usages = await tx.$queryRawUnsafe(
        `SELECT id, dialysis_session_id, patient_uid, capture_provenance, returned_at
           FROM reprocessable_device_usages
          WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY id`,
        fixture.tenantId, Number(deviceId),
      );
      const holds = await tx.$queryRawUnsafe(
        `SELECT id, hold_type, reason_code, status, source_usage_id
           FROM reprocessable_device_holds
          WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY hold_type`,
        fixture.tenantId, Number(deviceId),
      );
      expect(devices).toHaveLength(1);
      return { device: devices[0], events, attempts, receipts, timeline, reviews, usages, holds };
    });
  }

  async function enrollUnusedDevice(fixture) {
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await cancelSession({
      tenantId: fixture.tenantId, id: session.id, actor: fixture.actor,
      expected_version: capture.device.version, pack_condition: 'sealed_unopened',
    });
    const state = await fixture.lifecycle(session.id);
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]).toMatchObject({ status: 'available', cycle_count: 0 });
    return { session, capture, device: state.devices[0] };
  }

  async function historicalSession(fixture, body = {}) {
    const session = await fixture.schedule(body);
    const rows = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `UPDATE dialysis_sessions SET status = 'completed',
              actual_start_at = clock_timestamp() - INTERVAL '2 hours',
              actual_end_at = clock_timestamp() - INTERVAL '1 hour'
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING actual_start_at, actual_end_at`, fixture.tenantId, session.id,
    ));
    expect(rows).toHaveLength(1);
    return {
      session,
      interval: {
        actual_use_started_at: rows[0].actual_start_at.toISOString(),
        actual_use_ended_at: rows[0].actual_end_at.toISOString(),
      },
    };
  }

  afterEach(async () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) await fixture.cleanup();
    fixtures.length = 0;
  }, 30000);
  afterAll(async () => { await prisma.$disconnect(); });

  test('oneTwoAndUnlimitedCeilingsPreserveLastUseButNeverAuthorizeOverCeilingOccurrence', async () => {
    const ceilings = [1, 2, null];
    expect(ceilings).toHaveLength(3);
    for (const maxCycles of ceilings) {
      const fixture = await createFixture({ maxCycles });
      let device;
      const processedCycles = maxCycles ?? 3;
      const cycles = Array.from({ length: processedCycles }, (_, index) => index);
      expect(cycles).toHaveLength(processedCycles);
      for (const cycle of cycles) {
        const session = await fixture.schedule();
        const capture = await fixture.capture(session.id, device ? {
          device_tag: device.device_tag, expected_version: device.version,
          pre_use_residual_test: 'negative',
        } : {});
        expect(capture.usage.reuse_cycle).toBe(cycle);
        expect((await fixture.start(session.id)).status).toBe('in_progress');
        await fixture.complete(session.id);
        const returned = await fixture.lifecycle(session.id);
        expect(returned.devices).toHaveLength(1);
        const record = await fixture.record(session.id, {
          expected_version: returned.devices[0].version,
        });
        expect(record.release).toEqual({ verdict: 'released', missing_evidence: [] });
        expect(record.device).toMatchObject({ status: 'available', cycle_count: cycle + 1 });
        device = record.device;
      }
      const lastSession = await fixture.schedule();
      const lastCapture = await fixture.capture(lastSession.id, {
        device_tag: device.device_tag, expected_version: device.version,
        pre_use_residual_test: 'negative',
      });
      expect(lastCapture.usage.reuse_cycle).toBe(processedCycles);
      expect((await fixture.start(lastSession.id)).status).toBe('in_progress');
      await fixture.complete(lastSession.id);
      const returned = await fixture.lifecycle(lastSession.id);
      expect(returned.devices).toHaveLength(1);
      if (maxCycles === null) {
        const unlimited = await fixture.record(lastSession.id, {
          expected_version: returned.devices[0].version,
        });
        expect(unlimited.device).toMatchObject({ status: 'available', cycle_count: 4 });
      } else {
        const recording = fixture.record(lastSession.id, {
          expected_version: returned.devices[0].version,
        });
        await expect(recording).resolves.toMatchObject({
          device: { status: 'awaiting_reprocessing', cycle_count: maxCycles + 1 },
          release: { verdict: 'not_established' },
        });
        const recorded = await recording;
        expect(recorded.release.missing_evidence).toContain('max_cycles_reached');
        const events = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
          `SELECT over_ceiling, cycle_before, cycle_after FROM device_processing_events
            WHERE tenant_id=$1::uuid AND dialyzer_reuse_register_id=$2`, fixture.tenantId, Number(recorded.id),
        ));
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ over_ceiling: true, cycle_before: maxCycles, cycle_after: maxCycles + 1 });
      }
    }
  }, 30000);

  test('performedAttemptAboveCeilingPreservesStatutoryHistoryAndCannotAuthorizeAvailability', async () => {
    const fixture = await createFixture({ maxCycles: 1 });
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    const incomplete = await fixture.record(session.id, {
      expected_version: ended.devices[0].version, disinfectant_contact_minutes: undefined,
    });
    expect(incomplete.device).toMatchObject({ cycle_count: 1, status: 'awaiting_reprocessing' });
    const before = await fixture.lifecycle(session.id);
    expect(before.registers).toHaveLength(1);
    const request = recordDialyserReprocessingAttempt({
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
      body: { ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id, expected_version: incomplete.device.version },
    });
    await expect(request).resolves.toMatchObject({
      device: { cycle_count: 2, status: 'awaiting_reprocessing' }, attempt: { verdict: 'not_established' },
    });
    const attempt = await request;
    expect(attempt.attempt.missing_evidence).toContain('max_cycles_reached');
    const events = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT over_ceiling, cycle_before, cycle_after FROM device_processing_events
        WHERE tenant_id=$1::uuid AND attempt_id=$2`, fixture.tenantId, Number(attempt.attempt.id),
    ));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ over_ceiling: true, cycle_before: 1, cycle_after: 2 });
    const after = await fixture.lifecycle(session.id);
    expect(after.registers).toHaveLength(1);
    expect(after.registers).toEqual(before.registers);
  });

  test('performedCeilingExceptionNeverBypassesIndependentNoReuseMatrix', async () => {
    const paths = ['statutory', 'attempt'];
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(['statutory', 'attempt']);
    for (const path of paths) {
      const fixture = await createFixture({ maxCycles: 1 });
      const firstSession = await fixture.schedule();
      const captured = await fixture.capture(firstSession.id);
      await fixture.start(firstSession.id);
      await fixture.complete(firstSession.id);
      const ended = await fixture.lifecycle(firstSession.id);
      expect(ended.devices).toHaveLength(1);
      const firstRecord = await fixture.record(firstSession.id, {
        expected_version: ended.devices[0].version,
        ...(path === 'attempt' ? { disinfectant_contact_minutes: undefined } : {}),
      });
      let session = firstSession;
      if (path === 'statutory') {
        session = await fixture.schedule();
        await fixture.capture(session.id, {
          device_tag: firstRecord.device.device_tag, expected_version: firstRecord.device.version,
          pre_use_residual_test: 'negative',
        });
        await fixture.start(session.id);
        await fixture.complete(session.id);
      }
      const markers = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
        `UPDATE patient_bloodborne_markers SET result='reactive'
          WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid AND marker='hbsag' RETURNING id`,
        fixture.tenantId, fixture.patientUid,
      ));
      expect(markers).toHaveLength(1);
      const before = await processingSnapshot(fixture, captured.device.id);
      expect(before.events).toHaveLength(1);
      if (path === 'statutory') {
        await expect(fixture.record(session.id, { expected_version: before.device.version }))
          .rejects.toMatchObject({ code: 'RPD_DISPOSITION_NOT_ALLOWED',
            details: { blocked_code: 'RPD_REUSE_MATRIX_NO_REUSE' } });
      } else {
        await expect(recordDialyserReprocessingAttempt({
          tenantId: fixture.tenantId, deviceId: captured.device.id, actor: fixture.actor,
          body: { ...PROCESS_EVIDENCE, device_usage_id: captured.usage.id, expected_version: before.device.version },
        })).rejects.toMatchObject({ code: 'RPD_ATTEMPT_NOT_ALLOWED' });
      }
      expect(await processingSnapshot(fixture, captured.device.id)).toEqual(before);
    }
  });

  test('unknownWarnAcknowledgementsAreAttributedAtCaptureAndStatutoryProcessing', async () => {
    const fixture = await createFixture({ clearMarkers: false });
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id, {
      exposure_acknowledgement: { reason: 'Urgent use with incomplete surveillance evidence' },
    });
    expect(capture.usage.reuse_screen.status).toBe('unknown');
    expect((await fixture.start(session.id)).status).toBe('in_progress');
    await fixture.complete(session.id);
    const returned = await fixture.lifecycle(session.id);
    expect(returned.devices).toHaveLength(1);
    await expect(fixture.record(session.id, {
      expected_version: returned.devices[0].version,
    })).rejects.toMatchObject({ code: 'RPD_ACKNOWLEDGEMENT_REQUIRED', statusCode: 409 });
    const record = await fixture.record(session.id, {
      expected_version: returned.devices[0].version,
      acknowledgement: { reason: 'Processing under reviewed unknown-evidence warning' },
    });
    expect(record.release).toEqual({ verdict: 'released', missing_evidence: [] });
    const reviews = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT patient_uid, review_type, status, finding_code, override_required,
              override_reason, overridden_by, overridden_at, payload, created_by
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY created_at, id`,
      fixture.tenantId, fixture.patientUid,
    ));
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review).toMatchObject({
        patient_uid: fixture.patientUid, review_type: 'reprocessable_device_reuse',
        status: 'overridden', finding_code: 'SEROLOGY_UNKNOWN_ACKNOWLEDGED',
        override_required: true, overridden_by: fixture.actor.uid, created_by: fixture.actor.uid,
        payload: { domain: 'dialysis', usage_id: String(capture.usage.id) },
      });
      expect(review.overridden_at).not.toBeNull();
    }
    expect(reviews.map(review => review.override_reason)).toEqual([
      'Urgent use with incomplete surveillance evidence',
      'Processing under reviewed unknown-evidence warning',
    ]);
    assertMarkerFree(record);
  }, 30000);

  test('unusedCancellationDistinguishesSealedUnopenedFromNotConnectedWithoutRecount', async () => {
    const fixture = await createFixture();
    const conditions = [
      { packCondition: 'sealed_unopened', status: 'available' },
      { packCondition: 'not_connected', status: 'awaiting_reprocessing' },
    ];
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      const session = await fixture.schedule();
      const capture = await fixture.capture(session.id);
      await cancelSession({
        tenantId: fixture.tenantId, id: session.id, actor: fixture.actor,
        expected_version: capture.device.version, pack_condition: condition.packCondition,
      });
      const cancelled = await fixture.lifecycle(session.id);
      expect(cancelled.usages).toHaveLength(1);
      expect(cancelled.devices).toHaveLength(1);
      expect(cancelled.registers).toHaveLength(0);
      expect(cancelled.session).toMatchObject({ status: 'cancelled', actual_start_at: null });
      expect(cancelled.usages[0].returned_at).not.toBeNull();
      expect(cancelled.usages[0].pre_use_residual_test).toBeNull();
      expect(cancelled.devices[0]).toMatchObject({
        status: condition.status, cycle_count: 0, current_usage_id: null,
        last_processing_event_id: null,
      });
      const events = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
        `SELECT id FROM device_processing_events WHERE tenant_id = $1::uuid AND device_id = $2`,
        fixture.tenantId, Number(capture.device.id),
      ));
      expect(events).toHaveLength(0);
    }
  });

  test('retrospectiveHeldAndDeactivatedDevicesRecordEndedHistoryWithoutGrantingReadiness', async () => {
    const cases = [
      { held: true, deactivated: false, status: 'quarantined' },
      { held: false, deactivated: true, status: 'awaiting_reprocessing' },
      { held: true, deactivated: true, status: 'quarantined' },
    ];
    expect(cases).toHaveLength(3);
    for (const scenario of cases) {
      const fixture = await createFixture();
      const enrollment = await fixture.schedule();
      const capture = await fixture.capture(enrollment.id);
      await cancelSession({
        tenantId: fixture.tenantId, id: enrollment.id, actor: fixture.actor,
        expected_version: capture.device.version, pack_condition: 'sealed_unopened',
      });
      const historicalSession = await fixture.schedule();
      const interval = await setTenantTx(fixture.tenantId, async tx => {
        const [times] = await tx.$queryRawUnsafe(
          `UPDATE dialysis_sessions SET status = 'completed',
                  actual_start_at = clock_timestamp() - INTERVAL '2 hours',
                  actual_end_at = clock_timestamp() - INTERVAL '1 hour'
            WHERE tenant_id = $1::uuid AND id = $2::int
            RETURNING actual_start_at, actual_end_at`, fixture.tenantId, historicalSession.id,
        );
        if (scenario.deactivated) {
          await tx.$executeRawUnsafe(
            `UPDATE reprocessing_domain_policies SET reprocessable = FALSE
              WHERE tenant_id = $1::uuid AND domain = 'dialysis' AND category = 'dialyser'`,
            fixture.tenantId,
          );
        }
        return times;
      });
      let state = await fixture.lifecycle(enrollment.id);
      expect(state.devices).toHaveLength(1);
      if (scenario.held) {
        await setTenantTx(fixture.tenantId, tx => placeHoldTx(tx, {
          tenantId: fixture.tenantId, deviceId: capture.device.id,
          expectedVersion: state.devices[0].version, holdType: 'inspection_failed',
          reasonCode: 'return_condition_damaged', placedVia: 'manual',
          placedBy: fixture.infectionControlActor.uid,
        }));
        state = await fixture.lifecycle(enrollment.id);
        expect(state.devices).toHaveLength(1);
      }
      const result = await recordRetrospectiveDialyserUse({
        tenantId: fixture.tenantId, sessionId: historicalSession.id, actor: fixture.actor,
        body: {
          manufacturer_serial: capture.device.manufacturer_serial,
          expected_version: state.devices[0].version,
          actual_use_started_at: interval.actual_start_at.toISOString(),
          actual_use_ended_at: interval.actual_end_at.toISOString(),
          deviation_reason: 'Historical device use discovered during reconciliation',
        },
      });
      expect(result.usage).toMatchObject({ capture_provenance: 'retrospective' });
      expect(result.usage.returned_at).not.toBeNull();
      expect(result.device).toMatchObject({
        status: scenario.status, cycle_count: 0, current_usage_id: null,
      });
      const history = await fixture.lifecycle(historicalSession.id);
      expect(history.usages).toHaveLength(1);
      expect(history.registers).toHaveLength(0);
      assertMarkerFree(result);
    }
  });

  test('genericProcessingRequiresMatchingUsageAndDelegatesStatutoryThenAppendOnlyAttempt', async () => {
    const fixture = await createFixture();
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    const input = {
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
    };
    await expect(reprocessDialysisDevice({ ...input, body: PROCESS_EVIDENCE }))
      .rejects.toMatchObject({ code: 'RPD_DIALYSIS_USAGE_REQUIRED', statusCode: 400 });
    await expect(reprocessDialysisDevice({
      ...input, body: { ...PROCESS_EVIDENCE, device_usage_id: Number(capture.usage.id) + 1 },
    })).rejects.toMatchObject({ code: 'RPD_RELATIONSHIP_MISMATCH', statusCode: 409 });
    expect(await fixture.lifecycle(session.id)).toEqual(ended);
    const recorded = await reprocessDialysisDevice({
      ...input,
      body: {
        ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id,
        expected_version: ended.devices[0].version, disinfectant_contact_minutes: undefined,
      },
    });
    expect(recorded.release.verdict).toBe('not_established');
    const first = await fixture.lifecycle(session.id);
    expect(first.registers).toHaveLength(1);
    expect(first.devices).toHaveLength(1);
    const attempted = await reprocessDialysisDevice({
      ...input,
      body: { ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id, expected_version: first.devices[0].version },
    });
    expect(attempted.attempt).toMatchObject({ attempt_no: 1, verdict: 'released' });
    const settled = await fixture.lifecycle(session.id);
    expect(settled.registers).toHaveLength(1);
    expect(settled.registers).toEqual(first.registers);
    expect(settled.devices).toHaveLength(1);
    expect(settled.devices[0].status).toBe('available');
    const readback = await readDialyser({
      tenantId: fixture.tenantId, sessionId: session.id, actor: fixture.actor,
    });
    expect(readback.device.status).toBe('available');
    assertMarkerFree(readback);
  });

  test('keyedGenericStatutoryAndAttemptRetriesReplayExactlyWithoutAdditionalWrites', async () => {
    const fixture = await createFixture();
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    const input = {
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
    };
    const firstBody = {
      ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id,
      expected_version: ended.devices[0].version, disinfectant_contact_minutes: undefined,
    };
    const firstOperation = { idempotencyKey: randomUUID(), operationId: randomUUID() };
    const first = await reprocessDialysisDevice({ ...input, body: firstBody, operation: firstOperation });
    expect(first.release.verdict).toBe('not_established');
    const firstSnapshot = await processingSnapshot(fixture, capture.device.id);
    expect(firstSnapshot.events).toHaveLength(1);
    expect(firstSnapshot.attempts).toHaveLength(0);
    expect(firstSnapshot.receipts.length).toBeGreaterThan(0);
    expect(firstSnapshot.timeline.length).toBeGreaterThan(0);
    expect(firstSnapshot.device.version).toBeGreaterThan(firstBody.expected_version);
    await expect(reprocessDialysisDevice({ ...input, body: firstBody, operation: firstOperation }))
      .resolves.toEqual(first);
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(firstSnapshot);
    await expect(reprocessDialysisDevice({
      ...input, body: { ...firstBody, measured_tcv_ml: 91 }, operation: firstOperation,
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(firstSnapshot);

    const attemptBody = {
      ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id,
      expected_version: firstSnapshot.device.version,
    };
    const attemptOperation = { idempotencyKey: randomUUID(), operationId: randomUUID() };
    const attempt = await reprocessDialysisDevice({ ...input, body: attemptBody, operation: attemptOperation });
    expect(attempt.attempt).toMatchObject({ attempt_no: 1, verdict: 'released' });
    const attemptSnapshot = await processingSnapshot(fixture, capture.device.id);
    expect(attemptSnapshot.events).toHaveLength(2);
    expect(attemptSnapshot.attempts).toHaveLength(1);
    expect(attemptSnapshot.device).toMatchObject({ status: 'available', cycle_count: 2 });
    expect(attemptSnapshot.device.version).toBeGreaterThan(attemptBody.expected_version);
    await expect(reprocessDialysisDevice({ ...input, body: attemptBody, operation: attemptOperation }))
      .resolves.toEqual(attempt);
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(attemptSnapshot);
    await expect(reprocessDialysisDevice({
      ...input, body: { ...attemptBody, measured_tcv_ml: 92 }, operation: attemptOperation,
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(attemptSnapshot);
    assertMarkerFree(attempt);
  }, 30000);

  test('unknownWarnLaterAttemptRequiresFreshAttributedReviewAndDoesNotDuplicateItOnReplay', async () => {
    const fixture = await createFixture({ clearMarkers: false });
    const session = await fixture.schedule();
    const reasons = [
      'Reviewed uncertain evidence before initial reservation',
      'Reviewed uncertain evidence before first processing',
      'Reviewed uncertain evidence before additional processing',
    ];
    expect(reasons).toHaveLength(3);
    const capture = await fixture.capture(session.id, {
      exposure_acknowledgement: { reason: reasons[0] },
    });
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    await fixture.record(session.id, {
      expected_version: ended.devices[0].version,
      disinfectant_contact_minutes: undefined, acknowledgement: { reason: reasons[1] },
    });
    const before = await processingSnapshot(fixture, capture.device.id);
    expect(before.events).toHaveLength(1);
    expect(before.attempts).toHaveLength(0);
    expect(before.reviews).toHaveLength(2);
    const input = {
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
    };
    const body = {
      ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id,
      expected_version: before.device.version,
    };
    await expect(reprocessDialysisDevice({ ...input, body }))
      .rejects.toMatchObject({ code: 'RPD_ACKNOWLEDGEMENT_REQUIRED', statusCode: 409 });
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(before);
    const operation = { idempotencyKey: randomUUID(), operationId: randomUUID() };
    const acknowledgedBody = { ...body, acknowledgement: { reason: reasons[2] } };
    const attempt = await reprocessDialysisDevice({ ...input, body: acknowledgedBody, operation });
    expect(attempt.attempt).toMatchObject({ attempt_no: 1, verdict: 'released' });
    const reviews = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT patient_uid, finding_code, status, override_required, override_reason,
              overridden_by, overridden_at, created_by, payload
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY created_at, id`,
      fixture.tenantId, fixture.patientUid,
    ));
    expect(reviews).toHaveLength(3);
    for (const review of reviews) {
      expect(review).toMatchObject({
        patient_uid: fixture.patientUid, finding_code: 'SEROLOGY_UNKNOWN_ACKNOWLEDGED',
        status: 'overridden', override_required: true,
        overridden_by: fixture.actor.uid, created_by: fixture.actor.uid,
        payload: { domain: 'dialysis', usage_id: String(capture.usage.id) },
      });
      expect(review.overridden_at).not.toBeNull();
    }
    expect(reviews.map(review => review.override_reason)).toEqual(reasons);
    const recorded = await processingSnapshot(fixture, capture.device.id);
    expect(recorded.events).toHaveLength(2);
    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.reviews).toHaveLength(3);
    await expect(reprocessDialysisDevice({ ...input, body: acknowledgedBody, operation }))
      .resolves.toEqual(attempt);
    expect(await processingSnapshot(fixture, capture.device.id)).toEqual(recorded);
    assertMarkerFree(attempt);
  }, 30000);

  test('deletedPolicyAfterEnrollmentCannotReenterLegacyRecordingOrCapture', async () => {
    const fixture = await createFixture();
    const enrollment = await fixture.schedule();
    const capture = await fixture.capture(enrollment.id);
    await cancelSession({
      tenantId: fixture.tenantId, id: enrollment.id, actor: fixture.actor,
      expected_version: capture.device.version, pack_condition: 'sealed_unopened',
    });
    const historicalSession = await fixture.schedule();
    const nextSession = await fixture.schedule();
    await setTenantTx(fixture.tenantId, async tx => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE dialysis_sessions SET status = 'completed',
                actual_start_at = clock_timestamp() - INTERVAL '2 hours',
                actual_end_at = clock_timestamp() - INTERVAL '1 hour'
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        fixture.tenantId, historicalSession.id,
      );
      expect(changed).toBe(1);
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM reprocessing_domain_policies
          WHERE tenant_id = $1::uuid AND domain = 'dialysis' AND category = 'dialyser'`,
        fixture.tenantId,
      );
      expect(deleted).toBe(1);
    });
    const before = await fixture.lifecycle(historicalSession.id);
    expect(before.session.status).toBe('completed');
    expect(before.session.actual_end_at).not.toBeNull();
    expect(before.usages).toHaveLength(0);
    expect(before.registers).toHaveLength(0);
    await expect(fixture.record(historicalSession.id, {
      dialyzer_serial: 'NO-LEGACY-FALLBACK', reuse_cycle_count: 0,
    })).rejects.toMatchObject({ code: 'RPD_DIALYSIS_USAGE_REQUIRED', statusCode: 409 });
    expect(await fixture.lifecycle(historicalSession.id)).toEqual(before);

    const enrolled = await fixture.lifecycle(enrollment.id);
    expect(enrolled.devices).toHaveLength(1);
    expect(enrolled.devices[0].status).toBe('available');
    await expect(fixture.capture(nextSession.id, {
      device_tag: capture.device.device_tag, expected_version: enrolled.devices[0].version,
    })).rejects.toMatchObject({ code: 'RPD_POLICY_DEACTIVATED', statusCode: 409 });
    expect(await fixture.lifecycle(enrollment.id)).toEqual(enrolled);
    const uncaptured = await fixture.lifecycle(nextSession.id);
    expect(uncaptured.usages).toHaveLength(0);
    expect(uncaptured.session).toMatchObject({ status: 'scheduled', actual_start_at: null });
  });

  test('unknownBlockReturnAddsSerologyHoldWithoutReplacingIndependentInspectionHold', async () => {
    const fixture = await createFixture();
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    expect((await fixture.start(session.id)).status).toBe('in_progress');
    const started = await fixture.lifecycle(session.id);
    expect(started.devices).toHaveLength(1);
    const inspection = await setTenantTx(fixture.tenantId, async tx => {
      const held = await placeHoldTx(tx, {
        tenantId: fixture.tenantId, deviceId: capture.device.id,
        expectedVersion: started.devices[0].version, holdType: 'inspection_failed',
        reasonCode: 'return_condition_damaged', placedVia: 'manual',
        sourceUsageId: capture.usage.id, placedBy: fixture.infectionControlActor.uid,
      });
      const removed = await tx.$executeRawUnsafe(
        `DELETE FROM patient_bloodborne_markers
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        fixture.tenantId, fixture.patientUid,
      );
      expect(removed).toBe(3);
      const changed = await tx.$executeRawUnsafe(
        `UPDATE reprocessing_domain_settings SET unknown_serology_rule = 'block_return'
          WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, fixture.tenantId,
      );
      expect(changed).toBe(1);
      return held.hold;
    });
    expect(inspection).toMatchObject({ status: 'active', pending_return: true });
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.usages).toHaveLength(1);
    expect(ended.devices).toHaveLength(1);
    expect(ended.registers).toHaveLength(0);
    expect(ended.usages[0].returned_at).not.toBeNull();
    expect(ended.devices[0]).toMatchObject({ status: 'quarantined', current_usage_id: null });
    const holds = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, hold_type, reason_code, status, source_usage_id
         FROM reprocessable_device_holds
        WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY hold_type`,
      fixture.tenantId, Number(capture.device.id),
    ));
    expect(holds).toHaveLength(2);
    expect(holds.map(hold => ({
      type: hold.hold_type, reason: hold.reason_code, status: hold.status,
    }))).toEqual([
      { type: 'inspection_failed', reason: 'return_condition_damaged', status: 'active' },
      { type: 'serology_required', reason: 'serology_unknown_block_return', status: 'active' },
    ]);
    expect(String(holds[0].id)).toBe(String(inspection.id));
    for (const hold of holds) expect(String(hold.source_usage_id)).toBe(String(capture.usage.id));
    assertMarkerFree(ended);
  });

  test('retrospectiveUnknownBlockReturnAddsIndependentHoldAndKeyedReplayIsCycleNeutral', async () => {
    const fixture = await createFixture();
    const enrolled = await enrollUnusedDevice(fixture);
    const historical = await historicalSession(fixture);
    const inspection = await setTenantTx(fixture.tenantId, async tx => {
      expect(await tx.$executeRawUnsafe(
        `DELETE FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        fixture.tenantId, fixture.patientUid,
      )).toBe(3);
      expect(await tx.$executeRawUnsafe(
        `UPDATE reprocessing_domain_settings SET unknown_serology_rule = 'block_return'
          WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, fixture.tenantId,
      )).toBe(1);
      return placeHoldTx(tx, {
        tenantId: fixture.tenantId, deviceId: enrolled.capture.device.id,
        expectedVersion: enrolled.device.version, holdType: 'inspection_failed',
        reasonCode: 'return_condition_damaged', placedVia: 'manual',
        sourceUsageId: enrolled.capture.usage.id, placedBy: fixture.infectionControlActor.uid,
      });
    });
    const body = {
      manufacturer_serial: enrolled.capture.device.manufacturer_serial,
      expected_version: inspection.device.version, ...historical.interval,
      deviation_reason: 'Historical use documented after surveillance became incomplete',
    };
    const input = {
      tenantId: fixture.tenantId, sessionId: historical.session.id, actor: fixture.actor,
      operation: { idempotencyKey: randomUUID(), operationId: randomUUID() },
    };
    const result = await recordRetrospectiveDialyserUse({ ...input, body });
    expect(result.device).toMatchObject({ status: 'quarantined', cycle_count: 0, last_processing_event_id: null });
    expect(result.usage).toMatchObject({ capture_provenance: 'retrospective', post_use_screen: { status: 'unknown' } });
    expect(result.usage.returned_at).not.toBeNull();
    const state = await processingSnapshot(fixture, enrolled.capture.device.id);
    expect(state.usages).toHaveLength(2);
    expect(state.events).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.holds).toHaveLength(2);
    expect(state.holds.map(hold => ({ type: hold.hold_type, status: hold.status }))).toEqual([
      { type: 'inspection_failed', status: 'active' },
      { type: 'serology_required', status: 'active' },
    ]);
    expect(String(state.holds[0].id)).toBe(String(inspection.hold.id));
    expect(String(state.holds[1].source_usage_id)).toBe(String(result.usage.id));
    expect(state.device.version).toBeGreaterThan(body.expected_version);
    await expect(recordRetrospectiveDialyserUse({ ...input, body })).resolves.toEqual(result);
    expect(await processingSnapshot(fixture, enrolled.capture.device.id)).toEqual(state);
    await expect(recordRetrospectiveDialyserUse({
      ...input, body: { ...body, deviation_reason: 'Different retrospective reason under the same key' },
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await processingSnapshot(fixture, enrolled.capture.device.id)).toEqual(state);
    assertMarkerFree(result);
  }, 30000);

  test('retrospectiveRestrictedDiscardedDeviceRecordsExposureWithoutNewHoldOrReadiness', async () => {
    const fixture = await createFixture();
    const enrolled = await enrollUnusedDevice(fixture);
    const historical = await historicalSession(fixture);
    const discarded = await setTenantTx(fixture.tenantId, async tx => {
      const result = await discardDeviceTx(tx, {
        tenantId: fixture.tenantId, deviceId: enrolled.capture.device.id,
        expectedVersion: enrolled.device.version, reason: 'other', actor: fixture.actor,
      });
      await recordMarkerTx(tx, {
        tenantId: fixture.tenantId, patientUid: fixture.patientUid,
        marker: 'hbsag', result: 'reactive', testedOn: fixture.today,
        source: 'clinical_declaration', recordedBy: fixture.infectionControlActor.uid,
      });
      return result;
    });
    const body = {
      manufacturer_serial: enrolled.capture.device.manufacturer_serial,
      expected_version: discarded.device.version, ...historical.interval,
      deviation_reason: 'Past use discovered after permanent device disposal',
    };
    const input = {
      tenantId: fixture.tenantId, sessionId: historical.session.id, actor: fixture.actor,
      operation: { idempotencyKey: randomUUID(), operationId: randomUUID() },
    };
    const result = await recordRetrospectiveDialyserUse({ ...input, body });
    expect(result.device).toMatchObject({
      status: 'discarded', exposure_flag: true, cycle_count: 0,
      current_usage_id: null, last_processing_event_id: null,
    });
    expect(result.usage).toMatchObject({
      capture_provenance: 'retrospective', post_use_screen: { status: 'restricted' },
      post_use_disposition: 'discarded_bloodborne_exposure',
    });
    expect(result.usage.returned_at).not.toBeNull();
    const state = await processingSnapshot(fixture, enrolled.capture.device.id);
    expect(state.usages).toHaveLength(2);
    expect(state.events).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.holds).toHaveLength(0);
    await expect(recordRetrospectiveDialyserUse({ ...input, body })).resolves.toEqual(result);
    expect(await processingSnapshot(fixture, enrolled.capture.device.id)).toEqual(state);
    await expect(recordRetrospectiveDialyserUse({
      ...input, body: { ...body, deviation_reason: 'Changed disposal reconciliation reason' },
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await processingSnapshot(fixture, enrolled.capture.device.id)).toEqual(state);
    assertMarkerFree(result);
  }, 30000);

  test('retrospectiveClearPatientStillReceivesHoldForPendingDedicatedPatientExposure', async () => {
    const fixture = await createFixture();
    const enrolled = await enrollUnusedDevice(fixture);
    const otherPatientUid = randomUUID();
    const otherPatient = await setTenantTx(fixture.tenantId, async tx => {
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Plan 4 retrospective patient', 'PATIENT', TRUE, 'active', NOW())`,
        otherPatientUid, fixture.tenantId,
        `+91${BigInt(`0x${otherPatientUid.replaceAll('-', '').slice(0, 12)}`).toString().padStart(10, '0').slice(-10)}`,
      );
      const patients = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
         VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, fixture.tenantId, otherPatientUid,
      );
      expect(patients).toHaveLength(1);
      const markers = ['hbsag', 'hcv', 'hiv'];
      expect(markers).toHaveLength(3);
      for (const marker of markers) {
        await tx.$executeRawUnsafe(
          `INSERT INTO patient_bloodborne_markers
             (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
           VALUES ($1::uuid, $2::uuid, $3, 'non_reactive', $4::date, 'clinical_declaration', $5::uuid)`,
          fixture.tenantId, otherPatientUid, marker, fixture.today, fixture.infectionControlActor.uid,
        );
      }
      return patients[0];
    });
    const historical = await historicalSession(fixture, { dialysis_patient_id: otherPatient.id });
    await setTenantTx(fixture.tenantId, tx => recordMarkerTx(tx, {
      tenantId: fixture.tenantId, patientUid: fixture.patientUid,
      marker: 'hbsag', result: 'reactive', testedOn: fixture.today,
      source: 'clinical_declaration', recordedBy: fixture.infectionControlActor.uid,
    }));
    const before = await setTenantTx(fixture.tenantId, async tx => {
      const decision = await isolationDecisionTx({ tenantId: fixture.tenantId, patientUid: otherPatientUid, db: tx });
      const outbox = await tx.$queryRawUnsafe(
        `SELECT id, status, patient_uid FROM bloodborne_exposure_outbox
          WHERE tenant_id = $1::uuid ORDER BY id`, fixture.tenantId,
      );
      const links = await tx.$queryRawUnsafe(
        `SELECT dedicated_patient_uid FROM reprocessable_device_dialysis_links
          WHERE tenant_id = $1::uuid AND device_id = $2`, fixture.tenantId, Number(enrolled.capture.device.id),
      );
      expect(outbox).toHaveLength(1);
      expect(links).toHaveLength(1);
      return { decision, outbox: outbox[0], link: links[0] };
    });
    expect(before.decision.status).toBe('clear');
    expect(before.outbox).toMatchObject({ status: 'pending', patient_uid: fixture.patientUid });
    expect(before.link.dedicated_patient_uid).toBe(fixture.patientUid);
    expect(otherPatientUid).not.toBe(fixture.patientUid);
    const input = {
      tenantId: fixture.tenantId, sessionId: historical.session.id, actor: fixture.actor,
      operation: { idempotencyKey: randomUUID(), operationId: randomUUID() },
    };
    const body = {
      manufacturer_serial: enrolled.capture.device.manufacturer_serial,
      expected_version: enrolled.device.version, ...historical.interval,
      deviation_reason: 'Wrong-patient historical use discovered during reconciliation',
    };
    const result = await recordRetrospectiveDialyserUse({ ...input, body });
    expect(result.usage).toMatchObject({
      patient_uid: otherPatientUid, capture_provenance: 'retrospective',
      post_use_screen: { status: 'clear' }, post_use_disposition: 'quarantined_bloodborne_exposure',
    });
    expect(result.usage.returned_at).not.toBeNull();
    expect(result.device).toMatchObject({
      status: 'quarantined', exposure_flag: true, cycle_count: 0,
      current_usage_id: null, last_processing_event_id: null,
    });
    const subjectFixture = { ...fixture, patientUid: otherPatientUid };
    const state = await processingSnapshot(subjectFixture, enrolled.capture.device.id);
    expect(state.usages).toHaveLength(2);
    expect(state.events).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
    expect(state.holds).toHaveLength(1);
    expect(state.holds[0]).toMatchObject({
      hold_type: 'bloodborne_exposure', reason_code: 'exposure_at_return', status: 'active',
    });
    expect(String(state.holds[0].source_usage_id)).toBe(String(result.usage.id));
    const outbox = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT status FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid AND id = $2`,
      fixture.tenantId, Number(before.outbox.id),
    ));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('pending');
    await expect(recordRetrospectiveDialyserUse({ ...input, body })).resolves.toEqual(result);
    expect(await processingSnapshot(subjectFixture, enrolled.capture.device.id)).toEqual(state);
    await expect(recordRetrospectiveDialyserUse({
      ...input, body: { ...body, deviation_reason: 'Changed wrong-patient reconciliation reason' },
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await processingSnapshot(subjectFixture, enrolled.capture.device.id)).toEqual(state);
    assertMarkerFree(result);
  }, 30000);
});
