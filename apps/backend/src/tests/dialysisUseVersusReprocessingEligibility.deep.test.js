import { randomUUID } from 'node:crypto';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import { placeHoldTx, releaseHoldTx } from '../services/clinical/reprocessableDeviceService.js';
import { assertMarkerFree, createPlan4DialysisFixture, describeWithDatabase, prisma, setTenantTx } from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('dialysis use versus reprocessing eligibility', () => {
  const fixtures = [];
  async function fixture() {
    const value = await createPlan4DialysisFixture();
    fixtures.push(value);
    return value;
  }
  afterEach(async () => {
    for (const value of fixtures) await value.cleanup();
    fixtures.length = 0;
  }, 30000);
  afterAll(async () => { await prisma.$disconnect(); });

  test('freshNoReuseDialyserCanBeCapturedAndStartedWhenNoExposureWorkIsPending', async () => {
    const f = await fixture();
    const population = await setTenantTx(f.tenantId, async tx => {
      const markers = await tx.$queryRawUnsafe(
        `UPDATE patient_bloodborne_markers SET result = 'reactive'
          WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND marker = 'hbsag' RETURNING id`,
        f.tenantId, f.patientUid,
      );
      const outbox = await tx.$queryRawUnsafe('SELECT id FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid', f.tenantId);
      return { markers, outbox };
    });
    expect(population.markers).toHaveLength(1);
    expect(population.outbox).toHaveLength(0);
    const session = await f.schedule();
    const capturing = f.capture(session.id);
    await expect(capturing).resolves.toMatchObject({
      device: { cycle_count: 0, exposure_flag: false }, usage: { reuse_screen: { status: 'restricted' } },
    });
    const captured = await capturing;
    await expect(f.start(session.id, { isolation_override_reason: 'Reviewed isolation routing warning' }))
      .resolves.toMatchObject({ status: 'in_progress' });
    await f.complete(session.id);
    const ended = await f.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    expect(ended.registers).toHaveLength(0);
    const holds = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT * FROM reprocessable_device_holds WHERE tenant_id = $1::uuid AND device_id = $2 AND status = 'active'`,
      f.tenantId, Number(captured.device.id),
    ));
    expect(holds).toHaveLength(1);
    expect(holds[0].hold_type).toBe('bloodborne_exposure');
    const released = await setTenantTx(f.tenantId, tx => releaseHoldTx(tx, {
      tenantId: f.tenantId, holdId: holds[0].id, expectedVersion: ended.devices[0].version,
      actor: f.infectionControlActor, approval: {
        approved_by: f.infectionControlActor.uid, approved_role: f.infectionControlActor.role,
        approved_at: new Date().toISOString(), adjudication: 'Review completed; protocol assessment remains required',
        protocol_id: f.protocol.id, requires_processing: true,
      },
    }));
    await expect(f.record(session.id, { expected_version: released.device.version }))
      .rejects.toMatchObject({ code: 'RPD_DISPOSITION_NOT_ALLOWED',
        details: { verdict: 'ineligible', blocked_code: 'RPD_REUSE_MATRIX_NO_REUSE' } });
    const discarded = await f.record(session.id, { expected_version: released.device.version, status: 'discarded' });
    expect(discarded.device).toMatchObject({ status: 'discarded', cycle_count: 0, exposure_flag: true });
    const events = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      'SELECT id FROM device_processing_events WHERE tenant_id = $1::uuid AND device_id = $2',
      f.tenantId, Number(captured.device.id),
    ));
    expect(events).toHaveLength(0);
    assertMarkerFree(captured);
    assertMarkerFree(discarded);
  });

  test('surveillanceCurrencyDoesNotBlockActualUseButCannotAuthorizeReprocessing', async () => {
    const f = await fixture();
    const changed = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      `UPDATE patient_bloodborne_markers SET tested_on = current_date - 400
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid RETURNING id`, f.tenantId, f.patientUid,
    ));
    expect(changed).toHaveLength(3);
    const session = await f.schedule();
    await expect(f.capture(session.id)).resolves.toMatchObject({ device: { cycle_count: 0 } });
    await expect(f.start(session.id)).resolves.toMatchObject({ status: 'in_progress' });
    await f.complete(session.id);
    const ended = await f.lifecycle(session.id);
    expect(ended.devices).toHaveLength(1);
    const record = await f.record(session.id, { expected_version: ended.devices[0].version });
    expect(record.release.verdict).toBe('not_established');
    expect(record.release.missing_evidence).toContain('RPD_SURVEILLANCE_OVERDUE');
    expect(record.device.status).not.toBe('available');
  });

  test('everyActualUseGateStillRefusesAfterMatrixAndCurrencyMoveToReprocessing', async () => {
    const gates = ['hold', 'dedication', 'pending_exposure', 'readiness', 'residual', 'inactive_machine'];
    expect(gates).toHaveLength(6);
    expect(gates).toEqual(['hold', 'dedication', 'pending_exposure', 'readiness', 'residual', 'inactive_machine']);
    for (const gate of gates) {
      const f = await fixture();
      let processed;
      if (['readiness', 'residual'].includes(gate)) {
        const prior = await f.schedule();
        await f.capture(prior.id);
        await f.start(prior.id);
        await f.complete(prior.id);
        processed = await f.record(prior.id);
      }
      const machineNo = `USE-${randomUUID().slice(0, 12)}`;
      if (gate === 'inactive_machine') await setTenantTx(f.tenantId, tx => tx.$executeRawUnsafe(
        'INSERT INTO dialysis_machines (tenant_id,machine_no,status,created_by) VALUES ($1::uuid,$2,\'active\',$3::uuid)',
        f.tenantId, machineNo, f.actor.uid,
      ));
      const session = await f.schedule(gate === 'inactive_machine' ? { machine_no: machineNo } : {});
      const captured = await f.capture(session.id, processed ? {
        device_tag: processed.device.device_tag, expected_version: processed.device.version,
        pre_use_residual_test: 'negative',
      } : {});
      let code;
      if (gate === 'hold') {
        await setTenantTx(f.tenantId, tx => placeHoldTx(tx, {
          tenantId: f.tenantId, deviceId: captured.device.id, expectedVersion: captured.device.version,
          holdType: 'inspection_failed', reasonCode: 'return_condition_damaged', placedVia: 'manual', placedBy: f.actor.uid,
        }));
        code = 'RPD_HOLD_ACTIVE';
      } else if (gate === 'dedication') {
        await setTenantTx(f.tenantId, tx => tx.$executeRawUnsafe(
          'UPDATE reprocessable_device_dialysis_links SET dedicated_patient_uid=$3::uuid WHERE tenant_id=$1::uuid AND device_id=$2',
          f.tenantId, Number(captured.device.id), f.infectionControlActor.uid,
        ));
        code = 'DIALYSER_DEDICATED_TO_ANOTHER_PATIENT';
      } else if (gate === 'pending_exposure') {
        await setTenantTx(f.tenantId, tx => recordMarkerTx(tx, {
          tenantId: f.tenantId, patientUid: f.patientUid, marker: 'hbsag', result: 'reactive',
          testedOn: f.today, source: 'clinical_declaration', recordedBy: f.infectionControlActor.uid,
        }));
        code = 'RPD_EXPOSURE_RECONCILIATION_PENDING';
      } else if (gate === 'readiness') {
        await setTenantTx(f.tenantId, tx => tx.$executeRawUnsafe(
          `INSERT INTO device_processing_event_revisions
            (tenant_id,processing_event_id,device_id,load_revision,outcome,reason,observed_at,source_load_updated_at)
           VALUES ($1::uuid,$2,$3,1,'invalidated','readiness_invalidated',clock_timestamp(),clock_timestamp())`,
          f.tenantId, Number(processed.processing_event_id), Number(captured.device.id),
        ));
        code = 'RPD_OUTSTANDING_OBLIGATIONS';
      } else if (gate === 'residual') {
        await setTenantTx(f.tenantId, tx => tx.$executeRawUnsafe(
          'UPDATE reprocessable_device_usages SET pre_use_residual_test=NULL WHERE tenant_id=$1::uuid AND id=$2',
          f.tenantId, Number(captured.usage.id),
        ));
        code = 'RPD_RESIDUAL_TEST_REQUIRED';
      } else {
        await setTenantTx(f.tenantId, tx => tx.$executeRawUnsafe(
          'UPDATE dialysis_machines SET status=\'retired\' WHERE tenant_id=$1::uuid AND machine_no=$2',
          f.tenantId, machineNo,
        ));
        code = 'DIALYSIS_MACHINE_INACTIVE';
      }
      const before = await f.lifecycle(session.id);
      await expect(f.start(session.id)).rejects.toMatchObject({ code, statusCode: 409 });
      expect(await f.lifecycle(session.id)).toEqual(before);
      expect(before.session).toMatchObject({ status: 'scheduled', actual_start_at: null });
    }
  }, 30000);

  test('preDeviceReactiveWriterEventRecordsNotApplicableAndAllowsFreshFirstUse', async () => {
    const f = await fixture();
    const marker = await setTenantTx(f.tenantId, tx => recordMarkerTx(tx, {
      tenantId: f.tenantId, patientUid: f.patientUid, marker: 'hbsag', result: 'reactive',
      testedOn: f.today, source: 'clinical_declaration', recordedBy: f.infectionControlActor.uid,
    }));
    const pending = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      'SELECT * FROM bloodborne_exposure_outbox WHERE tenant_id=$1::uuid AND marker_row_id=$2', f.tenantId, Number(marker.id),
    ));
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
    const session = await f.schedule();
    const captured = await f.capture(session.id);
    expect(captured.device).toMatchObject({ cycle_count: 0, exposure_flag: false });
    const applications = await setTenantTx(f.tenantId, tx => tx.$queryRawUnsafe(
      `SELECT result, hold_id, metadata FROM bloodborne_exposure_applications
        WHERE tenant_id=$1::uuid AND outbox_id=$2 AND device_id=$3`,
      f.tenantId, Number(pending[0].id), Number(captured.device.id),
    ));
    expect(applications).toHaveLength(1);
    expect(applications[0]).toEqual({
      result: 'not_applicable_predates_creation', hold_id: null,
      metadata: { event_occurred_at: expect.any(String), device_created_at: expect.any(String) },
    });
    await expect(f.start(session.id, { isolation_override_reason: 'Reviewed isolation routing warning' }))
      .resolves.toMatchObject({ status: 'in_progress' });
    const after = await f.lifecycle(session.id);
    expect(after.usages).toHaveLength(1);
    expect(after.devices).toHaveLength(1);
    expect(after.devices[0]).toMatchObject({ cycle_count: 0, exposure_flag: false });
  });
});
