import { randomUUID } from 'node:crypto';

import { cancelSession } from '../services/clinical/dialysisService.js';
import {
  recordDialyserReprocessingAttempt,
  reprocessDialysisDevice,
} from '../services/clinical/dialysisDeviceLifecycleService.js';
import { placeHoldTx } from '../services/clinical/reprocessableDeviceService.js';
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

async function expectSqlState(request, code) {
  const error = await request.then(() => null, failure => failure);
  expect(error).not.toBeNull();
  expect(error?.meta?.code ?? error?.meta?.driverAdapterError?.cause?.code
    ?? error?.meta?.driverAdapterError?.cause?.originalCode).toBe(code);
}

describeWithDatabase('unused dialyser cancellation processing', () => {
  const fixtures = [];

  async function createFixture() {
    const fixture = await createPlan4DialysisFixture();
    fixtures.push(fixture);
    return fixture;
  }

  async function snapshot(fixture, capture) {
    return setTenantTx(fixture.tenantId, async tx => {
      const read = (table, predicate = 'device_id = $2', id = capture.device.id) => tx.$queryRawUnsafe(
        `SELECT * FROM ${table} WHERE tenant_id = $1::uuid AND ${predicate} ORDER BY id`,
        fixture.tenantId, Number(id),
      );
      const devices = await read('reprocessable_devices', 'id = $2');
      const usages = await read('reprocessable_device_usages');
      const sessions = await read('dialysis_sessions', 'id = $2', capture.usage.dialysis_session_id);
      const registers = await read('dialyzer_reuse_register');
      const attempts = await read('dialyser_reprocessing_attempts');
      const events = await read('device_processing_events');
      const holds = await read('reprocessable_device_holds');
      const receipts = await tx.$queryRawUnsafe(
        `SELECT * FROM reprocessable_device_operations
          WHERE tenant_id = $1::uuid AND device_id = $2 ORDER BY operation_id`,
        fixture.tenantId, Number(capture.device.id),
      );
      const timeline = await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY id`,
        fixture.tenantId, fixture.patientUid,
      );
      expect(devices).toHaveLength(1);
      expect(usages).toHaveLength(1);
      expect(sessions).toHaveLength(1);
      return { device: devices[0], usage: usages[0], session: sessions[0],
        registers, attempts, events, holds, receipts, timeline };
    });
  }

  async function unusedCancellation(fixture, packCondition = 'not_connected') {
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await cancelSession({
      tenantId: fixture.tenantId, id: session.id, actor: fixture.actor,
      expected_version: capture.device.version, pack_condition: packCondition,
    });
    return { session, capture, state: await snapshot(fixture, capture) };
  }

  function assertUnused(state, fixture) {
    expect(state.registers).toHaveLength(0);
    expect(state.session).toMatchObject({
      status: 'cancelled', actual_start_at: null, actual_end_at: null, reuse_count: 0,
    });
    expect(state.usage).toMatchObject({
      actual_use_started_at: null, reuse_cycle: 0, capture_provenance: 'live',
      post_use_disposition: 'cancelled_before_use', unopened_confirmation: 'not_connected',
      returned_by: fixture.actor.uid,
    });
    expect(state.usage.returned_at).not.toBeNull();
    expect(state.device.current_usage_id).toBeNull();
  }

  function attemptInput(fixture, capture, state, body = {}) {
    return {
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
      body: { ...PROCESS_EVIDENCE, device_usage_id: capture.usage.id,
        expected_version: state.device.version, ...body },
    };
  }

  function insertNullStatAttempt(fixture, capture, attemptNo = 1) {
    return setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
      `INSERT INTO dialyser_reprocessing_attempts
         (tenant_id, device_id, device_usage_id, dialyzer_reuse_register_id,
          attempt_no, protocol_id, verdict, recorded_by)
       VALUES ($1::uuid, $2, $3, NULL, $4::int, $5::int, 'not_established', $6::uuid)`,
      fixture.tenantId, Number(capture.device.id), Number(capture.usage.id),
      attemptNo, fixture.protocol.id, fixture.actor.uid,
    ));
  }

  async function assertRefused(fixture, capture, state, { generic = true } = {}) {
    await expect(recordDialyserReprocessingAttempt(attemptInput(fixture, capture, state)))
      .rejects.toMatchObject({ code: 'RPD_ATTEMPT_NOT_ALLOWED', statusCode: 409 });
    if (generic) {
      await expect(reprocessDialysisDevice(attemptInput(fixture, capture, state)))
        .rejects.toMatchObject({ code: 'RPD_ATTEMPT_NOT_ALLOWED', statusCode: 409 });
    }
    await expectSqlState(insertNullStatAttempt(fixture, capture), '23514');
    expect(await snapshot(fixture, capture)).toEqual(state);
  }

  afterEach(async () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) await fixture.cleanup();
    fixtures.length = 0;
  }, 30000);
  afterAll(async () => { await prisma.$disconnect(); });

  test('notConnectedCancellationRecordsImmutableNullStatutoryAttemptsWithoutInventingTreatment', async () => {
    const fixture = await createFixture();
    const { capture, state: cancelled } = await unusedCancellation(fixture);
    expect(cancelled.attempts).toHaveLength(0);
    expect(cancelled.events).toHaveLength(0);
    assertUnused(cancelled, fixture);
    expect(cancelled.device).toMatchObject({ status: 'awaiting_reprocessing', cycle_count: 0 });

    const incompleteInput = {
      ...attemptInput(fixture, capture, cancelled, { disinfectant_contact_minutes: undefined }),
      operation: { idempotencyKey: randomUUID(), operationId: randomUUID() },
    };
    const incompleteRequest = recordDialyserReprocessingAttempt(incompleteInput);
    await expect(incompleteRequest).resolves.toMatchObject({
      attempt: { attempt_no: 1, verdict: 'not_established' },
      device: { status: 'awaiting_reprocessing', cycle_count: 1 },
    });
    const incomplete = await incompleteRequest;
    const first = await snapshot(fixture, capture);
    expect(first.attempts).toHaveLength(1);
    expect(first.events).toHaveLength(1);
    assertUnused(first, fixture);
    expect(first.attempts[0]).toMatchObject({
      dialyzer_reuse_register_id: null, attempt_no: 1, verdict: 'not_established',
      device_usage_id: BigInt(capture.usage.id), recorded_by: fixture.actor.uid,
    });
    expect(first.events[0]).toMatchObject({
      attempt_id: first.attempts[0].id, dialyzer_reuse_register_id: null,
      cycle_before: 0, cycle_after: 1,
    });
    await expectSqlState(insertNullStatAttempt(fixture, capture, 1), '23505');
    await expect(recordDialyserReprocessingAttempt(incompleteInput)).resolves.toEqual(incomplete);
    await expect(reprocessDialysisDevice(incompleteInput)).resolves.toEqual(incomplete);
    expect(await snapshot(fixture, capture)).toEqual(first);
    await expect(recordDialyserReprocessingAttempt({
      ...incompleteInput, body: { ...incompleteInput.body, measured_tcv_ml: 94 },
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await snapshot(fixture, capture)).toEqual(first);

    const completeInput = {
      ...attemptInput(fixture, capture, first),
      operation: { idempotencyKey: randomUUID(), operationId: randomUUID() },
    };
    const completed = await reprocessDialysisDevice(completeInput);
    expect(completed).toMatchObject({
      attempt: { attempt_no: 2, verdict: 'released', missing_evidence: [] },
      device: { status: 'available', cycle_count: 2, current_usage_id: null },
    });
    const final = await snapshot(fixture, capture);
    expect(final.attempts).toHaveLength(2);
    expect(final.events).toHaveLength(2);
    assertUnused(final, fixture);
    expect(final.attempts[0]).toEqual(first.attempts[0]);
    expect(final.events[0]).toEqual(first.events[0]);
    expect(final.attempts[1]).toMatchObject({
      dialyzer_reuse_register_id: null, attempt_no: 2, verdict: 'released',
      device_usage_id: BigInt(capture.usage.id), recorded_by: fixture.actor.uid,
    });
    expect(final.events[1]).toMatchObject({
      attempt_id: final.attempts[1].id, dialyzer_reuse_register_id: null,
      cycle_before: 1, cycle_after: 2,
    });
    await expect(reprocessDialysisDevice(completeInput)).resolves.toEqual(completed);
    await expect(recordDialyserReprocessingAttempt(completeInput)).resolves.toEqual(completed);
    expect(await snapshot(fixture, capture)).toEqual(final);
    await expect(reprocessDialysisDevice({
      ...completeInput, body: { ...completeInput.body, disinfectant_contact_minutes: 13 },
    })).rejects.toMatchObject({ code: 'RPD_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    const changes = [
      'UPDATE dialyser_reprocessing_attempts SET notes = \'Altered history\' WHERE tenant_id = $1::uuid AND id = $2',
      'DELETE FROM dialyser_reprocessing_attempts WHERE tenant_id = $1::uuid AND id = $2',
    ];
    expect(changes).toHaveLength(2);
    for (const sql of changes) {
      await expectSqlState(setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
        sql, fixture.tenantId, Number(final.attempts[0].id),
      )), '55000');
    }
    expect(await snapshot(fixture, capture)).toEqual(final);
    assertMarkerFree(completed);
  }, 30000);

  test('genuinelyUsedEndedSessionCannotRecordNullStatutoryAttemptEvenWithSignedCancellationFields', async () => {
    const fixture = await createFixture();
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await snapshot(fixture, capture);
    expect(ended.registers).toHaveLength(0);
    expect(ended.attempts).toHaveLength(0);
    expect(ended.events).toHaveLength(0);
    expect(ended.session.status).toBe('completed');
    expect(ended.session.actual_start_at).not.toBeNull();
    expect(ended.usage.actual_use_started_at).not.toBeNull();
    await assertRefused(fixture, capture, ended, { generic: false });
    expect(await setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
      `UPDATE reprocessable_device_usages
          SET post_use_disposition = 'cancelled_before_use',
              unopened_confirmation = 'not_connected', returned_by = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2`,
      fixture.tenantId, Number(capture.usage.id), fixture.actor.uid,
    ))).toBe(1);
    const forged = await snapshot(fixture, capture);
    expect(forged.usage).toMatchObject({
      post_use_disposition: 'cancelled_before_use', unopened_confirmation: 'not_connected',
    });
    expect(forged.usage.actual_use_started_at).not.toBeNull();
    expect(forged.session.actual_start_at).not.toBeNull();
    await assertRefused(fixture, capture, forged);
  });

  test('signedUnusedCancellationCannotBypassIndependentActualStartSessionAndReturnGuards', async () => {
    const tampering = [
      ['usage actual start', 'reprocessable_device_usages', 'actual_use_started_at = captured_at'],
      ['session actual start', 'dialysis_sessions', 'actual_start_at = clock_timestamp()'],
      ['completed session', 'dialysis_sessions', "status = 'completed', actual_end_at = clock_timestamp()"],
      ['unsigned return', 'reprocessable_device_usages', 'returned_by = NULL'],
      ['not ended', 'reprocessable_device_usages', 'returned_at = NULL, post_use_disposition = NULL'],
      ['different disposition', 'reprocessable_device_usages', "post_use_disposition = 'sent_for_reprocessing'"],
    ];
    expect(tampering).toHaveLength(6);
    for (const [name, table, change] of tampering) {
      const fixture = await createFixture();
      const { capture, session, state } = await unusedCancellation(fixture);
      assertUnused(state, fixture);
      expect(await setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
        `UPDATE ${table} SET ${change} WHERE tenant_id = $1::uuid AND id = $2`,
        fixture.tenantId, Number(table === 'dialysis_sessions' ? session.id : capture.usage.id),
      ))).toBe(1);
      const changed = await snapshot(fixture, capture);
      expect({ name, attempts: changed.attempts }).toEqual({ name, attempts: [] });
      expect(changed.events).toHaveLength(0);
      expect(changed.registers).toHaveLength(0);
      await assertRefused(fixture, capture, changed, { generic: table !== 'reprocessable_device_usages'
        || change === 'actual_use_started_at = captured_at' || change === 'returned_by = NULL' });
    }
  }, 30000);

  test('sealedUnopenedCancellationCannotTakeNullStatutoryPathEvenWhenDeviceIsNonAvailable', async () => {
    const fixture = await createFixture();
    const { capture, state: sealed } = await unusedCancellation(fixture, 'sealed_unopened');
    expect(sealed.registers).toHaveLength(0);
    expect(sealed.attempts).toHaveLength(0);
    expect(sealed.device.status).toBe('available');
    expect(sealed.usage.unopened_confirmation).toBe('sealed_unopened');
    expect(await setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
      `UPDATE reprocessable_devices SET status = 'awaiting_reprocessing'
        WHERE tenant_id = $1::uuid AND id = $2`, fixture.tenantId, Number(capture.device.id),
    ))).toBe(1);
    const nonAvailable = await snapshot(fixture, capture);
    expect(nonAvailable.device).toMatchObject({ status: 'awaiting_reprocessing', current_usage_id: null });
    await assertRefused(fixture, capture, nonAvailable);
  });

  test('availableDeviceCannotRecordAnotherNullStatutoryOccurrenceWithoutFreshCancellation', async () => {
    const fixture = await createFixture();
    const { capture, state } = await unusedCancellation(fixture);
    const released = await recordDialyserReprocessingAttempt(attemptInput(fixture, capture, state));
    expect(released.device.status).toBe('available');
    const available = await snapshot(fixture, capture);
    expect(available.registers).toHaveLength(0);
    expect(available.attempts).toHaveLength(1);
    expect(available.events).toHaveLength(1);
    assertUnused(available, fixture);
    await expect(recordDialyserReprocessingAttempt(attemptInput(fixture, capture, available)))
      .rejects.toMatchObject({ code: 'RPD_ATTEMPT_NOT_ALLOWED', statusCode: 409 });
    await expect(reprocessDialysisDevice(attemptInput(fixture, capture, available)))
      .rejects.toMatchObject({ code: 'RPD_ATTEMPT_NOT_ALLOWED', statusCode: 409 });
    await expectSqlState(insertNullStatAttempt(fixture, capture, 2), '23514');
    expect(await snapshot(fixture, capture)).toEqual(available);
  });

  test('deactivatedPolicyStillRecordsPerformedUnusedHistoryWithoutAuthorizingAvailability', async () => {
    const fixture = await createFixture();
    const { capture, state } = await unusedCancellation(fixture);
    const changed = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `UPDATE reprocessing_domain_policies SET reprocessable=FALSE
        WHERE tenant_id=$1::uuid AND domain='dialysis' AND category='dialyser' RETURNING category`, fixture.tenantId,
    ));
    expect(changed).toHaveLength(1);
    const attempted = await recordDialyserReprocessingAttempt(attemptInput(fixture, capture, state));
    expect(attempted).toMatchObject({
      attempt: { verdict: 'not_established' }, device: { status: 'awaiting_reprocessing', cycle_count: 1 },
    });
    expect(attempted.attempt.missing_evidence).toContain('policy_inactive');
    const recorded = await snapshot(fixture, capture);
    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.events).toHaveLength(1);
    assertUnused(recorded, fixture);
    expect(recorded.attempts[0].dialyzer_reuse_register_id).toBeNull();
  });

  test('quarantinedUnusedCancellationRecordsTruthfulAttemptWithoutReleasingIndependentHold', async () => {
    const fixture = await createFixture();
    const { capture, state } = await unusedCancellation(fixture);
    const held = await setTenantTx(fixture.tenantId, tx => placeHoldTx(tx, {
      tenantId: fixture.tenantId, deviceId: capture.device.id,
      expectedVersion: state.device.version, holdType: 'inspection_failed',
      reasonCode: 'return_condition_damaged', placedVia: 'manual',
      sourceUsageId: capture.usage.id, placedBy: fixture.infectionControlActor.uid,
    }));
    const before = await snapshot(fixture, capture);
    expect(before.holds).toHaveLength(1);
    expect(before.attempts).toHaveLength(0);
    expect(before.device.status).toBe('quarantined');
    const attempted = await reprocessDialysisDevice(attemptInput(fixture, capture, before));
    expect(attempted).toMatchObject({
      attempt: { attempt_no: 1, verdict: 'not_established' },
      device: { status: 'quarantined', cycle_count: 1, current_usage_id: null },
    });
    expect(attempted.attempt.missing_evidence).toContain(`active_hold:${held.hold.id}`);
    const recorded = await snapshot(fixture, capture);
    expect(recorded.attempts).toHaveLength(1);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.holds).toHaveLength(1);
    assertUnused(recorded, fixture);
    expect(recorded.attempts[0]).toMatchObject({ dialyzer_reuse_register_id: null, verdict: 'not_established' });
    expect(recorded.holds).toEqual(before.holds);
    assertMarkerFree(attempted);
  });
});
