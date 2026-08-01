import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function migrationOwnerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (
    url.hostname === '127.0.0.1'
    && url.port === '55432'
    && url.username === 'qa_writer'
  ) {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_c6_1_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c6_1_failure');
  await client.query('RELEASE SAVEPOINT expected_c6_1_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 603 external recovery substrate', () => {
  const client = new Client({
    connectionString: migrationOwnerDatabaseUrl(databaseUrl),
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let facilityId;
  let otherFacilityId;
  let offsetId;
  let pathwayOffsetId;
  const patientUid = randomUUID();
  const otherPatientUid = randomUUID();
  let i09InboxId;
  let otherI09InboxId;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES
         ($1::uuid, $3::text, 'C6.1 migration tenant'),
         ($2::uuid, $4::text, 'C6.1 other tenant')`,
      [
        tenantId,
        otherTenantId,
        `c61-migration-${suffix}`,
        `c61-migration-other-${suffix}`,
      ],
    );
    const facilities = await client.query(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, timezone)
       VALUES
         ($1::uuid, $3::text, 'C6.1 facility', 'Asia/Kolkata'),
         ($2::uuid, $4::text, 'C6.1 other facility', 'Asia/Kolkata')
       RETURNING tenant_id::text, id`,
      [tenantId, otherTenantId, `C61-${suffix}`, `C61-O-${suffix}`],
    );
    facilityId = Number(
      facilities.rows.find((row) => row.tenant_id === tenantId).id,
    );
    otherFacilityId = Number(
      facilities.rows.find((row) => row.tenant_id === otherTenantId).id,
    );
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $5::text, 'C6.1 recovery patient', 'PATIENT', true, NOW()),
         ($2::uuid, $4::uuid, $6::text, 'C6.1 other patient', 'PATIENT', true, NOW())`,
      [
        patientUid,
        otherPatientUid,
        tenantId,
        otherTenantId,
        `91${suffix.slice(0, 10)}`,
        `92${suffix.slice(0, 10)}`,
      ],
    );
    const valid = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, recovery_state,
          policy_version, policy_signature, retention_policy, retention_until,
          historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'facility', $2::integer, 'I10',
          'inbound', $3::text, 'external:I10', 1,
          'monotonic_position_and_predecessor', 10, 'token-10', 'paused',
          'c-d8-v1', 'synthetic-signature', 'retain-730d',
          NOW() + INTERVAL '730 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, facilityId, `facility:${facilityId}:unit:test:sensor:test`],
    );
    offsetId = valid.rows[0].offset_id;
    const pathway = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, consumer_key, generation, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES ('pathway_registry', $1::text, 1, 0, 0)
       RETURNING offset_id::text`,
      [`c61-migration-pathway-${suffix}`],
    );
    pathwayOffsetId = pathway.rows[0].offset_id;
    for (const [rowTenantId, partition, assign] of [
      [tenantId, `i09/gateway/41/device/42/${suffix}`, (value) => { i09InboxId = value; }],
      [otherTenantId, `i09/gateway/51/device/52/${suffix}`, (value) => { otherI09InboxId = value; }],
    ]) {
      const tenantOffset = await client.query(
        `INSERT INTO event_consumer_offsets
           (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
            direction, source_partition, consumer_key, generation, cursor_kind,
            high_water_position, high_water_token, recovery_state,
            policy_version, policy_signature, retention_policy, retention_until,
            historical_cutoff_event_id, backfill_cursor_event_id)
         VALUES
           ('external_interface', $1::uuid, 'tenant', NULL, 'I09', 'inbound',
            $2::text, 'external:I09', 1, 'monotonic_position_and_predecessor',
            10, 'token-10', 'paused', 'c-d8-v1', 'synthetic-signature',
            'retain-730d', NOW() + INTERVAL '730 days', NULL, NULL)
         RETURNING offset_id::text`,
        [rowTenantId, partition],
      );
      const tenantInbox = await client.query(
        `INSERT INTO pathway_projector_inbox
           (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
            interface_family, direction, source_partition, source_position,
            source_token, predecessor_token, duplicate_key, command_fingerprint,
            occurred_at, received_at, recorded_at, arrival_class,
            effect_disposition, status, next_attempt_at, policy_version,
            policy_signature, retention_policy, retention_until)
         VALUES
           ('external_interface', $1::uuid, 'external:I09', 1, $2::uuid, NULL,
            'I09', 'inbound', $3::text, 11, 'token-11', 'token-10', $4::text,
            repeat('a', 64), NOW(), NOW(), NOW(), 'recovery_backlog',
            'late_pending_only', 'pending', NOW(), 'c-d8-v1',
            'synthetic-signature', 'retain-730d', NOW() + INTERVAL '730 days')
         RETURNING inbox_id::text`,
        [rowTenantId, tenantOffset.rows[0].offset_id, partition, `i09-${rowTenantId}`],
      );
      assign(tenantInbox.rows[0].inbox_id);
    }
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  it('installs and validates the named database row-type discriminator', async () => {
    const result = await client.query(
      `SELECT conrelid::regclass::text AS relation_name, convalidated
         FROM pg_constraint
        WHERE (
          conrelid = 'public.event_consumer_offsets'::regclass
          AND conname = 'chk_event_consumer_offsets_row_shape'
        ) OR (
          conrelid = 'public.pathway_projector_inbox'::regclass
          AND conname = 'chk_pathway_projector_inbox_row_shape'
        )
        ORDER BY relation_name`,
    );
    expect(result.rows).toEqual([
      { relation_name: 'event_consumer_offsets', convalidated: true },
      { relation_name: 'pathway_projector_inbox', convalidated: true },
    ]);
  });

  it.each([
    ['null tenant', null, 'facility', true, null],
    ['default tenant', DEFAULT_TENANT_ID, 'facility', true, null],
    ['facility scope without facility', tenantId, 'facility', false, null],
    ['tenant scope with facility', tenantId, 'tenant', true, null],
    ['external row with pathway fields', tenantId, 'facility', true, 7],
  ])('direct SQL rejects %s with SQLSTATE 23514', async (
    _label,
    rowTenantId,
    facilityScope,
    includeFacility,
    historicalCutoff,
  ) => {
    const failure = await expectFailure(client, () => client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          recovery_state, policy_version, policy_signature, retention_policy,
          retention_until, historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, $2::text, $3::integer, 'I10',
          'inbound', $4::text, 'external:I10', 2,
          'monotonic_position_and_predecessor', 'paused', 'c-d8-v1',
          'synthetic-signature', 'retain-730d', NOW() + INTERVAL '730 days',
          $5::bigint, NULL)`,
      [
        rowTenantId,
        facilityScope,
        includeFacility ? facilityId : null,
        `invalid-${suffix}-${_label}`,
        historicalCutoff,
      ],
    ), {
      code: '23514',
      constraint: 'chk_event_consumer_offsets_row_shape',
    });
    expect(failure.constraint).toBe('chk_event_consumer_offsets_row_shape');
  });

  it('direct SQL rejects a control-plane row carrying external fields', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, consumer_key, generation, historical_cutoff_event_id,
          backfill_cursor_event_id, interface_family)
       VALUES ('pathway_registry', $1::text, 1, 0, 0, 'I10')`,
      [`invalid-pathway-${suffix}`],
    ), {
      code: '23514',
      constraint: 'chk_event_consumer_offsets_row_shape',
    });
  });

  it.each([
    ['pathway row carrying external identity', false, `
      INSERT INTO pathway_projector_inbox
        (scope_kind, tenant_id, consumer_key, generation, event_id,
         interface_family)
      VALUES
        ('pathway_registry', $1::uuid, $2::text, 1, NULL, 'I10')
    `],
    ['external row carrying a pathway event id', true, `
      INSERT INTO pathway_projector_inbox
        (scope_kind, tenant_id, consumer_key, generation, event_id, offset_id,
         facility_id, interface_family, direction, source_partition,
         source_position, source_token, predecessor_token, duplicate_key,
         command_fingerprint, occurred_at, received_at, recorded_at,
         arrival_class, effect_disposition, policy_version, policy_signature,
         retention_policy, retention_until)
      VALUES
        ('external_interface', $1::uuid, 'external:I10', 1, 1, $3::uuid,
         $4::integer, 'I10', 'inbound', $2::text, 11, 'token-11',
         'token-10', 'reading-11', repeat('a', 64), NOW(), NOW(), NOW(),
         'recovery_backlog', 'late_pending_only', 'c-d8-v1',
         'synthetic-signature', 'retain-730d', NOW() + INTERVAL '730 days')
    `],
  ])('direct SQL rejects an inbox %s with SQLSTATE 23514', async (
    _label,
    external,
    sql,
  ) => {
    await expectFailure(client, () => client.query(
      sql,
      external
        ? [tenantId, `invalid-inbox-${suffix}-${_label}`, offsetId, facilityId]
        : [tenantId, `invalid-inbox-${suffix}-${_label}`],
    ), {
      code: '23514',
      constraint: 'chk_pathway_projector_inbox_row_shape',
    });
  });

  it('keeps external facility identity tenant-bound at the database', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          recovery_state, policy_version, policy_signature, retention_policy,
          retention_until, historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'facility', $2::integer, 'I10',
          'inbound', $3::text, 'external:I10', 1,
          'monotonic_position_and_predecessor', 'paused', 'c-d8-v1',
          'synthetic-signature', 'retain-730d', NOW() + INTERVAL '730 days',
          NULL, NULL)`,
      [tenantId, otherFacilityId, `cross-facility-${suffix}`],
    ), {
      code: '23503',
      constraint: 'fk_event_consumer_offsets_facility',
    });
  });

  it('accepts tenant-only I09 partitions without manufacturing a facility', async () => {
    const result = await client.query(
      `SELECT facility_scope, facility_id, interface_family
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND interface_family = 'I09'`,
      [tenantId],
    );
    expect(result.rows).toEqual([{
      facility_scope: 'tenant',
      facility_id: null,
      interface_family: 'I09',
    }]);
  });

  it('direct SQL rejects late-vitals source/family and triage violations', async () => {
    for (const [source, family, deviceVerified, triageAcuity] of [
      ['fhir', 'I09', null, null],
      ['device', 'I15', false, null],
      ['device', 'I09', false, 2],
    ]) {
      await expectFailure(client, () => client.query(
        `INSERT INTO vitals_chart
           (tenant_id, patient_uid, heart_rate, source, device_verified,
            triage_acuity, recovery_inbox_id, recovery_interface_family)
         VALUES ($1::uuid, $2::uuid, 88, $3::text, $4::boolean,
                 $5::smallint, $6::uuid, $7::text)`,
        [tenantId, patientUid, source, deviceVerified, triageAcuity, i09InboxId, family],
      ), {
        code: '23514',
        constraint: 'chk_vitals_chart_recovery_late_boundary',
      });
    }
  });

  it('direct SQL rejects cross-tenant canonical-inbox references', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, heart_rate, source, device_verified,
          recovery_inbox_id, recovery_interface_family)
       VALUES ($1::uuid, $2::uuid, 88, 'device', false, $3::uuid, 'I09')`,
      [tenantId, patientUid, otherI09InboxId],
    ), {
      code: '23503',
      constraint: 'fk_vitals_chart_recovery_inbox',
    });
  });

  it('direct SQL rejects an I09 raw receipt with drifted protocol shape', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO lab_interface_messages
         (tenant_id, direction, protocol, message_type, raw_message, status,
          recovery_inbox_id, recovery_interface_family)
       VALUES ($1::uuid, 'inbound', 'fhir-json', 'ORU^VITALS', 'raw', 'received',
               $2::uuid, 'I09')`,
      [tenantId, i09InboxId],
    ), {
      code: '23514',
      constraint: 'chk_lab_interface_messages_i09_recovery_shape',
    });
  });

  it('RLS shows external rows only under a correct explicit tenant context', async () => {
    const role = await client.query(
      `SELECT CASE
         WHEN to_regrole('vhhealth_app') IS NOT NULL THEN 'vhhealth_app'
         WHEN to_regrole('vhhealth_runtime') IS NOT NULL THEN 'vhhealth_runtime'
         ELSE NULL
       END AS role_name`,
    );
    const roleName = role.rows[0].role_name;
    if (!roleName) return;

    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await client.query(`SET LOCAL ROLE ${roleName}`);
    for (const setting of ['', 'bypass', otherTenantId]) {
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [setting],
      );
      const hidden = await client.query(
        `SELECT offset_id::text
           FROM public.event_consumer_offsets
          WHERE offset_id = $1::uuid`,
        [offsetId],
      );
      expect(hidden.rowCount).toBe(0);
    }
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [tenantId],
    );
    const visible = await client.query(
      `SELECT offset_id::text
         FROM public.event_consumer_offsets
        WHERE offset_id = $1::uuid`,
      [offsetId],
    );
    expect(visible.rows).toEqual([{ offset_id: offsetId }]);
    const controlHidden = await client.query(
      `SELECT offset_id::text
         FROM public.event_consumer_offsets
        WHERE offset_id = $1::uuid`,
      [pathwayOffsetId],
    );
    expect(controlHidden.rowCount).toBe(0);

    await expectFailure(client, () => client.query(
      `DELETE FROM public.event_consumer_offsets WHERE offset_id = $1::uuid`,
      [offsetId],
    ), { code: '42501' });
    await client.query('RESET ROLE');
  });
});
