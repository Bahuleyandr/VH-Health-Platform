import '../services/clinical/exposureHandlerBootstrap.js';
import { drainExposureOutbox } from '../services/clinical/bloodborneExposureOutboxService.js';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import {
  assertMarkerFree,
  createPlan4DialysisFixture,
  describeWithDatabase,
  prisma,
  setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('durable exposure at dialysis actual-use admission', () => {
  let fixture;

  beforeEach(async () => { fixture = await createPlan4DialysisFixture(); });
  afterEach(async () => { await fixture?.cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  test('committedMarkerBeforeDrainRefusesStartAndReplayAppliesExactlyOnce', async () => {
    const priorSession = await fixture.schedule();
    const capture = await fixture.capture(priorSession.id);
    await fixture.start(priorSession.id);
    await fixture.complete(priorSession.id);
    const returned = await fixture.lifecycle(priorSession.id);
    expect(returned.devices).toHaveLength(1);
    await fixture.record(priorSession.id, {
      dialyzer_serial: capture.device.manufacturer_serial,
      expected_version: returned.devices[0].version,
    });
    const prepared = await fixture.lifecycle(priorSession.id);
    expect(prepared.devices).toHaveLength(1);
    expect(prepared.devices[0].status).toBe('available');
    const nextSession = await fixture.schedule();
    await fixture.capture(nextSession.id, {
      manufacturer_serial: capture.device.manufacturer_serial,
      expected_version: prepared.devices[0].version, pre_use_residual_test: 'negative',
    });

    // Commit through the real transactional writer without invoking its post-commit
    // fast drain: a process crash at this boundary cannot erase the durable work.
    const marker = await setTenantTx(fixture.tenantId, tx => recordMarkerTx(tx, {
      tenantId: fixture.tenantId, patientUid: fixture.patientUid,
      marker: 'hbsag', result: 'reactive', testedOn: fixture.today,
      source: 'clinical_declaration', recordedBy: fixture.infectionControlActor.uid,
    }));
    const pending = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, status, marker_row_id FROM bloodborne_exposure_outbox
        WHERE tenant_id = $1::uuid AND marker_row_id = $2::bigint`,
      fixture.tenantId, Number(marker.id),
    ));
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
    const before = await fixture.lifecycle(nextSession.id);
    expect(before.session).toMatchObject({ status: 'scheduled', actual_start_at: null });
    await expect(fixture.start(nextSession.id)).rejects.toMatchObject({
      code: 'RPD_EXPOSURE_RECONCILIATION_PENDING', statusCode: 409,
    });
    expect(await fixture.lifecycle(nextSession.id)).toEqual(before);

    const firstDrain = await drainExposureOutbox({ tenantId: fixture.tenantId });
    expect(firstDrain).toMatchObject({ claimed: 1, delivered: 1, failed: 0, pending: 0 });
    const applied = await setTenantTx(fixture.tenantId, async tx => {
      const outbox = await tx.$queryRawUnsafe(
        `SELECT status FROM bloodborne_exposure_outbox
          WHERE tenant_id = $1::uuid AND id = $2::bigint`, fixture.tenantId, Number(pending[0].id),
      );
      const deliveries = await tx.$queryRawUnsafe(
        `SELECT handler_id, status, remaining_device_count, remaining_alert_count,
                remaining_notification_count
           FROM bloodborne_exposure_deliveries
          WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint ORDER BY handler_id`,
        fixture.tenantId, Number(pending[0].id),
      );
      const applications = await tx.$queryRawUnsafe(
        `SELECT id, hold_id, device_id, result FROM bloodborne_exposure_applications
          WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint ORDER BY id`,
        fixture.tenantId, Number(pending[0].id),
      );
      expect(outbox).toHaveLength(1);
      return { status: outbox[0].status, deliveries, applications };
    });
    expect(applied.status).toBe('delivered');
    expect(applied.deliveries).toHaveLength(2);
    for (const delivery of applied.deliveries) {
      expect(delivery).toMatchObject({
        status: 'complete', remaining_device_count: 0,
        remaining_alert_count: 0, remaining_notification_count: 0,
      });
    }
    expect(applied.applications).toHaveLength(1);
    expect(String(applied.applications[0].device_id)).toBe(String(capture.device.id));
    expect(applied.applications[0].hold_id).not.toBeNull();
    await expect(fixture.start(nextSession.id))
      .rejects.toMatchObject({ code: 'RPD_HOLD_ACTIVE', statusCode: 409 });
    expect(await drainExposureOutbox({ tenantId: fixture.tenantId }))
      .toMatchObject({ claimed: 0, delivered: 0, failed: 0, pending: 0 });
    const replayApplications = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT id, hold_id, device_id, result FROM bloodborne_exposure_applications
        WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint ORDER BY id`,
      fixture.tenantId, Number(pending[0].id),
    ));
    expect(replayApplications).toEqual(applied.applications);
    const heldLifecycle = await fixture.lifecycle(nextSession.id);
    expect(heldLifecycle.devices).toHaveLength(1);
    expect(heldLifecycle.devices[0].exposure_flag).toBe(true);
    expect(heldLifecycle.session).toMatchObject({ status: 'scheduled', actual_start_at: null });
    assertMarkerFree(heldLifecycle);
  });
});
