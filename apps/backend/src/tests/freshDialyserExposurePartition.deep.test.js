import { randomUUID } from 'node:crypto';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import { drainExposureOutbox, redriveExposureEvent } from '../services/clinical/bloodborneExposureOutboxService.js';
import { applyPlatformExposure, applyPlatformExposureTx, recordPredatingExposureOutcomesTx } from '../services/clinical/platformReprocessableExposureHandler.js';
import { registerDeviceTx, reserveDeviceTx } from '../services/clinical/reprocessableDeviceService.js';
import { lockPatientExposureTx } from '../services/clinical/patientExposureLock.js';
import { createPlan4DialysisFixture, describeWithDatabase, prisma, setTenantTx } from './helpers/plan4DialysisFixtures.js';

const COMPLETE = { remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0 };
const HANDLER = 'platform-reprocessable-devices.v1';

describeWithDatabase('fresh dialyser exposure partition', () => {
  let f;
  beforeEach(async () => { f = await createPlan4DialysisFixture(); });
  afterEach(async () => { await f?.cleanup(); }, 30000);
  afterAll(async () => { await prisma.$disconnect(); });
  const query = (sql, ...values) => setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(sql, ...values));

  async function device(input = {}) {
    return setTenantTx(f.tenantId, async tx => {
      await lockPatientExposureTx(tx, { tenantId: f.tenantId, patientUid: f.patientUid });
      const row = await registerDeviceTx(tx, {
        tenantId: f.tenantId, actor: f.actor,
        input: {
          domain: 'dialysis', category: 'dialyser', manufacturer: f.manufacturer,
          model_name: f.modelName, protocol_device_scope_id: f.scope.id,
          manufacturer_serial: randomUUID(), enrolled_via: 'session_capture', ...input,
        },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO reprocessable_device_dialysis_links (tenant_id,device_id,dedicated_patient_uid,dedicated_by)
         VALUES ($1::uuid,$2,$3::uuid,$4::uuid) ON CONFLICT (device_id) DO NOTHING`,
        f.tenantId, row.id, f.patientUid, f.actor.uid,
      );
      return row;
    });
  }

  async function event() {
    return setTenantTx(f.tenantId, async tx => {
      const marker = await recordMarkerTx(tx, {
        tenantId: f.tenantId, patientUid: f.patientUid, marker: 'hbsag', result: 'reactive',
        testedOn: f.today, source: 'clinical_declaration', recordedBy: f.infectionControlActor.uid,
      });
      const rows = await tx.$queryRawUnsafe(
        'SELECT id, event, occurred_at::text FROM bloodborne_exposure_outbox WHERE tenant_id=$1::uuid AND marker_row_id=$2',
        f.tenantId, marker.id,
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    });
  }

  const applications = () => query(
    `SELECT id,outbox_id,device_id,result,hold_id,metadata FROM bloodborne_exposure_applications
      WHERE tenant_id=$1::uuid AND handler_id=$2 ORDER BY outbox_id,device_id`, f.tenantId, HANDLER,
  );

  async function drain(apply = applyPlatformExposure) {
    const handlers = [
      { id: 'cath-device-reuse.v1', apply: async () => ({ ...COMPLETE }) },
      { id: HANDLER, apply },
    ];
    expect(handlers).toHaveLength(2);
    return drainExposureOutbox({ tenantId: f.tenantId, handlers });
  }

  test('reconciliationPinsGenuineAppliedAndExactPredatingOutcomePartition', async () => {
    const prior = await device();
    const firstEvent = await event();
    const fresh = [await device(), await device()];
    expect(fresh).toHaveLength(2);
    expect(await query('SELECT id FROM bloodborne_exposure_outbox WHERE tenant_id=$1::uuid', f.tenantId)).toHaveLength(1);
    expect(await query('SELECT id FROM reprocessable_devices WHERE tenant_id=$1::uuid', f.tenantId)).toHaveLength(3);
    await expect(drain()).resolves.toMatchObject({ delivered: 1, failed: 0 });
    const first = await applications();
    expect(first).toHaveLength(3);
    const genuinelyApplied = first.filter(row => row.result === 'hold_created' && row.hold_id != null);
    expect(genuinelyApplied.length).toBeGreaterThan(0);
    expect(genuinelyApplied).toHaveLength(1);
    expect(genuinelyApplied[0].device_id).toBe(prior.id);
    const excluded = first.filter(row => row.result === 'not_applicable_predates_creation');
    expect(excluded).toHaveLength(2);
    expect(excluded.map(row => row.device_id)).toEqual(fresh.map(row => row.id));
    expect(excluded.every(row => row.hold_id === null)).toBe(true);
    const unexposed = await query(
      'SELECT status,exposure_flag FROM reprocessable_devices WHERE tenant_id=$1::uuid AND id=ANY($2::bigint[]) ORDER BY id',
      f.tenantId, fresh.map(row => row.id),
    );
    expect(unexposed).toHaveLength(2);
    expect(unexposed).toEqual(fresh.map(() => ({ status: 'available', exposure_flag: false })));
    const alerts = await query('SELECT source_data FROM cds_alerts WHERE tenant_id=$1::uuid', f.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source_data.device_ids).toEqual([Number(prior.id)]);

    const later = await event();
    expect(await query('SELECT id FROM bloodborne_exposure_outbox WHERE tenant_id=$1::uuid', f.tenantId)).toHaveLength(2);
    await expect(drain(async () => { throw new Error('injected mixed-partition sweep failure'); }))
      .rejects.toMatchObject({ code: 'RPD_EXPOSURE_DRAIN_FAILED', result: { delivered: 0, failed: 1 } });
    const failed = await query(
      'SELECT status FROM bloodborne_exposure_outbox WHERE tenant_id=$1::uuid AND id=$2', f.tenantId, later.id,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect(await applications()).toEqual(first);
    await redriveExposureEvent({ tenantId: f.tenantId, outboxId: Number(later.id) });
    await expect(drain()).resolves.toMatchObject({ delivered: 1, failed: 0 });
    const all = await applications();
    expect(all).toHaveLength(6);
    expect(all.filter(row => row.hold_id != null)).toHaveLength(4);
    expect(all.filter(row => row.result === 'not_applicable_predates_creation')).toEqual(excluded);
    expect(all.filter(row => row.outbox_id === firstEvent.id)).toEqual(first);
    await expect(drain()).resolves.toMatchObject({ scanned: 0, failed: 0 });
    expect(await applications()).toEqual(all);
  });

  test('strictCreationBoundaryAppliesEqualityAndPreservesMicroseconds', async () => {
    const offsets = [-1, 0, 1];
    expect(offsets).toHaveLength(3);
    for (const offset of offsets) {
      const current = await device();
      const exposure = await event();
      await setTenantTx(f.tenantId, async tx => {
        // Only this synthetic event is moved to the exact database-precision boundary.
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
        const changed = await tx.$executeRawUnsafe(
          `UPDATE bloodborne_exposure_outbox event SET occurred_at=device.created_at+$4::int*INTERVAL '1 microsecond'
            FROM reprocessable_devices device
           WHERE event.tenant_id=$1::uuid AND event.id=$2 AND device.tenant_id=event.tenant_id AND device.id=$3`,
          f.tenantId, exposure.id, current.id, offset,
        );
        expect(changed).toBe(1);
      });
      await applyPlatformExposure(exposure.event, { outboxId: Number(exposure.id) });
      const rows = await query(
        `SELECT application.result,application.hold_id,
                application.metadata=jsonb_build_object('event_occurred_at',event.occurred_at,'device_created_at',device.created_at) AS exact_instants,
                EXTRACT(EPOCH FROM event.occurred_at-device.created_at)*1000000 AS delta
           FROM bloodborne_exposure_applications application
           JOIN bloodborne_exposure_outbox event ON event.tenant_id=application.tenant_id AND event.id=application.outbox_id
           JOIN reprocessable_devices device ON device.tenant_id=application.tenant_id AND device.id=application.device_id
          WHERE application.tenant_id=$1::uuid AND application.device_id=$2 AND application.outbox_id=$3`,
        f.tenantId, current.id, exposure.id,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].delta)).toBe(offset);
      if (offset < 0) {
        expect(rows[0]).toMatchObject({ result: 'not_applicable_predates_creation', hold_id: null, exact_instants: true });
      } else {
        expect(rows[0].result).toBe('hold_created');
        expect(rows[0].hold_id).not.toBeNull();
      }
    }
  });

  test('lateDiscoveredPrecreationEventOnUsedIdentityCannotCreateAnExclusion', async () => {
    const exposure = await event();
    const current = await device();
    const session = await f.schedule();
    await setTenantTx(f.tenantId, tx => reserveDeviceTx(tx, {
      tenantId: f.tenantId, deviceId: current.id, expectedVersion: current.version,
      patientUid: f.patientUid, owner: { dialysis_session_id: session.id },
      captureSource: 'admin_console', reuseScreen: {}, actor: f.actor,
    }));
    const usages = await query('SELECT id FROM reprocessable_device_usages WHERE tenant_id=$1::uuid AND device_id=$2', f.tenantId, current.id);
    expect(usages).toHaveLength(1);
    expect(await applications()).toHaveLength(0);
    await applyPlatformExposure(exposure.event, { outboxId: Number(exposure.id) });
    const outcomes = await applications();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe('hold_created');
    expect(outcomes[0].hold_id).not.toBeNull();
    const rebound = await device({ manufacturer_serial: current.manufacturer_serial, created_at: '2099-01-01T00:00:00Z' });
    expect(rebound.id).toBe(current.id);
    expect(rebound.created_at).toEqual(current.created_at);
    expect(await applications()).toEqual(outcomes);
  });

  test('recordedExclusionSurvivesFirstUsageButLaterExposureStillApplies', async () => {
    const prior = await event();
    const session = await f.schedule();
    const captured = await f.capture(session.id);
    const before = await applications();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ outbox_id: prior.id, result: 'not_applicable_predates_creation' });
    const usages = await query('SELECT id FROM reprocessable_device_usages WHERE tenant_id=$1::uuid AND device_id=$2', f.tenantId, Number(captured.device.id));
    expect(usages).toHaveLength(1);
    await applyPlatformExposure(prior.event, { outboxId: Number(prior.id) });
    expect(await applications()).toEqual(before);
    const later = await event();
    await applyPlatformExposure(later.event, { outboxId: Number(later.id) });
    const after = await applications();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({ outbox_id: later.id, result: 'hold_created' });
    expect(after[1].hold_id).not.toBeNull();
  });

  test('clientCreationInstantsAreIgnoredAndPersistedInstantsCannotBeRewritten', async () => {
    const before = await query('SELECT clock_timestamp()::text AS instant');
    expect(before).toHaveLength(1);
    const current = await device({ created_at: '2099-01-01T00:00:00Z' });
    const after = await query(
      'SELECT created_at >= $3::timestamptz AND created_at <= clock_timestamp() AS server_stamped FROM reprocessable_devices WHERE tenant_id=$1::uuid AND id=$2',
      f.tenantId, current.id, before[0].instant,
    );
    expect(after).toHaveLength(1);
    expect(after[0].server_stamped).toBe(true);
    await expect(query("UPDATE reprocessable_devices SET created_at='2099-01-01' WHERE tenant_id=$1::uuid AND id=$2", f.tenantId, current.id))
      .rejects.toThrow('Device creation instant is immutable');
    const exposure = await event();
    await expect(query("UPDATE bloodborne_exposure_outbox SET occurred_at='2000-01-01' WHERE tenant_id=$1::uuid AND id=$2", f.tenantId, exposure.id))
      .rejects.toThrow('Exposure occurrence instant is immutable');
  });

  test('matureTenantCardinalityRetainsEveryPatientScopedOutcomeWithoutAgeFiltering', async () => {
    const prior = await device();
    const patients = await setTenantTx(f.tenantId, async tx => {
      const added = await tx.$queryRawUnsafe(
        `INSERT INTO users (uid,tenant_id,phone,name,role,is_active,status,updated_at)
         SELECT gen_random_uuid(),$1::uuid,'+91'||lpad(series::text,10,'0'),
                'Synthetic exposure cardinality patient','PATIENT',TRUE,'active',NOW()
           FROM generate_series(1,99) series RETURNING uid`, f.tenantId,
      );
      expect(added).toHaveLength(99);
      return [f.patientUid, ...added.map(row => row.uid)];
    });
    expect(patients).toHaveLength(100);
    const events = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      `WITH markers AS (
         INSERT INTO patient_bloodborne_markers
           (tenant_id,patient_uid,marker,result,tested_on,source,recorded_by)
         SELECT $1::uuid,patient,marker,'reactive',current_date-round*90,
                'clinical_declaration',$3::uuid
           FROM unnest($2::uuid[]) patient
           CROSS JOIN unnest(ARRAY['hbsag','hcv','hiv']) marker
           CROSS JOIN generate_series(0,11) round
         RETURNING id,patient_uid,marker,tested_on
       ) INSERT INTO bloodborne_exposure_outbox
           (tenant_id,marker_row_id,patient_uid,marker,tested_on,event)
         SELECT $1::uuid,id,patient_uid,marker,tested_on,
                jsonb_build_object('tenantId',$1::text,'patientUid',patient_uid,
                  'marker',marker,'testedOn',tested_on,'markerRowId',id)
           FROM markers RETURNING id,patient_uid,event`,
      f.tenantId, patients, f.infectionControlActor.uid,
    ));
    expect(events).toHaveLength(3600);
    const fresh = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      `WITH devices AS (
         INSERT INTO reprocessable_devices
           (tenant_id,domain,category,manufacturer_serial,manufacturer,model_name,
            protocol_device_scope_id,enrolled_via,created_by,metadata)
         SELECT $1::uuid,'dialysis','dialyser',gen_random_uuid()::text,$3,$4,$5::bigint,
                'session_capture',$6::uuid,jsonb_build_object('fixture_patient',patient)
           FROM unnest($2::uuid[]) patient CROSS JOIN generate_series(1,2)
         RETURNING id,(metadata->>'fixture_patient')::uuid AS patient_uid
       ) INSERT INTO reprocessable_device_dialysis_links
           (tenant_id,device_id,dedicated_patient_uid,dedicated_by)
         SELECT $1::uuid,id,patient_uid,$6::uuid FROM devices
         RETURNING device_id AS id,dedicated_patient_uid AS patient_uid`,
      f.tenantId, patients, f.manufacturer, f.modelName, f.scope.id, f.actor.uid,
    ));
    expect(fresh).toHaveLength(200);
    const devices = [{ id: prior.id, patient_uid: f.patientUid }, ...fresh];
    expect(devices).toHaveLength(201);
    const scope = await query(
      `SELECT count(*)::int AS pairs FROM bloodborne_exposure_outbox event
         JOIN reprocessable_device_dialysis_links link
           ON link.tenant_id=event.tenant_id AND link.dedicated_patient_uid=event.patient_uid
        WHERE event.tenant_id=$1::uuid`, f.tenantId,
    );
    expect(scope).toHaveLength(1);
    expect(events.length * devices.length).toBe(723600);
    expect(scope[0].pairs).toBe(7236);
    for (const current of devices) {
      await setTenantTx(f.tenantId, async tx => {
        await lockPatientExposureTx(tx, { tenantId: f.tenantId, patientUid: current.patient_uid });
        await recordPredatingExposureOutcomesTx(tx, {
          tenantId: f.tenantId, patientUid: current.patient_uid, deviceId: current.id,
        });
      });
    }
    const controlEvents = events.filter(row => row.patient_uid === f.patientUid);
    expect(controlEvents).toHaveLength(36);
    for (const exposure of controlEvents) {
      await setTenantTx(f.tenantId, async tx => {
        await lockPatientExposureTx(tx, { tenantId: f.tenantId, patientUid: f.patientUid });
        await applyPlatformExposureTx(tx, exposure.event, { outboxId: exposure.id });
      });
    }
    const outcomes = await applications();
    expect(outcomes).toHaveLength(7236);
    const applied = outcomes.filter(row => row.hold_id != null);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toHaveLength(36);
    expect(applied.every(row => row.device_id === prior.id)).toBe(true);
    expect(outcomes.filter(row => row.result === 'not_applicable_predates_creation')).toHaveLength(7200);
  }, 60000);

  test('anyHoldIncludingReleasedOrExposureHistoryPreventsFreshness', async () => {
    const exposure = await event();
    const devices = [await device(), await device(), await device()];
    expect(devices).toHaveLength(3);
    const historical = await query(
      `INSERT INTO reprocessable_device_holds
         (tenant_id,device_id,domain,hold_type,reason_code,status,placed_via,
          released_at,released_by,released_role,release_adjudication,release_requires_processing)
       VALUES ($1::uuid,$2,'dialysis','manual','manual_ic','active','manual',NULL,NULL,NULL,NULL,FALSE),
              ($1::uuid,$3,'dialysis','manual','manual_ic','released','manual',
               clock_timestamp(),$4::uuid,'INFECTION_CONTROL_OFFICER','Synthetic erroneous hold reviewed',FALSE)
       RETURNING id,status`, f.tenantId, devices[0].id, devices[1].id, f.infectionControlActor.uid,
    );
    expect(historical).toHaveLength(2);
    await query('UPDATE reprocessable_devices SET exposure_flag=TRUE WHERE tenant_id=$1::uuid AND id=$2', f.tenantId, devices[2].id);
    expect(await query('SELECT id FROM reprocessable_device_usages WHERE tenant_id=$1::uuid', f.tenantId)).toHaveLength(0);
    await applyPlatformExposure(exposure.event, { outboxId: Number(exposure.id) });
    const outcomes = await applications();
    expect(outcomes).toHaveLength(3);
    expect(outcomes.filter(row => row.result === 'not_applicable_predates_creation')).toHaveLength(0);
    expect(outcomes.filter(row => row.result === 'hold_created' && row.hold_id != null)).toHaveLength(3);
    const retained = await query(
      'SELECT id,status FROM reprocessable_device_holds WHERE tenant_id=$1::uuid AND id=ANY($2::bigint[]) ORDER BY id',
      f.tenantId, historical.map(row => row.id),
    );
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(historical);
  });

  test('legacyUnknownOccurrenceCannotAuthorizeAnExclusion', async () => {
    const exposure = await event();
    const current = await device();
    await setTenantTx(f.tenantId, async tx => {
      // Migration-era rows keep NULL rather than inventing a historical occurrence instant.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
      expect(await tx.$executeRawUnsafe(
        'UPDATE bloodborne_exposure_outbox SET occurred_at=NULL WHERE tenant_id=$1::uuid AND id=$2',
        f.tenantId, exposure.id,
      )).toBe(1);
    });
    await applyPlatformExposure(exposure.event, { outboxId: Number(exposure.id) });
    const outcomes = await applications();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ device_id: current.id, result: 'hold_created' });
    expect(outcomes[0].hold_id).not.toBeNull();
  });
});
