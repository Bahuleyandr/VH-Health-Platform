import { randomUUID } from 'node:crypto';

import {
  assertMarkerFree,
  createPlan4DialysisFixture,
  describeWithDatabase,
  prisma,
  setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('first dialyser statutory record after ended use', () => {
  let fixture;

  beforeEach(async () => { fixture = await createPlan4DialysisFixture(); });
  afterEach(async () => { await fixture?.cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  test('earlyTerminationFirstRecordAcceptsEndedUsageAndPinsSettledReplay', async () => {
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id, {
      early_termination: true, early_termination_reason: 'Treatment stopped by clinician',
    });
    const ended = await fixture.lifecycle(session.id);
    expect(ended.usages).toHaveLength(1);
    expect(ended.devices).toHaveLength(1);
    expect(ended.registers).toHaveLength(0);
    expect(ended.session).toMatchObject({ status: 'completed', early_termination: true });
    expect(ended.session.actual_end_at).not.toBeNull();
    expect(ended.usages[0].returned_at).not.toBeNull();
    expect(ended.devices[0]).toMatchObject({
      status: 'awaiting_reprocessing', current_usage_id: null, cycle_count: 0,
    });

    const body = {
      dialyzer_serial: capture.device.manufacturer_serial,
      expected_version: ended.devices[0].version,
    };
    const operation = { operationId: randomUUID(), idempotencyKey: randomUUID() };
    const recording = fixture.record(session.id, body, operation);
    await expect(recording).resolves.toMatchObject({
      release: { verdict: 'released', missing_evidence: [] },
    });
    const recorded = await recording;
    expect(recorded.release).toEqual({ verdict: 'released', missing_evidence: [] });
    const settled = await fixture.lifecycle(session.id);
    expect(settled.registers).toHaveLength(1);
    expect(settled.usages).toHaveLength(1);
    expect(settled.devices).toHaveLength(1);
    expect(String(settled.registers[0].device_usage_id)).toBe(String(ended.usages[0].id));
    expect(settled.registers[0].release_status).toBe('released');
    expect(settled.usages[0].post_use_processing_event_id).not.toBeNull();
    expect(String(settled.usages[0].post_use_processing_event_id))
      .toBe(String(settled.registers[0].processing_event_id));
    expect(settled.devices[0]).toMatchObject({ status: 'available', cycle_count: 1 });

    const replay = await fixture.record(session.id, body, operation);
    expect(replay).toEqual(recorded);
    await expect(fixture.record(session.id, { ...body, measured_tcv_ml: 91 }))
      .rejects.toMatchObject({ code: 'DIALYZER_REUSE_REGISTER_SETTLED', statusCode: 409 });
    const unchanged = await fixture.lifecycle(session.id);
    expect(unchanged).toEqual(settled);
    assertMarkerFree(recorded);
  });

  test('normalEndedRecordKeepsFailedReleaseNonAvailableUntilAppendOnlyAttempt', async () => {
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    await fixture.complete(session.id);
    const ended = await fixture.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    expect(ended.usages).toHaveLength(1);
    expect(ended.registers).toHaveLength(0);
    const recorded = await fixture.record(session.id, {
      dialyzer_serial: capture.device.manufacturer_serial,
      expected_version: ended.devices[0].version,
      disinfectant_contact_minutes: undefined,
    });
    expect(recorded.release).toEqual({
      verdict: 'not_established',
      missing_evidence: ['process_parameters', 'dirty_return', 'residual_test_pending'],
    });
    const failed = await fixture.lifecycle(session.id);
    expect(failed.registers).toHaveLength(1);
    expect(failed.devices).toHaveLength(1);
    expect(failed.registers[0].processing_event_id).not.toBeNull();
    expect(failed.devices[0].status).toBe('awaiting_reprocessing');
    const immutableRegister = failed.registers[0];

    const { recordDialyserReprocessingAttempt } = await import(
      '../services/clinical/dialysisDeviceLifecycleService.js'
    );
    const attempt = await recordDialyserReprocessingAttempt({
      tenantId: fixture.tenantId, deviceId: capture.device.id, actor: fixture.actor,
      body: {
        expected_version: failed.devices[0].version,
        integrity_test_result: 'pass', measured_tcv_ml: 94,
        reprocessing_agent: 'peracetic_acid', disinfectant_concentration_pct: 0.3,
        disinfectant_contact_minutes: 12, residual_test_result: 'negative',
      },
    });
    expect(attempt.attempt).toMatchObject({ verdict: 'released', missing_evidence: [] });
    const restored = await fixture.lifecycle(session.id);
    expect(restored.registers).toHaveLength(1);
    expect(restored.devices).toHaveLength(1);
    expect(restored.registers[0]).toEqual(immutableRegister);
    expect(restored.devices[0]).toMatchObject({ status: 'available', residual_test_pending: true });
    const attempts = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT attempt_no, verdict, dialyzer_reuse_register_id
         FROM dialyser_reprocessing_attempts WHERE tenant_id = $1::uuid AND device_id = $2`,
      fixture.tenantId, Number(capture.device.id),
    ));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_no: 1, verdict: 'released' });
    expect(String(attempts[0].dialyzer_reuse_register_id)).toBe(String(immutableRegister.id));

    const secondSession = await fixture.schedule();
    await expect(fixture.capture(secondSession.id, {
      manufacturer_serial: capture.device.manufacturer_serial,
      expected_version: restored.devices[0].version,
    })).rejects.toMatchObject({ code: 'RPD_RESIDUAL_TEST_REQUIRED' });
    const reused = await fixture.capture(secondSession.id, {
      manufacturer_serial: capture.device.manufacturer_serial,
      expected_version: restored.devices[0].version, pre_use_residual_test: 'negative',
    });
    expect(reused.usage.pre_use_residual_test).toBe('negative');
    expect(reused.device.residual_test_pending).toBe(false);
    assertMarkerFree(attempt);
  });
});
