import { randomInt, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import {
  drainExposureOutbox,
  enqueueExposureEventTx,
  reapExposureLeases,
  reconcileExposureAdmissionTx,
  redriveExposureEvent,
} from '../services/clinical/bloodborneExposureOutboxService.js';
import { applyPlatformExposure } from '../services/clinical/platformReprocessableExposureHandler.js';
import { registerDeviceTx, releaseHoldTx } from '../services/clinical/reprocessableDeviceService.js';
import { lockDeviceExposurePatientsTx } from '../services/clinical/patientExposureLock.js';
import { createPlan4DialysisFixture } from './helpers/plan4DialysisFixtures.js';

const describeIfDb = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;
const HANDLER_IDS = ['cath-device-reuse.v1', 'platform-reprocessable-devices.v1'];
const COMPLETE = Object.freeze({
  remaining_device_count: 0,
  remaining_alert_count: 0,
  remaining_notification_count: 0,
});

jest.setTimeout(60000);

describeIfDb('bloodborne exposure durable delivery', () => {
  let tenantId;
  let patientUid;
  let actorUid;
  let testedOn;

  const query = (sql, ...values) => setTenantTx(tenantId, tx => tx.$queryRawUnsafe(sql, ...values));
  const outboxRows = () => query(
    `SELECT id, marker_row_id, patient_uid, marker, tested_on::text, event,
            status, attempts, lease_owner, lease_expires_at, delivered_at
       FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid ORDER BY id`, tenantId,
  );
  const deliveryRows = outboxId => query(
    `SELECT handler_id, status, attempts, remaining_device_count, remaining_alert_count,
            remaining_notification_count, lease_owner, lease_expires_at, result
       FROM bloodborne_exposure_deliveries
      WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint ORDER BY handler_id`, tenantId, outboxId,
  );
  const writeMarkerTx = (tx, input = {}) => recordMarkerTx(tx, {
    tenantId, patientUid, marker: 'hbsag', result: 'reactive', testedOn,
    source: 'clinical_declaration', recordedBy: actorUid, ...input,
  });
  const seedEvent = (input = {}) => setTenantTx(tenantId, async (tx) => {
    const marker = await writeMarkerTx(tx, input);
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, marker_row_id FROM bloodborne_exposure_outbox
        WHERE tenant_id = $1::uuid AND marker_row_id = $2::bigint`, tenantId, marker.id,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  });
  const successfulHandlers = () => HANDLER_IDS.map(id => ({ id, apply: jest.fn(async () => ({ ...COMPLETE })) }));

  beforeEach(async () => {
    tenantId = randomUUID();
    patientUid = randomUUID();
    actorUid = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Exposure outbox test')`,
      tenantId, `exposure-outbox-${tenantId}`,
    );
    await setTenantTx(tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $3::uuid, $4, 'Exposure patient', 'PATIENT', true, 'active', NOW()),
                ($2::uuid, $3::uuid, $5, 'Exposure recorder', 'PATHOLOGIST', true, 'active', NOW())`,
        patientUid, actorUid, tenantId, `+91${randomInt(9000000000, 9999999999)}`, `+91${randomInt(9000000000, 9999999999)}`,
      );
      const dates = await tx.$queryRawUnsafe('SELECT CURRENT_DATE::text AS today');
      testedOn = dates[0].today;
    });
  });

  afterEach(async () => {
    const cleanupTenantId = tenantId;
    await setTenantTx(cleanupTenantId, async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM bloodborne_exposure_deliveries WHERE tenant_id = $1::uuid`, cleanupTenantId);
      await tx.$executeRawUnsafe(`DELETE FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`, cleanupTenantId);
      await tx.$executeRawUnsafe(`DELETE FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid`, cleanupTenantId);
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, cleanupTenantId);
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, cleanupTenantId);
    }, { timeout: 30000 });
  });

  test('commits marker and exact core-three exposure events atomically and deduplicates replay', async () => {
    const coreMarkers = ['hbsag', 'hcv', 'hiv'];
    const excluded = [
      { marker: 'hbsag', result: 'non_reactive' },
      { marker: 'cjd_suspected' },
      { marker: 'other', markerLabel: 'Independent marker' },
    ];
    expect(coreMarkers).toHaveLength(3);
    expect(excluded).toHaveLength(3);
    const markerIds = [];
    await setTenantTx(tenantId, async (tx) => {
      for (const markerName of coreMarkers) {
        const marker = await writeMarkerTx(tx, { marker: markerName });
        markerIds.push(marker.id);
        await enqueueExposureEventTx(tx, {
          tenantId, patientUid, marker: markerName, testedOn, markerRowId: marker.id,
        });
      }
      for (const input of excluded) await writeMarkerTx(tx, input);
      const visibleInside = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      expect(visibleInside).toEqual([{ count: 3 }]);
      expect(await outboxRows()).toHaveLength(0);
    });

    const events = await outboxRows();
    expect(events).toHaveLength(3);
    expect(markerIds).toHaveLength(3);
    expect(events.map(row => ({
      marker: row.marker,
      marker_row_id: Number(row.marker_row_id),
      event: row.event,
      status: row.status,
    }))).toEqual(coreMarkers.map((marker, index) => ({
      marker,
      marker_row_id: markerIds[index],
      event: { tenantId, patientUid, marker, testedOn, markerRowId: markerIds[index] },
      status: 'pending',
    })));
    expect(await query(
      `SELECT count(*)::int AS count FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid`, tenantId,
    )).toEqual([{ count: 6 }]);
  });

  test('rolls marker and exposure event back together before commit', async () => {
    const failure = new Error('rollback exposure fixture');
    await expect(setTenantTx(tenantId, async (tx) => {
      await writeMarkerTx(tx);
      const rows = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      expect(rows).toEqual([{ count: 1 }]);
      throw failure;
    })).rejects.toBe(failure);
    expect(await outboxRows()).toHaveLength(0);
    expect(await query(
      `SELECT count(*)::int AS count FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid`, tenantId,
    )).toEqual([{ count: 0 }]);
  });

  test('exposureDrainReportsHandlerFailureMidSweep', async () => {
    expect(HANDLER_IDS).toHaveLength(2);
    const control = await seedEvent();
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    expect(await outboxRows()).toHaveLength(1);
    expect(await drainExposureOutbox({ tenantId, handlers })).toMatchObject({
      scanned: 1, claimed: 1, delivered: 1, failed: 0,
    });
    const controlDeliveries = await deliveryRows(control.id);
    expect(controlDeliveries).toHaveLength(2);
    expect(controlDeliveries.map(row => ({ handler_id: row.handler_id, status: row.status }))).toEqual(
      HANDLER_IDS.map(handler_id => ({ handler_id, status: 'complete' })),
    );
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([1, 1]);

    const event = await seedEvent({ marker: 'hcv' });
    expect(await outboxRows()).toHaveLength(2);
    handlers[1].apply.mockImplementationOnce(async () => { throw new Error('injected exposure handler failure'); });
    let failure;
    try {
      await drainExposureOutbox({ tenantId, handlers });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'RPD_EXPOSURE_DRAIN_FAILED',
      result: { scanned: 1, claimed: 1, delivered: 0, failed: 1 },
    });
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([2, 2]);
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.status)).toEqual(['delivered', 'failed']);
    const failedDeliveries = await deliveryRows(event.id);
    expect(failedDeliveries).toHaveLength(2);
    expect(failedDeliveries.map(row => ({ handler_id: row.handler_id, status: row.status }))).toEqual([
      { handler_id: HANDLER_IDS[0], status: 'complete' },
      { handler_id: HANDLER_IDS[1], status: 'failed' },
    ]);

    await redriveExposureEvent({ tenantId, outboxId: event.id });
    expect(await drainExposureOutbox({ tenantId, handlers })).toMatchObject({ delivered: 1, failed: 0 });
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([2, 3]);
    const restored = await outboxRows();
    expect(restored).toHaveLength(2);
    expect(restored.map(row => row.status)).toEqual(['delivered', 'delivered']);
  });

  test('does not turn a resolved malformed handler result into delivered work', async () => {
    const invalidResults = [undefined, {}, { remaining_device_count: 0 },
      { ...COMPLETE, remaining_alert_count: -1 },
      { ...COMPLETE, remaining_notification_count: 0.5 },
      { ...COMPLETE, remaining_device_count: '0' }];
    expect(invalidResults).toHaveLength(6);
    const events = [];
    for (const result of invalidResults) events.push({ ...(await seedEvent()), result });
    expect(events).toHaveLength(6);
    const resultsByMarker = new Map(events.map(event => [String(event.marker_row_id), event.result]));
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    handlers[1].apply.mockImplementation(async event => resultsByMarker.get(String(event.markerRowId)));
    await expect(drainExposureOutbox({ tenantId, handlers })).rejects.toMatchObject({
      code: 'RPD_EXPOSURE_DRAIN_FAILED', result: { scanned: 6, delivered: 0, failed: 6 },
    });
    const rows = await outboxRows();
    expect(rows).toHaveLength(6);
    expect(rows.map(row => row.status)).toEqual(Array(6).fill('failed'));
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([6, 6]);
  });

  test('requires device alert and notification obligations all to reach zero', async () => {
    const fields = ['remaining_device_count', 'remaining_alert_count', 'remaining_notification_count'];
    expect(fields).toHaveLength(3);
    const events = [];
    for (const field of fields) events.push({ ...(await seedEvent()), field });
    expect(events).toHaveLength(3);
    const fieldsByMarker = new Map(events.map(event => [String(event.marker_row_id), event.field]));
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    handlers[1].apply.mockImplementation(async event => ({
      ...COMPLETE, [fieldsByMarker.get(String(event.markerRowId))]: 1,
    }));
    await expect(drainExposureOutbox({ tenantId, handlers })).rejects.toMatchObject({
      code: 'RPD_EXPOSURE_DRAIN_FAILED', result: { scanned: 3, delivered: 0, failed: 3 },
    });
    for (const event of events) {
      const rows = await deliveryRows(event.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ status: 'failed', ...COMPLETE, [event.field]: 1 });
      await redriveExposureEvent({ tenantId, outboxId: event.id });
    }
    handlers[1].apply.mockImplementation(async () => ({ ...COMPLETE }));
    expect(await drainExposureOutbox({ tenantId, handlers })).toMatchObject({ delivered: 3, failed: 0 });
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([3, 6]);
    const rows = await outboxRows();
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.status)).toEqual(['delivered', 'delivered', 'delivered']);
  });

  test('reaps an expired event lease and completes the durable retry', async () => {
    const event = await seedEvent();
    await query(
      `UPDATE bloodborne_exposure_outbox
          SET status = 'processing', attempts = 1, lease_owner = 'expired-worker',
              lease_expires_at = NOW() - INTERVAL '1 minute'
        WHERE tenant_id = $1::uuid AND id = $2::bigint RETURNING id`, tenantId, event.id,
    );
    await reapExposureLeases({ tenantId });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', lease_owner: null, lease_expires_at: null });
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    expect(await drainExposureOutbox({ tenantId, handlers })).toMatchObject({ delivered: 1, failed: 0 });
    const completed = await outboxRows();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  test('rejects incomplete consumer populations before claiming an event', async () => {
    await seedEvent();
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    const invalidSets = [[], [handlers[0]], [handlers[1]], [...handlers, handlers[0]]];
    expect(invalidSets).toHaveLength(4);
    for (const consumerSet of invalidSets) {
      await expect(drainExposureOutbox({ tenantId, handlers: consumerSet })).rejects.toMatchObject({
        code: 'RPD_EXPOSURE_HANDLERS_MISSING',
      });
    }
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([0, 0]);
  });

  test('fences a stale completion after another worker reclaims and delivers the event', async () => {
    const event = await seedEvent();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const staleHandlers = successfulHandlers();
    const currentHandlers = successfulHandlers();
    expect(staleHandlers).toHaveLength(2);
    expect(currentHandlers).toHaveLength(2);
    staleHandlers[0].apply.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { ...COMPLETE };
    });
    const staleDrain = drainExposureOutbox({ tenantId, handlers: staleHandlers }).then(
      value => ({ value }), error => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        staleDrain.then(outcome => { throw outcome.error ?? new Error('worker returned before handler barrier'); }),
      ]);
      const claimed = await outboxRows();
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ status: 'processing', attempts: 1 });
      expect(claimed[0].lease_owner).toEqual(expect.any(String));
      await query(
        `UPDATE bloodborne_exposure_outbox SET lease_expires_at = NOW() - INTERVAL '1 minute'
          WHERE tenant_id = $1::uuid AND id = $2::bigint RETURNING id`, tenantId, event.id,
      );
      expect(await reapExposureLeases({ tenantId })).toEqual({ reaped: 1 });
      const expiredDeliveries = await deliveryRows(event.id);
      expect(expiredDeliveries).toHaveLength(1);
      expect(expiredDeliveries[0]).toMatchObject({ status: 'failed', lease_owner: null, lease_expires_at: null });
      expect(await drainExposureOutbox({ tenantId, handlers: currentHandlers })).toMatchObject({
        scanned: 1, delivered: 1, failed: 0, lost_fence: 0,
      });
    } finally {
      resume.resolve();
      await staleDrain;
    }
    expect(await staleDrain).toMatchObject({
      error: { code: 'RPD_EXPOSURE_DRAIN_FAILED', result: { delivered: 0, failed: 1, lost_fence: 1 } },
    });
    expect(staleHandlers.map(handler => handler.apply.mock.calls.length)).toEqual([1, 0]);
    expect(currentHandlers.map(handler => handler.apply.mock.calls.length)).toEqual([1, 1]);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 2, lease_owner: null });
    const deliveries = await deliveryRows(event.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map(row => row.status)).toEqual(['complete', 'complete']);
  });

  test('reopens only platform delivery when a delivered event gains new dialysis dedication', async () => {
    const fixture = await createPlan4DialysisFixture();
    const handlers = successfulHandlers();
    expect(handlers).toHaveLength(2);
    handlers[1].apply.mockImplementation(applyPlatformExposure);
    const scopedQuery = (sql, ...values) => setTenantTx(
      fixture.tenantId, tx => tx.$queryRawUnsafe(sql, ...values),
    );
    const createDevice = () => setTenantTx(fixture.tenantId, async (tx) => {
      const devices = await tx.$queryRawUnsafe(
        `INSERT INTO reprocessable_devices
           (tenant_id, domain, category, manufacturer_serial, manufacturer, model_name,
            protocol_device_scope_id, enrolled_via, created_by)
         VALUES ($1::uuid, 'dialysis', 'dialyser', $2, $3, $4, $5::bigint, 'console', $6::uuid)
         RETURNING id`, fixture.tenantId, randomUUID(), fixture.manufacturer,
        fixture.modelName, fixture.scope.id, fixture.actor.uid,
      );
      expect(devices).toHaveLength(1);
      return devices[0].id;
    });
    const dedicateDevice = (deviceId) => setTenantTx(fixture.tenantId, tx => tx.$executeRawUnsafe(
        `INSERT INTO reprocessable_device_dialysis_links
           (tenant_id, device_id, dedicated_patient_uid, dedicated_by)
         VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid)`,
        fixture.tenantId, deviceId, fixture.patientUid, fixture.actor.uid,
    ));
    try {
      const firstDeviceId = await createDevice();
      const secondDeviceId = await createDevice();
      expect(await scopedQuery('SELECT id FROM reprocessable_devices WHERE tenant_id=$1::uuid', fixture.tenantId)).toHaveLength(2);
      await setTenantTx(fixture.tenantId, tx => recordMarkerTx(tx, {
        tenantId: fixture.tenantId, patientUid: fixture.patientUid, marker: 'hbsag',
        result: 'reactive', testedOn: fixture.today, source: 'clinical_declaration',
        recordedBy: fixture.infectionControlActor.uid,
      }));
      const events = await scopedQuery(
        `SELECT id FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`, fixture.tenantId,
      );
      expect(events).toHaveLength(1);
      expect(await drainExposureOutbox({ tenantId: fixture.tenantId, handlers })).toMatchObject({
        scanned: 1, delivered: 1, failed: 0,
      });
      expect(await scopedQuery(
        `SELECT count(*)::int AS count FROM bloodborne_exposure_applications WHERE tenant_id = $1::uuid`,
        fixture.tenantId,
      )).toEqual([{ count: 0 }]);

      await dedicateDevice(firstDeviceId);
      expect(await drainExposureOutbox({ tenantId: fixture.tenantId, handlers })).toMatchObject({
        scanned: 1, delivered: 1, failed: 0,
      });
      const firstApplications = await scopedQuery(
        `SELECT id, device_id, hold_id FROM bloodborne_exposure_applications
          WHERE tenant_id = $1::uuid ORDER BY id`, fixture.tenantId,
      );
      expect(firstApplications).toHaveLength(1);
      expect(firstApplications[0].device_id).toBe(firstDeviceId);
      const firstDevices = await scopedQuery(
        `SELECT id, status, version, exposure_flag FROM reprocessable_devices
          WHERE tenant_id = $1::uuid AND id = $2::bigint`, fixture.tenantId, firstDeviceId,
      );
      expect(firstDevices).toHaveLength(1);
      expect(firstDevices[0]).toMatchObject({ id: firstDeviceId, status: 'quarantined', exposure_flag: true });
      await setTenantTx(fixture.tenantId, tx => releaseHoldTx(tx, {
        tenantId: fixture.tenantId,
        holdId: Number(firstApplications[0].hold_id),
        expectedVersion: firstDevices[0].version,
        actor: fixture.infectionControlActor,
        approval: {
          approved_by: fixture.infectionControlActor.uid,
          approved_role: fixture.infectionControlActor.role,
          approved_at: new Date().toISOString(),
          adjudication: 'Recorded exposure reviewed; processing remains required',
          protocol_id: fixture.protocol.id,
          requires_processing: true,
        },
      }));
      const releasedDevices = await scopedQuery(
        `SELECT id, status, version, exposure_flag FROM reprocessable_devices
          WHERE tenant_id = $1::uuid AND id = $2::bigint`, fixture.tenantId, firstDeviceId,
      );
      expect(releasedDevices).toHaveLength(1);
      expect(releasedDevices[0]).toMatchObject({ id: firstDeviceId, status: 'awaiting_reprocessing', exposure_flag: true });

      await dedicateDevice(secondDeviceId);
      expect(await drainExposureOutbox({ tenantId: fixture.tenantId, handlers })).toMatchObject({
        scanned: 1, delivered: 1, failed: 0,
      });
      const applications = await scopedQuery(
        `SELECT id, device_id, hold_id FROM bloodborne_exposure_applications
          WHERE tenant_id = $1::uuid ORDER BY id`, fixture.tenantId,
      );
      expect(applications).toHaveLength(2);
      expect(applications[0]).toEqual(firstApplications[0]);
      expect(applications[1].device_id).toBe(secondDeviceId);
      const devices = await scopedQuery(
        `SELECT id, status, version, exposure_flag FROM reprocessable_devices
          WHERE tenant_id = $1::uuid ORDER BY id`, fixture.tenantId,
      );
      expect(devices).toHaveLength(2);
      expect(devices[0]).toEqual(releasedDevices[0]);
      expect(devices[1]).toMatchObject({ id: secondDeviceId, status: 'quarantined', exposure_flag: true });
      const firstHolds = await scopedQuery(
        `SELECT id, status, release_requires_processing FROM reprocessable_device_holds
          WHERE tenant_id = $1::uuid AND device_id = $2::bigint ORDER BY id`,
        fixture.tenantId, firstDeviceId,
      );
      expect(firstHolds).toHaveLength(1);
      expect(firstHolds[0]).toEqual({
        id: firstApplications[0].hold_id, status: 'released', release_requires_processing: true,
      });
      expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([1, 3]);
      const deliveries = await scopedQuery(
        `SELECT handler_id, status FROM bloodborne_exposure_deliveries
          WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint ORDER BY handler_id`,
        fixture.tenantId, events[0].id,
      );
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map(row => row.status)).toEqual(['complete', 'complete']);
      expect(await drainExposureOutbox({ tenantId: fixture.tenantId, handlers })).toMatchObject({
        scanned: 0, delivered: 0, failed: 0,
      });
      expect(handlers.map(handler => handler.apply.mock.calls.length)).toEqual([1, 3]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('retrospectivePendingCheckPreservesDefaultAdmissionRefusalAndUnappliedEvent', async () => {
    const fixture = await createPlan4DialysisFixture();
    try {
      const device = await setTenantTx(fixture.tenantId, async (tx) => {
        const registered = await registerDeviceTx(tx, {
          tenantId: fixture.tenantId, actor: fixture.actor,
          input: {
            domain: 'dialysis', category: 'dialyser', manufacturer_serial: randomUUID(),
            manufacturer: fixture.manufacturer, model_name: fixture.modelName,
            protocol_device_scope_id: fixture.scope.id, enrolled_via: 'session_capture',
          },
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO reprocessable_device_dialysis_links
             (tenant_id, device_id, dedicated_patient_uid, dedicated_by)
           VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid)`,
          fixture.tenantId, registered.id, fixture.patientUid, fixture.actor.uid,
        );
        await recordMarkerTx(tx, {
          tenantId: fixture.tenantId, patientUid: fixture.patientUid, marker: 'hbsag',
          result: 'reactive', testedOn: fixture.today, source: 'clinical_declaration',
          recordedBy: fixture.infectionControlActor.uid,
        });
        return registered;
      });
      const check = (options = {}) => setTenantTx(fixture.tenantId, async (tx) => {
        const input = { tenantId: fixture.tenantId, patientUid: fixture.patientUid, deviceId: device.id };
        const lockedPatientUids = await lockDeviceExposurePatientsTx(tx, input);
        expect(lockedPatientUids).toHaveLength(1);
        expect(lockedPatientUids).toEqual([fixture.patientUid]);
        const devices = await tx.$queryRawUnsafe(
          `SELECT id FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $2::bigint FOR UPDATE`,
          fixture.tenantId, device.id,
        );
        expect(devices).toHaveLength(1);
        return reconcileExposureAdmissionTx(tx, { ...input, lockedPatientUids, ...options });
      });
      const queryFixture = (sql, ...values) => setTenantTx(
        fixture.tenantId, tx => tx.$queryRawUnsafe(sql, ...values),
      );
      const events = await queryFixture(
        `SELECT id, status, attempts FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`,
        fixture.tenantId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'pending', attempts: 0 });
      await expect(check()).rejects.toMatchObject({ code: 'RPD_EXPOSURE_RECONCILIATION_PENDING' });
      await expect(check({ refusePending: false })).resolves.toEqual({ complete: false });
      await expect(check({ refusePending: false, lockedPatientUids: [] })).rejects.toMatchObject({
        code: 'RPD_EXPOSURE_RECONCILIATION_PENDING',
      });
      expect(await queryFixture(
        `SELECT id, status, attempts FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`,
        fixture.tenantId,
      )).toEqual(events);
      expect(await queryFixture(
        `SELECT id FROM bloodborne_exposure_applications WHERE tenant_id = $1::uuid`, fixture.tenantId,
      )).toHaveLength(0);
      expect(await queryFixture(
        `SELECT id FROM reprocessable_device_holds WHERE tenant_id = $1::uuid`, fixture.tenantId,
      )).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
