import { placeHoldTx } from '../services/clinical/reprocessableDeviceService.js';
import {
  createPlan4DialysisFixture,
  describeWithDatabase,
  prisma,
  setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('hold between dialysis capture and actual use', () => {
  let fixture;

  beforeEach(async () => { fixture = await createPlan4DialysisFixture(); });
  afterEach(async () => { await fixture?.cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  test('newHoldAfterCaptureRefusesActualStartWhileUnheldControlStarts', async () => {
    const control = await fixture.schedule();
    await fixture.capture(control.id);
    const started = await fixture.start(control.id);
    expect(started.status).toBe('in_progress');
    expect(started.actual_start_at).not.toBeNull();
    await fixture.complete(control.id);

    const session = await fixture.schedule();
    const capture = await fixture.capture(session.id);
    const held = await setTenantTx(fixture.tenantId, tx => placeHoldTx(tx, {
      tenantId: fixture.tenantId, deviceId: capture.device.id,
      holdType: 'inspection_failed', reasonCode: 'return_condition_damaged', placedVia: 'manual',
      placedBy: fixture.infectionControlActor.uid, expectedVersion: capture.device.version,
      sourceUsageId: capture.usage.id,
    }));
    expect(held.hold).toMatchObject({ status: 'active', pending_return: true });
    const before = await fixture.lifecycle(session.id);
    expect(before.usages).toHaveLength(1);
    expect(before.devices).toHaveLength(1);
    expect(before.session).toMatchObject({ status: 'scheduled', actual_start_at: null });
    await expect(fixture.start(session.id))
      .rejects.toMatchObject({ code: 'RPD_HOLD_ACTIVE', statusCode: 409 });
    expect(await fixture.lifecycle(session.id)).toEqual(before);
  });
});
