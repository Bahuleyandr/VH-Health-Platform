import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import {
  placeHoldTx,
  registerDeviceTx,
  releaseHoldTx,
} from '../services/clinical/reprocessableDeviceService.js';
import {
  createProtocolDeviceScopeTx,
  createProtocolRevisionTx,
} from '../services/clinical/reprocessingProtocolService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('reprocessable device decision and lifecycle kernel', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const tx = {
    $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Plan 4 kernel')`,
      [tenantId, `plan4-kernel-${randomUUID()}`],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('persists immutable protocol and scope then enforces hold release without readiness', async () => {
    const protocol = await createProtocolRevisionTx(tx, {
      tenantId,
      input: {
        protocol_key: randomUUID(),
        domain: 'dialysis',
        category: 'dialyser',
        name: 'Plan 4 kernel protocol',
        basis: 'manufacturer_ifu',
        reference: 'IFU-PLAN4-KERNEL',
        approved_by: actorId,
        approved_role: 'INFECTION_CONTROL_OFFICER',
        approved_at: '2026-09-07T10:00:00.000Z',
        status: 'active',
        tcv_min_pct: 80,
        baseline_tcv_required: true,
        mid_life_enrolment_rule: 'refuse',
        residual_test_required: true,
        integrity_test_required: true,
        agents: [{
          agent: 'peracetic_acid', min_concentration_pct: 0.2,
          max_concentration_pct: 0.4, min_contact_minutes: 11,
        }],
        reuse_matrix: {
          hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse',
        },
        surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
        surveillance_overdue_blocks_reuse: true,
        prion_rule: 'discard',
        created_by: actorId,
      },
    });
    const scope = await createProtocolDeviceScopeTx(tx, {
      tenantId,
      protocolId: protocol.id,
      input: {
        category: 'dialyser', manufacturer: 'Plan 4', model_name: 'Kernel',
        ifu_reference: 'IFU-PLAN4-KERNEL', nominal_tcv_ml: 100,
        single_use: false, approved_at: '2026-09-07T10:00:00.000Z', created_by: actorId,
      },
    });
    const device = await registerDeviceTx(tx, {
      tenantId,
      input: {
        domain: 'dialysis', category: 'dialyser', manufacturer: 'Plan 4',
        model_name: 'Kernel', manufacturer_serial: `SER-${randomUUID()}`,
        protocol_device_scope_id: scope.id, enrolled_via: 'console',
        max_cycles_snapshot: 3,
      },
      actor: { uid: actorId },
    });
    const held = await placeHoldTx(tx, {
      tenantId,
      deviceId: device.id,
      holdType: 'sterilization_failed',
      reasonCode: 'load_failed',
      placedVia: 'manual',
      placedBy: actorId,
      expectedVersion: device.version,
    });
    expect(held.device).toMatchObject({ status: 'quarantined', version: 1 });

    const released = await releaseHoldTx(tx, {
      tenantId,
      holdId: held.hold.id,
      expectedVersion: held.device.version,
      actor: { uid: actorId, role: 'QUALITY_OFFICER' },
      approval: {
        approved_by: actorId,
        approved_role: 'QUALITY_OFFICER',
        approved_at: '2026-09-07T10:05:00.000Z',
        adjudication: 'Release requires a new complete processing occurrence',
        protocol_id: protocol.id,
        requires_processing: true,
      },
    });
    expect(released.hold.status).toBe('released');
    expect(released.device.status).toBe('awaiting_reprocessing');

    const receiptCount = await client.query(
      `SELECT count(*)::int AS count FROM reprocessable_device_operations
        WHERE tenant_id = $1::uuid AND device_id = $2`,
      [tenantId, device.id],
    );
    expect(receiptCount.rows[0].count).toBe(3);
  });
});
