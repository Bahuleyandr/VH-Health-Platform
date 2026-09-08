import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('Plan 4 dialysis database boundaries', () => {
  const client = new Client({ connectionString: databaseUrl });
  let tenantId;
  let actorUid;
  let protocolId;
  let scopeId;
  let device;

  beforeAll(() => client.connect());
  afterAll(() => client.end());
  beforeEach(async () => {
    await client.query('BEGIN');
    tenantId = randomUUID();
    actorUid = randomUUID();
    await client.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Plan 4 schema guard')",
      [tenantId, randomUUID()]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, updated_at)
       VALUES ($1, $2, $3, 'Plan 4 schema actor', 'CONSULTANT', NOW())`,
      [actorUid, tenantId, randomUUID().slice(0, 14)],
    );
    protocolId = (await client.query(
      `INSERT INTO reprocessing_protocols
         (tenant_id, protocol_key, revision, domain, category, name, basis, reference,
          approved_by, approved_role, approved_at, created_by, reuse_matrix)
       VALUES ($1, $2, 1, 'dialysis', 'dialyser', 'Schema guard', 'manufacturer_ifu', 'SCHEMA-IFU',
               $3, 'CONSULTANT', NOW(), $3,
               '{"hbsag":"no_reuse","hcv":"no_reuse","hiv":"no_reuse","isolation_mixed":"no_reuse"}')
       RETURNING id`, [tenantId, randomUUID(), actorUid],
    )).rows[0].id;
    scopeId = (await client.query(
      `INSERT INTO reprocessing_protocol_device_scopes
         (tenant_id, protocol_id, category, manufacturer, model_name, ifu_reference, approved_at, created_by)
       VALUES ($1, $2, 'dialyser', 'Schema maker', 'Schema model', 'SCHEMA-IFU', NOW(), $3)
       RETURNING id`, [tenantId, protocolId, actorUid],
    )).rows[0].id;
    device = await insertDevice();
  });
  afterEach(() => client.query('ROLLBACK'));

  async function insertDevice(cycleCount = 1, maxCycles = 1) {
    return (await client.query(
      `INSERT INTO reprocessable_devices
         (tenant_id, domain, category, manufacturer, model_name, manufacturer_serial,
          protocol_device_scope_id, enrolled_via, cycle_count, max_cycles_snapshot, status, created_by)
       VALUES ($1, 'dialysis', 'dialyser', 'Schema maker', 'Schema model', $2,
               $3, 'session_capture', $4, $5, 'awaiting_reprocessing', $6)
       RETURNING id, cycle_count, version`, [tenantId, randomUUID(), scopeId, cycleCount, maxCycles, actorUid],
    )).rows[0];
  }

  async function insertEvent({ target = device, overCeiling = true, mode = 'performed',
    cycleBefore = target.cycle_count, cycleAfter = target.cycle_count + 1,
    versionBefore = target.version, versionAfter = target.version + 1, countsCycle = true } = {}) {
    return (await client.query(
      `INSERT INTO device_processing_events
         (tenant_id, domain, device_id, kind, protocol_id, cycle_type, initial_outcome,
          cycle_before, cycle_after, device_version_before, device_version_after,
          recorded_by, recorded_via, over_ceiling, counts_cycle, metadata)
       VALUES ($1, 'dialysis', $2, 'chemical_reprocessing', $3, 'chemical', 'passed',
               $4, $5, $6, $7, $8, 'dialysis_record', $9, $10, $11::jsonb)
       RETURNING id, over_ceiling`, [tenantId, target.id, protocolId, cycleBefore, cycleAfter,
        versionBefore, versionAfter, actorUid, overCeiling, countsCycle, JSON.stringify({ recording_mode: mode })],
    )).rows[0];
  }

  async function refusal(action, constraint) {
    await client.query('SAVEPOINT refused_schema_change');
    try {
      await expect(action()).rejects.toMatchObject({ code: '23514', constraint });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT refused_schema_change');
      await client.query('RELEASE SAVEPOINT refused_schema_change');
    }
  }

  test('aboveCeilingCountersRequireExactPerformedEventWithPositiveControl', async () => {
    const count = await client.query('SELECT COUNT(*)::int AS n FROM reprocessable_devices WHERE tenant_id = $1', [tenantId]);
    expect(count.rows).toHaveLength(1);
    expect(count.rows[0].n).toBe(1);
    await refusal(() => insertDevice(2), 'plan4_processing_ceiling_device_check');
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET cycle_count = 2, version = 1 WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id],
    ), 'plan4_processing_ceiling_device_check');
    const event = await insertEvent();
    expect(event.over_ceiling).toBe(true);
    const updated = await client.query(
      `UPDATE reprocessable_devices SET cycle_count = 2, version = 1
        WHERE tenant_id = $1 AND id = $2
        RETURNING cycle_count, version, status, last_processing_event_id`, [tenantId, device.id],
    );
    expect(updated.rows).toHaveLength(1);
    expect(updated.rows[0]).toEqual({ cycle_count: 2, version: 1,
      status: 'awaiting_reprocessing', last_processing_event_id: null });
    await refusal(() => client.query(
      "UPDATE reprocessable_devices SET status = 'available' WHERE tenant_id = $1 AND id = $2",
      [tenantId, device.id],
    ), 'reprocessable_devices_available_cycle_ceiling_check');
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET cycle_count = 3, version = 2 WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id],
    ), 'plan4_processing_ceiling_device_check');
  });

  test('aboveCeilingEventCannotBeUnmarkedProspectiveOrMisbound', async () => {
    const mutations = [
      { overCeiling: false }, { mode: 'prospective' }, { cycleBefore: 0 },
      { cycleAfter: 3 }, { versionBefore: 1 }, { versionAfter: 2 }, { countsCycle: false },
    ];
    expect(mutations).toHaveLength(7);
    for (const mutation of mutations) {
      await refusal(() => insertEvent(mutation), 'plan4_processing_ceiling_event_check');
    }
    const sibling = await insertDevice();
    const siblingEvent = await insertEvent({ target: sibling });
    expect(siblingEvent.over_ceiling).toBe(true);
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET cycle_count = 2, version = 1 WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id],
    ), 'plan4_processing_ceiling_device_check');
    expect((await insertEvent()).over_ceiling).toBe(true);
  });

  test('ceilingChangesCannotManufactureAboveCeilingHistoryAndUnlimitedIsPreserved', async () => {
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET max_cycles_snapshot = NULL WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id],
    ), 'plan4_processing_ceiling_device_check');
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET max_cycles_snapshot = NULL, cycle_count = 8 WHERE tenant_id = $1 AND id = $2',
      [tenantId, device.id],
    ), 'plan4_processing_ceiling_device_check');
    const unlimited = await insertDevice(4, null);
    expect(unlimited.cycle_count).toBe(4);
    await refusal(() => client.query(
      'UPDATE reprocessable_devices SET max_cycles_snapshot = 3 WHERE tenant_id = $1 AND id = $2',
      [tenantId, unlimited.id],
    ), 'plan4_processing_ceiling_device_check');
    const positive = await client.query(
      "UPDATE reprocessable_devices SET status = 'available' WHERE tenant_id = $1 AND id = $2 RETURNING status",
      [tenantId, unlimited.id],
    );
    expect(positive.rows).toEqual([{ status: 'available' }]);
  });

  test('emergencyBindingRevisionsAdvanceDespiteForgedClientRevision', async () => {
    await client.query(
      `INSERT INTO dialysis_machines (tenant_id, machine_no, created_by)
       VALUES ($1, 'SCHEMA-MACHINE', $2)`, [tenantId, actorUid],
    );
    await client.query(
      `INSERT INTO reprocessing_domain_settings (tenant_id, domain, reactive_patient_rule)
       VALUES ($1, 'dialysis', 'quarantine')`, [tenantId],
    );
    await client.query(
      `INSERT INTO reprocessing_domain_policies (tenant_id, domain, category)
       VALUES ($1, 'dialysis', 'dialyser')`, [tenantId],
    );
    const relations = ['dialysis_machines', 'reprocessing_domain_settings', 'reprocessing_domain_policies'];
    expect(relations).toHaveLength(3);
    for (const relation of relations) {
      expect((await client.query(`SELECT revision::text FROM ${relation} WHERE tenant_id = $1`, [tenantId])).rows)
        .toEqual([{ revision: '1' }]);
      expect((await client.query(
        `UPDATE ${relation} SET revision = 700 WHERE tenant_id = $1 RETURNING revision::text`, [tenantId],
      )).rows).toEqual([{ revision: '2' }]);
      expect((await client.query(
        `UPDATE ${relation} SET revision = 1 WHERE tenant_id = $1 RETURNING revision::text`, [tenantId],
      )).rows).toEqual([{ revision: '3' }]);
    }
  });

  test('emergencyPatientForeignKeyIsDeferrableInitiallyImmediateAndKeepsTenantBinding', async () => {
    const rows = (await client.query(
      `SELECT pc.condeferrable,pc.condeferred,pc.confdeltype::text,
              parent.relname AS parent_table,
              ARRAY(SELECT attribute.attname::text FROM unnest(pc.conkey) WITH ORDINALITY key(attnum,position)
                JOIN pg_attribute attribute ON attribute.attrelid=pc.conrelid AND attribute.attnum=key.attnum
                ORDER BY key.position) AS child_columns,
              ARRAY(SELECT attribute.attname::text FROM unnest(pc.confkey) WITH ORDINALITY key(attnum,position)
                JOIN pg_attribute attribute ON attribute.attrelid=pc.confrelid AND attribute.attnum=key.attnum
                ORDER BY key.position) AS parent_columns
         FROM pg_constraint pc JOIN pg_class parent ON parent.oid=pc.confrelid
        WHERE pc.conrelid='public.dialysis_isolation_emergency_authorizations'::regclass
          AND pc.conname='fk_dialysis_emergency_patient' AND pc.contype='f'`,
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      condeferrable: true, condeferred: false, confdeltype: 'r', parent_table: 'users',
      child_columns: ['tenant_id', 'patient_uid'], parent_columns: ['tenant_id', 'uid'],
    });
  });

  test('dialysisSafetyMigrationPinsPrivateBindingAndNullStatutorySchema', async () => {
    const columns = (await client.query(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND (
          table_name = 'dialysis_isolation_emergency_authorizations'
          OR (table_name = 'device_processing_events' AND column_name = 'over_ceiling')
          OR (table_name = 'dialyser_reprocessing_attempts' AND column_name = 'dialyzer_reuse_register_id'))
        ORDER BY table_name, column_name`,
    )).rows;
    expect(columns).toHaveLength(25);
    const privateColumns = columns.filter((column) => column.table_name === 'dialysis_isolation_emergency_authorizations');
    expect(privateColumns.map(({ column_name: name }) => name)).toEqual([
      'applied_by', 'applied_role', 'bound_session_id', 'consultant_approved_at', 'consultant_approved_by',
      'consultant_approved_role', 'consumed_at', 'consumed_by', 'created_at', 'decision_fingerprint', 'expires_at',
      'id', 'isolation_revision_id', 'machine_id', 'machine_revision', 'patient_uid', 'policy_revision',
      'protocol_id', 'purpose', 'reason', 'scheduled_for', 'settings_revision', 'tenant_id',
    ]);
    expect(columns.find((column) => column.column_name === 'over_ceiling'))
      .toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(columns.find((column) => column.column_name === 'dialyzer_reuse_register_id'))
      .toMatchObject({ data_type: 'bigint', is_nullable: 'YES' });
    const indexes = (await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND indexname = 'ux_dialyser_reprocessing_attempts_unused_number'`,
    )).rows;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toBe('CREATE UNIQUE INDEX ux_dialyser_reprocessing_attempts_unused_number ON public.dialyser_reprocessing_attempts USING btree (tenant_id, device_usage_id, attempt_no) WHERE (dialyzer_reuse_register_id IS NULL)');
    const foreignKeys = (await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.dialysis_isolation_emergency_authorizations'::regclass
          AND contype = 'f' ORDER BY conname`,
    )).rows.map((row) => row.conname);
    expect(foreignKeys).toHaveLength(9);
    expect(foreignKeys).toEqual([
      'dialysis_isolation_emergency_authorizations_tenant_id_fkey', 'fk_dialysis_emergency_applicator',
      'fk_dialysis_emergency_consultant', 'fk_dialysis_emergency_consumer', 'fk_dialysis_emergency_isolation_revision',
      'fk_dialysis_emergency_machine', 'fk_dialysis_emergency_patient', 'fk_dialysis_emergency_protocol',
      'fk_dialysis_emergency_session',
    ]);
  });
});
