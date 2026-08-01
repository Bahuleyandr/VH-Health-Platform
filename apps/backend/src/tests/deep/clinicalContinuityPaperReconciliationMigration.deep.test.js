import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RLS_ROLE = 'c5_2_reconciliation_rls_test';

async function expectDatabaseFailure(client, operation, expectedConstraint) {
  await client.query('SAVEPOINT expected_c5_2_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c5_2_failure');
  await client.query('RELEASE SAVEPOINT expected_c5_2_failure');
  expect(failure).toBeDefined();
  expect(failure.code).toBe('23514');
  expect(failure.constraint).toBe(expectedConstraint);
}

describeIfDb('migration 606 database integrity and isolation drills', () => {
  const client = new Client({ connectionString: databaseUrl });
  const fixture = {
    tenantId: randomUUID(),
    otherTenantId: randomUUID(),
    facilityId: 1800000000 + Math.floor(Math.random() * 100000),
    otherFacilityId: 1900000000 + Math.floor(Math.random() * 100000),
    commanderUid: randomUUID(),
    safetyLeadUid: randomUUID(),
    incidents: [randomUUID(), randomUUID(), randomUUID()],
    packets: [randomUUID(), randomUUID(), randomUUID()],
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    for (const [tenantId, suffix] of [[fixture.tenantId, 'primary'], [fixture.otherTenantId, 'other']]) {
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2, $3)`,
        [tenantId, `c5-2-${suffix}-${randomUUID()}`, `C5.2 ${suffix} tenant`],
      );
    }
    for (const [facilityId, tenantId, suffix] of [
      [fixture.facilityId, fixture.tenantId, 'primary'],
      [fixture.otherFacilityId, fixture.tenantId, 'other-facility'],
    ]) {
      await client.query(
        `INSERT INTO facilities (id, tenant_id, facility_code, display_name, timezone)
         VALUES ($1::integer, $2::uuid, $3, $4, 'Asia/Kolkata')`,
        [facilityId, tenantId, `C52-${randomUUID()}`, `C5.2 ${suffix}`],
      );
    }
    for (const [uid, role, suffix] of [
      [fixture.commanderUid, 'ADMIN', 'commander'],
      [fixture.safetyLeadUid, 'CMO', 'safety'],
    ]) {
      await client.query(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5,
           TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        [uid, fixture.tenantId, `+917${Math.floor(100000000 + Math.random() * 899999999)}`, `C5.2 ${suffix}`, role],
      );
    }
    for (let index = 0; index < fixture.packets.length; index += 1) {
      await client.query(
        `INSERT INTO clinical_continuity_incident_packets (
           id, tenant_id, facility_id, reserved_incident_id,
           range_prefix, range_first, range_last,
           packet_key_id, packet_key_version, canonical_payload_hash,
           signature, valid_from, valid_until, contact_sheet_version
         ) VALUES (
           $1::uuid, $2::uuid, $3::integer, $4::uuid,
           $5, $6::bigint, $7::bigint,
           'c5-2-test-key', '1', $8, 'test-signature',
           NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', '1'
         )`,
        [
          fixture.packets[index],
          fixture.tenantId,
          fixture.facilityId,
          fixture.incidents[index],
          `C52-${index + 1}-`,
          index * 100 + 1,
          index * 100 + 99,
          String(index + 1).repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO clinical_continuity_incidents (
           id, tenant_id, facility_id, packet_id, canonical_incident_id,
           alias_disposition, commander_uid, commander_role,
           lifecycle_state, declared_at, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
           $6, $7::uuid, 'ADMIN', 'declared',
           NOW() - INTERVAL '30 minutes', $7::uuid, $7::uuid
         )`,
        [
          fixture.incidents[index],
          fixture.tenantId,
          fixture.facilityId,
          fixture.packets[index],
          index === 0 ? null : fixture.incidents[0],
          index === 0 ? 'canonical' : 'observed_alias',
          fixture.commanderUid,
        ],
      );
    }
    const range = await client.query(
      `INSERT INTO clinical_continuity_paper_ranges (
         tenant_id, facility_id, incident_id, packet_id,
         range_prefix, range_first, range_last, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid,
         'C52-1-', 1, 99, 'in_use', $5::uuid, $5::uuid
       ) RETURNING id::text`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[0], fixture.packets[0], fixture.commanderUid],
    );
    fixture.rangeId = range.rows[0].id;
    const declaration = await client.query(
      `INSERT INTO clinical_continuity_incident_declarations (
         tenant_id, facility_id, incident_id, packet_id, paper_range_id,
         declaration_source, packet_key_id, packet_key_version,
         signed_canonical_hash, signer_uid, signer_role, verification_result,
         conflict_disposition, occurred_at, imported_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid,
         'offline_import', 'c5-2-test-key', '1', $6,
         $7::uuid, 'ADMIN', 'verified', 'accepted',
         NOW() - INTERVAL '20 minutes', $7::uuid
       ) RETURNING id::text`,
      [
        fixture.tenantId,
        fixture.facilityId,
        fixture.incidents[0],
        fixture.packets[0],
        fixture.rangeId,
        '1'.repeat(64),
        fixture.commanderUid,
      ],
    );
    fixture.declarationId = declaration.rows[0].id;

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN;
        END IF;
      END $$
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT ON clinical_continuity_incidents TO ${RLS_ROLE}`);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('requires a one-step CAS and preserves declaration history', async () => {
    await expectDatabaseFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_incidents
            SET lifecycle_state = 'restored', restored_at = NOW(), updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [fixture.incidents[0]],
      ),
      'chk_cc_reconciliation_projection_immutable',
    );
    const updated = await client.query(
      `UPDATE clinical_continuity_incidents
          SET lifecycle_state = 'restored', restored_at = NOW(),
              version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1::uuid
        RETURNING version`,
      [fixture.incidents[0]],
    );
    expect(updated.rows[0].version).toBe(2);

    await expectDatabaseFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_incident_declarations
            SET conflict_disposition = 'conflict'
          WHERE id = $1::uuid`,
        [fixture.declarationId],
      ),
      'chk_cc_reconciliation_append_only',
    );
  });

  test('permits one signed-packet terminal transition and rejects a second', async () => {
    await client.query(
      `UPDATE clinical_continuity_incident_packets
          SET status = 'used', used_at = clock_timestamp(), used_by = $1::uuid
        WHERE id = $2::uuid`,
      [fixture.commanderUid, fixture.packets[1]],
    );
    await expectDatabaseFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_incident_packets
            SET status = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'late change'
          WHERE id = $1::uuid`,
        [fixture.packets[1]],
      ),
      'chk_cc_incident_packet_immutable',
    );
  });

  test('rejects alias cycles and appends a corrective alias without rewriting the first decision', async () => {
    const active = await client.query(
      `INSERT INTO clinical_continuity_incident_aliases (
         tenant_id, facility_id, observed_incident_id, canonical_incident_id,
         disposition, reason_code, decided_by, decided_role
       ) VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'active', 'split_brain', $5::uuid, 'ADMIN')
       RETURNING id::text`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[1], fixture.incidents[0], fixture.commanderUid],
    );
    await expectDatabaseFailure(
      client,
      () => client.query(
        `INSERT INTO clinical_continuity_incident_aliases (
           tenant_id, facility_id, observed_incident_id, canonical_incident_id,
           disposition, reason_code, decided_by, decided_role
         ) VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'active', 'cycle', $5::uuid, 'ADMIN')`,
        [fixture.tenantId, fixture.facilityId, fixture.incidents[0], fixture.incidents[1], fixture.commanderUid],
      ),
      'chk_cc_incident_alias_acyclic',
    );
    await client.query(
      `INSERT INTO clinical_continuity_incident_aliases (
         tenant_id, facility_id, observed_incident_id, canonical_incident_id,
         disposition, supersedes_alias_id, reason_code, decided_by, decided_role
       ) VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'corrective', $5::uuid, 'corrected_target', $6::uuid, 'ADMIN')`,
      [
        fixture.tenantId,
        fixture.facilityId,
        fixture.incidents[1],
        fixture.incidents[2],
        active.rows[0].id,
        fixture.commanderUid,
      ],
    );
    const history = await client.query(
      `SELECT disposition, canonical_incident_id::text
         FROM clinical_continuity_incident_aliases
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND observed_incident_id = $3::uuid
        ORDER BY decided_at`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[1]],
    );
    expect(history.rows).toEqual([
      { disposition: 'active', canonical_incident_id: fixture.incidents[0] },
      { disposition: 'corrective', canonical_incident_id: fixture.incidents[2] },
    ]);
  });

  test('enforces tenant plus facility RLS against both cross-scope probes', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(fixture.facilityId)]);
    const visible = await client.query('SELECT count(*)::integer AS count FROM clinical_continuity_incidents');
    expect(visible.rows[0].count).toBe(3);

    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(fixture.otherFacilityId)]);
    const otherFacility = await client.query('SELECT count(*)::integer AS count FROM clinical_continuity_incidents');
    expect(otherFacility.rows[0].count).toBe(0);

    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.otherTenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(fixture.facilityId)]);
    const otherTenant = await client.query('SELECT count(*)::integer AS count FROM clinical_continuity_incidents');
    expect(otherTenant.rows[0].count).toBe(0);
    await client.query('RESET ROLE');
  });

  test('rejects same-person closure keys and accepts distinct operational and clinical actors', async () => {
    await client.query(
      `INSERT INTO clinical_continuity_incident_attestations (
         tenant_id, facility_id, incident_id, attestation_kind,
         actor_uid, actor_role, incident_version, predicate_snapshot_hash
       ) VALUES ($1::uuid, $2::integer, $3::uuid, 'operational', $4::uuid, 'ADMIN', 2, $5)`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[0], fixture.commanderUid, 'a'.repeat(64)],
    );
    await expectDatabaseFailure(
      client,
      () => client.query(
        `INSERT INTO clinical_continuity_incident_attestations (
           tenant_id, facility_id, incident_id, attestation_kind,
           actor_uid, actor_role, incident_version, predicate_snapshot_hash
         ) VALUES ($1::uuid, $2::integer, $3::uuid, 'clinical', $4::uuid, 'ADMIN', 2, $5)`,
        [fixture.tenantId, fixture.facilityId, fixture.incidents[0], fixture.commanderUid, 'a'.repeat(64)],
      ),
      'chk_cc_closure_actor_separation',
    );
    await client.query(
      `INSERT INTO clinical_continuity_incident_attestations (
         tenant_id, facility_id, incident_id, attestation_kind,
         actor_uid, actor_role, incident_version, predicate_snapshot_hash
       ) VALUES ($1::uuid, $2::integer, $3::uuid, 'clinical', $4::uuid, 'CMO', 2, $5)`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[0], fixture.safetyLeadUid, 'a'.repeat(64)],
    );
    const count = await client.query(
      `SELECT count(*)::integer AS count
         FROM clinical_continuity_incident_attestations
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid`,
      [fixture.tenantId, fixture.facilityId, fixture.incidents[0]],
    );
    expect(count.rows[0].count).toBe(2);
  });
});
