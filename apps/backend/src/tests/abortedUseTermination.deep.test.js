import { cancelSession } from '../services/clinical/dialysisService.js';
import {
  createPlan4DialysisFixture,
  describeWithDatabase,
  prisma,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('aborted dialysis use termination', () => {
  let fixture;

  beforeEach(async () => { fixture = await createPlan4DialysisFixture(); });
  afterEach(async () => { await fixture?.cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  test('earlyTerminationClosesUsageWithoutCircularStatutoryPrerequisite', async () => {
    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    await fixture.start(session.id);
    const active = await fixture.lifecycle(session.id);
    expect(active.usages).toHaveLength(1);
    expect(active.devices).toHaveLength(1);
    expect(active.registers).toHaveLength(0);
    expect(active.usages[0].returned_at).toBeNull();
    expect(active.devices[0].status).toBe('in_case');
    await expect(fixture.record(session.id, {
      dialyzer_serial: capture.device.manufacturer_serial,
    })).rejects.toMatchObject({ code: 'RPD_USE_NOT_ENDED', statusCode: 409 });
    await expect(cancelSession({
      tenantId: fixture.tenantId, id: session.id, actor: fixture.actor,
      pack_condition: 'sealed_unopened', reason: 'Use already began',
    })).rejects.toMatchObject({ code: 'RPD_RETURN_REQUIRED', statusCode: 409 });
    expect(await fixture.lifecycle(session.id)).toEqual(active);

    await fixture.complete(session.id, {
      early_termination: true, early_termination_reason: 'Clinician stopped treatment early',
    });
    const ended = await fixture.lifecycle(session.id);
    expect(ended.usages).toHaveLength(1);
    expect(ended.devices).toHaveLength(1);
    expect(ended.registers).toHaveLength(0);
    expect(ended.session).toMatchObject({
      status: 'completed', early_termination: true,
      early_termination_reason: 'Clinician stopped treatment early',
    });
    expect(ended.session.actual_end_at).not.toBeNull();
    expect(ended.usages[0].returned_at).not.toBeNull();
    expect(ended.devices[0]).toMatchObject({ status: 'awaiting_reprocessing', current_usage_id: null });
  });

  test('earlyTerminationRequiresReasonBeforeSessionOrUsageWrites', async () => {
    const session = await fixture.schedule();
    await fixture.capture(session.id);
    await fixture.start(session.id);
    const active = await fixture.lifecycle(session.id);
    await expect(fixture.complete(session.id, { early_termination: true }))
      .rejects.toMatchObject({ code: 'DIALYSIS_EARLY_TERMINATION_REASON_REQUIRED', statusCode: 400 });
    expect(await fixture.lifecycle(session.id)).toEqual(active);
  });

  test('darkLegacyRecordAlsoRequiresCompletedSessionWithActualEnd', async () => {
    await fixture.cleanup();
    fixture = await createPlan4DialysisFixture({ activePolicy: false });
    const session = await fixture.schedule();
    const legacyBody = { dialyzer_serial: 'LEGACY-END-GUARD', reuse_cycle_count: 0 };
    await expect(fixture.record(session.id, legacyBody))
      .rejects.toMatchObject({ code: 'RPD_USE_NOT_ENDED', statusCode: 409 });
    await fixture.start(session.id);
    await expect(fixture.record(session.id, legacyBody))
      .rejects.toMatchObject({ code: 'RPD_USE_NOT_ENDED', statusCode: 409 });
    await fixture.complete(session.id, {
      early_termination: true, early_termination_reason: 'Legacy session stopped early',
    });
    const record = await fixture.record(session.id, legacyBody);
    expect(record.release_status).toBe('legacy');
    const ended = await fixture.lifecycle(session.id);
    expect(ended.registers).toHaveLength(1);
    expect(ended.usages).toHaveLength(0);
    expect(ended.devices).toHaveLength(0);
    expect(ended.session).toMatchObject({ status: 'completed', early_termination: true });
    expect(ended.session.actual_end_at).not.toBeNull();
  });
});
