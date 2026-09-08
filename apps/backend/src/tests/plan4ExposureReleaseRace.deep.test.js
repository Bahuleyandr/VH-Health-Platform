import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { recordMarkerTx } from '../services/clinical/bloodborneMarkerService.js';
import { applyPlatformExposureTx } from '../services/clinical/platformReprocessableExposureHandler.js';
import {
  admitActualUseTx,
  placeHoldTx,
  registerDeviceTx,
  releaseHoldTx,
  releaseToAvailableTx,
  reserveDeviceTx,
  returnDeviceTx,
} from '../services/clinical/reprocessableDeviceService.js';
import {
  createPlan4DialysisFixture, describeWithDatabase, prisma, setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const ORDERS = ['exposure_first', 'processing_first'];
const ITERATIONS = Array.from({ length: 20 }, (_, index) => index);

async function prepareHeldDevice(fixture, label) {
  return setTenantTx(fixture.tenantId, async (tx) => {
    const patientUid = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Plan 4 exposure race patient', 'PATIENT', TRUE, 'active', NOW())`,
      patientUid, fixture.tenantId,
      `+91${BigInt(`0x${patientUid.replaceAll('-', '').slice(0, 12)}`).toString().padStart(10, '0').slice(-10)}`,
    );
    const patients = await tx.$queryRawUnsafe(
      `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
       VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`, fixture.tenantId, patientUid,
    );
    expect(patients).toHaveLength(1);
    const sessions = await tx.$queryRawUnsafe(
      `INSERT INTO dialysis_sessions (tenant_id, dialysis_patient_id, modality)
       VALUES ($1::uuid, $2::int, 'hd') RETURNING id`, fixture.tenantId, patients[0].id,
    );
    expect(sessions).toHaveLength(1);
    const device = await registerDeviceTx(tx, {
      tenantId: fixture.tenantId, actor: fixture.actor,
      input: {
        domain: 'dialysis', category: 'dialyser', manufacturer: fixture.manufacturer,
        model_name: fixture.modelName, manufacturer_serial: `${label}-${randomUUID()}`,
        protocol_device_scope_id: fixture.scope.id, enrolled_via: 'session_capture',
      },
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO reprocessable_device_dialysis_links
         (tenant_id, device_id, dedicated_patient_uid, dedicated_by)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid)`,
      fixture.tenantId, device.id, patientUid, fixture.actor.uid,
    );
    const captured = await reserveDeviceTx(tx, {
      tenantId: fixture.tenantId, deviceId: device.id, expectedVersion: device.version,
      patientUid, owner: { dialysis_session_id: sessions[0].id }, captureSource: 'staff_app',
      preUseResidualTest: 'negative', actor: fixture.actor,
    });
    const admitted = await admitActualUseTx(tx, {
      tenantId: fixture.tenantId, deviceId: device.id,
      expectedVersion: captured.device.version, actor: fixture.actor,
    });
    const returned = await returnDeviceTx(tx, {
      tenantId: fixture.tenantId, deviceId: device.id,
      expectedVersion: admitted.device.version, actor: fixture.actor,
      disposition: 'sent_for_reprocessing',
    });
    const held = await placeHoldTx(tx, {
      tenantId: fixture.tenantId, deviceId: device.id, expectedVersion: returned.device.version,
      holdType: 'bloodborne_exposure', reasonCode: 'exposure_at_return', placedVia: 'return',
      placedBy: fixture.infectionControlActor.uid, sourceUsageId: returned.usage.id,
    });
    expect(held.device.version).toBe(4);
    return { patientUid, device: held.device, hold: held.hold, usage: returned.usage };
  });
}

async function applyExposure(tx, fixture, subject) {
  const marker = await recordMarkerTx(tx, {
    tenantId: fixture.tenantId, patientUid: subject.patientUid,
    marker: 'hbsag', result: 'reactive', testedOn: fixture.today,
    source: 'clinical_declaration', recordedBy: fixture.infectionControlActor.uid,
  });
  const outbox = await tx.$queryRawUnsafe(
    `SELECT id FROM bloodborne_exposure_outbox
      WHERE tenant_id = $1::uuid AND marker_row_id = $2::int`, fixture.tenantId, marker.id,
  );
  expect(outbox).toHaveLength(1);
  const applications = await applyPlatformExposureTx(tx, {
    tenantId: fixture.tenantId, patientUid: subject.patientUid,
    marker: 'hbsag', testedOn: fixture.today, markerRowId: marker.id,
  }, { outboxId: outbox[0].id });
  expect(applications).toHaveLength(1);
  return { outboxId: outbox[0].id, applications };
}

async function releaseAndProcess(tx, fixture, subject) {
  const released = await releaseHoldTx(tx, {
    tenantId: fixture.tenantId, holdId: subject.hold.id,
    expectedVersion: subject.device.version, actor: fixture.infectionControlActor,
    approval: {
      approved_by: fixture.infectionControlActor.uid,
      approved_role: fixture.infectionControlActor.role, approved_at: new Date().toISOString(),
      adjudication: 'Authorised new processing after review',
      protocol_id: fixture.protocol.id, requires_processing: true,
    },
  });
  return releaseToAvailableTx(tx, {
    tenantId: fixture.tenantId, deviceId: subject.device.id,
    expectedVersion: released.device.version, actor: fixture.actor,
    protocol: fixture.protocol, scope: fixture.scope,
    // This kernel race supplies the decision input; resolver policy is tested separately.
    eligibility: { verdict: 'eligible', reason_codes: [] },
    evidence: {
      baseline_tcv_ml: 100, baseline_tcv_source: 'pre_use', measured_tcv_ml: 90,
      integrity_test_result: 'pass', reprocessing_agent: 'peracetic_acid',
      disinfectant_concentration_pct: 0.3, disinfectant_contact_minutes: 12,
    },
    occurrence: {
      kind: 'chemical_reprocessing', protocol_id: fixture.protocol.id, cycle_type: 'chemical',
      recorded_via: 'dialysis_record', device_usage_id: subject.usage.id,
    },
  });
}

async function runBarrierRace(connections, fixture, subject, order) {
  let unblockFirst;
  let firstLocked;
  let secondLockStarted;
  const locked = new Promise((resolve) => { firstLocked = resolve; });
  const started = new Promise((resolve) => { secondLockStarted = resolve; });
  const release = new Promise((resolve) => { unblockFirst = resolve; });
  const operations = order === 'exposure_first'
    ? [applyExposure, releaseAndProcess] : [releaseAndProcess, applyExposure];
  expect(operations).toHaveLength(2);
  const commands = connections.map((client, index) => async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SET LOCAL lock_timeout = '5s'");
    let intercepted = false;
    const tx = {
      $queryRawUnsafe: async (sql, ...values) => {
        const deviceLock = !intercepted
          && sql.includes('FROM reprocessable_devices') && sql.includes('FOR UPDATE');
        if (deviceLock) {
          intercepted = true;
          if (index === 1) secondLockStarted();
        }
        const result = await client.query(sql, values);
        if (deviceLock && index === 0) { firstLocked(); await release; }
        return result.rows;
      },
      $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
    };
    try {
      const result = await operations[index](tx, fixture, subject);
      await client.query('COMMIT');
      return { status: 'fulfilled', value: result };
    } catch (error) {
      await client.query('ROLLBACK');
      return { status: 'rejected', code: error.code, message: error.message };
    }
  });
  const pending = [];
  try {
    pending.push(commands[0]());
    await Promise.race([locked, pending[0].then((result) => {
      throw new Error(`First command exited before lock barrier: ${JSON.stringify(result)}`);
    })]);
    pending.push(commands[1]());
    await Promise.race([started, pending[1].then((result) => {
      throw new Error(`Second command exited before lock barrier: ${JSON.stringify(result)}`);
    })]);
    const deadline = Date.now() + 3000;
    let lockObserved = false;
    while (Date.now() < deadline) {
      const waiting = await connections[0].query(
        `SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked_by_first`,
        [connections[0].processID, connections[1].processID],
      );
      expect(waiting.rows).toHaveLength(1);
      if (waiting.rows[0].blocked_by_first) { lockObserved = true; break; }
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    expect(lockObserved).toBe(true);
  } finally {
    unblockFirst();
    await Promise.all(pending);
  }
  const outcomes = await Promise.all(pending);
  expect(outcomes).toHaveLength(2);
  return order === 'exposure_first'
    ? { exposure: outcomes[0], processing: outcomes[1] }
    : { exposure: outcomes[1], processing: outcomes[0] };
}

async function assertPersistedRace(fixture, subject, order, outcomes) {
  const processed = order === 'processing_first';
  expect(outcomes.exposure.status).toBe('fulfilled');
  if (processed) {
    expect(outcomes.processing.status).toBe('fulfilled');
    expect(outcomes.processing.value.criteria).toEqual({ verdict: 'released', missing_evidence: [] });
    expect(outcomes.processing.value.device.status).toBe('available');
  } else {
    expect(outcomes.processing).toMatchObject({ status: 'rejected', code: 'RPD_VERSION_CONFLICT' });
  }
  const devices = await prisma.$queryRawUnsafe(
    `SELECT id, version, status, exposure_flag, cycle_count FROM reprocessable_devices
      WHERE tenant_id = $1::uuid AND id = $2::bigint`, fixture.tenantId, subject.device.id,
  );
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({
    status: 'quarantined', exposure_flag: true, cycle_count: processed ? 1 : 0,
    version: subject.device.version + (processed ? 3 : 1),
  });
  const holds = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM reprocessable_device_holds
      WHERE tenant_id = $1::uuid AND device_id = $2::bigint ORDER BY id`,
    fixture.tenantId, subject.device.id,
  );
  expect(holds).toHaveLength(processed ? 2 : 1);
  expect(holds.map((hold) => hold.status)).toEqual(processed ? ['satisfied', 'active'] : ['active']);
  expect(holds[0].id).toBe(subject.hold.id);
  const applications = await prisma.$queryRawUnsafe(
    `SELECT hold_id, result FROM bloodborne_exposure_applications
      WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint AND device_id = $3::bigint`,
    fixture.tenantId, outcomes.exposure.value.outboxId, subject.device.id,
  );
  expect(applications).toHaveLength(1);
  expect(applications[0]).toEqual({
    hold_id: holds.at(-1).id, result: processed ? 'hold_created' : 'hold_associated',
  });
  const events = await prisma.$queryRawUnsafe(
    `SELECT e.id, e.cycle_before, e.cycle_after, e.device_version_before, e.device_version_after,
            (e.metadata->>'occurred_at')::timestamptz >= u.returned_at AS after_return,
            (e.metadata->>'occurred_at')::timestamptz > h.released_at AS after_authorization,
            u.post_use_processing_event_id = e.id AS linked_to_use
       FROM device_processing_events e
       JOIN reprocessable_device_usages u ON u.tenant_id = e.tenant_id
         AND u.device_id = e.device_id AND u.id = $3::bigint
       JOIN reprocessable_device_holds h ON h.tenant_id = e.tenant_id AND h.id = $4::bigint
      WHERE e.tenant_id = $1::uuid AND e.device_id = $2::bigint ORDER BY e.id`,
    fixture.tenantId, subject.device.id, subject.usage.id, subject.hold.id,
  );
  expect(events).toHaveLength(processed ? 1 : 0);
  if (processed) {
    expect(events[0]).toMatchObject({
      cycle_before: 0, cycle_after: 1, device_version_before: 5, device_version_after: 6,
      after_return: true, after_authorization: true, linked_to_use: true,
    });
  }
  const satisfactions = await prisma.$queryRawUnsafe(
    `SELECT hold_id, processing_event_id, required_protocol_id FROM reprocessable_hold_satisfactions
      WHERE tenant_id = $1::uuid AND device_id = $2::bigint`, fixture.tenantId, subject.device.id,
  );
  expect(satisfactions).toHaveLength(processed ? 1 : 0);
  if (processed) {
    expect(satisfactions[0]).toEqual({ hold_id: subject.hold.id,
      processing_event_id: events[0].id, required_protocol_id: fixture.protocol.id });
  }
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT o.action, o.version_before, o.version_after, a.id AS audit_id
       FROM reprocessable_device_operations o
       LEFT JOIN audit_logs a ON a.tenant_id = o.tenant_id AND a.id = o.audit_id
      WHERE o.tenant_id = $1::uuid AND o.device_id = $2::bigint ORDER BY o.version_after`,
    fixture.tenantId, subject.device.id,
  );
  expect(receipts).toHaveLength(processed ? 8 : 6);
  expect(receipts.map((row) => row.version_after)).toEqual(
    Array.from({ length: devices[0].version + 1 }, (_, version) => version),
  );
  expect(receipts.map((row) => row.action)).toEqual([
    'register', 'reserve', 'admit_actual_use', 'return', 'place_hold',
    ...(processed ? ['release_hold', 'record_processing'] : []), 'place_hold',
  ]);
  for (const receipt of receipts) {
    expect(Number(receipt.audit_id)).toBeGreaterThan(0);
    expect(receipt.version_before).toBe(Math.max(0, receipt.version_after - 1));
  }
}

describeWithDatabase('Plan 4 exposure versus authorised release and processing', () => {
  test('twentyBarrierRacesPerOrderNeverReleaseAcrossExposureOrDoubleCountProcessing', async () => {
    expect(ORDERS).toHaveLength(2);
    expect(ORDERS).toEqual(['exposure_first', 'processing_first']);
    expect(ITERATIONS).toHaveLength(20);
    const connections = [new Client({ connectionString: databaseUrl }), new Client({ connectionString: databaseUrl })];
    expect(connections).toHaveLength(2);
    const fixture = await createPlan4DialysisFixture();
    await Promise.all(connections.map((client) => client.connect()));
    try {
      for (const order of ORDERS) {
        for (const iteration of ITERATIONS) {
          const subject = await prepareHeldDevice(fixture, `${order}-${iteration}`);
          const outcomes = await runBarrierRace(connections, fixture, subject, order);
          await assertPersistedRace(fixture, subject, order, outcomes);
        }
      }
      const devices = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM reprocessable_devices WHERE tenant_id = $1::uuid`, fixture.tenantId,
      );
      expect(devices).toHaveLength(40);
      expect(devices.every((device) => device.status === 'quarantined')).toBe(true);
    } finally {
      await Promise.all(connections.map((client) => client.end()));
      await fixture.cleanup();
    }
  }, 120000);
});
