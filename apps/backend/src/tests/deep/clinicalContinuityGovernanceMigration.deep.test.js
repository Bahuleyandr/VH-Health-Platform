import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/600_clinical_continuity_pack_governance.sql', import.meta.url),
  'utf8',
);

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RLS_TEST_ROLE = 'rls_test_app';

function token() {
  return randomUUID().replaceAll('-', '');
}

function continuityPublicKeyPem(keyId) {
  return [
    '-----BEGIN PUBLIC KEY-----',
    Buffer.from(keyId, 'utf8').toString('base64'),
    '-----END PUBLIC KEY-----',
  ].join('\n');
}

function continuityPublicKeySha256(keyId) {
  return createHash('sha256')
    .update(continuityPublicKeyPem(keyId), 'utf8')
    .digest('hex');
}

async function setTenant(client, tenantId) {
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [tenantId],
  );
}

async function expectFailure(client, operation, expected = {}) {
  await client.query('SAVEPOINT expected_cc_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_cc_failure');
  await client.query('RELEASE SAVEPOINT expected_cc_failure');
  expect(failure).toBeDefined();
  if (expected.code) expect(failure.code).toBe(expected.code);
  if (expected.constraint) expect(failure.constraint).toBe(expected.constraint);
  if (expected.message) expect(failure.message).toContain(expected.message);
  return failure;
}

async function seedTenant(client, label) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `cc-${label}-${token()}`.slice(0, 60), `Continuity ${label}`],
  );
  return tenantId;
}

async function seedFacility(client, tenantId, label) {
  const result = await client.query(
    `INSERT INTO facilities
       (tenant_id, facility_code, display_name, timezone)
     VALUES ($1::uuid, $2::text, $3::text, 'Asia/Kolkata')
     RETURNING id`,
    [tenantId, `CC-${label}-${token()}`.slice(0, 70), `Continuity facility ${label}`],
  );
  return Number(result.rows[0].id);
}

async function seedWard(client, tenantId, facilityId, label) {
  const result = await client.query(
    `INSERT INTO wards (tenant_id, facility_id, name)
     VALUES ($1::uuid, $2::integer, $3::text)
     RETURNING id`,
    [tenantId, facilityId, `Continuity ward ${label} ${token().slice(0, 8)}`],
  );
  return Number(result.rows[0].id);
}

async function seedUser(client, tenantId, label, role = 'ADMIN') {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, is_active, status,
        is_deleted, registered_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, TRUE, 'active',
        FALSE, NOW(), NOW())`,
    [uid, tenantId, `+919${token().slice(0, 9)}`, `Continuity ${label}`, role],
  );
  return uid;
}

async function seedKey(client, tenantId, keyId, purpose, status = 'active') {
  await setTenant(client, tenantId);
  await client.query(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, algorithm, status, metadata)
      VALUES
       ($1::uuid, $2::text, 'env', 'ed25519', $3::text,
         jsonb_build_object(
           'purpose', $4::text,
           'public_key_spki_pem', $5::text
         ))`,
    [tenantId, keyId, status, purpose, continuityPublicKeyPem(keyId)],
  );
  return keyId;
}

async function insertDraftPolicy(client, {
  tenantId,
  facilityId,
  policyVersion = 1,
  policySchemaVersion = 1,
  policyKeyId,
  currentKeyId,
  nextKeyId = null,
  revocationEpoch = 0,
  revokedKeyIds = [],
  supersedesPolicyId = null,
  checksum = 'a'.repeat(64),
  effectiveFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
  policyKeySha256 = continuityPublicKeySha256(policyKeyId),
  currentKeySha256 = continuityPublicKeySha256(currentKeyId),
  nextKeySha256 = nextKeyId === null ? null : continuityPublicKeySha256(nextKeyId),
}) {
  await setTenant(client, tenantId);
  const result = await client.query(
    `INSERT INTO clinical_continuity_policy_versions
       (tenant_id, facility_id, policy_version, policy_schema_version,
         policy_document, policy_checksum, policy_signing_key_id,
         policy_signing_public_key_sha256,
         current_pack_signing_key_id, current_pack_signing_public_key_sha256,
         next_pack_signing_key_id, next_pack_signing_public_key_sha256,
         policy_signature, revocation_epoch, revoked_key_ids,
         effective_from, supersedes_policy_id)
      VALUES
       ($1::uuid, $2::integer, $3::bigint, $4::integer,
         $5::jsonb, $6::char(64), $7::text,
         $8::char(64),
         $9::text, $10::char(64),
         $11::text, $12::char(64),
         $13::bytea, $14::bigint, $15::jsonb,
         $16::timestamptz, $17::uuid)
      RETURNING id::text, policy_version::text`,
    [
      tenantId,
      facilityId,
      policyVersion,
      policySchemaVersion,
      JSON.stringify({
        audience: {
          tenant_id: tenantId,
          facility_id: facilityId,
          capability: 'clinical_continuity_pack_read',
        },
        freshness: { regenerate_minutes: 15, hard_expiry_hours: 24 },
      }),
      checksum,
      policyKeyId,
      policyKeySha256,
      currentKeyId,
      currentKeySha256,
      nextKeyId,
      nextKeySha256,
      Buffer.alloc(64, 0x5a),
      revocationEpoch,
      JSON.stringify(revokedKeyIds),
      effectiveFrom,
      supersedesPolicyId,
    ],
  );
  return result.rows[0];
}

async function createApproval(client, {
  tenantId,
  policyId,
  checksum,
  approvers,
  requiredApprovers = approvers.length,
}) {
  const decidedAt = new Date();
  const votes = approvers.map((uid, index) => ({
    uid,
    at: new Date(decidedAt.getTime() - (index + 1) * 1000).toISOString(),
  }));
  const result = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, status, approved_by, decided_at, created_by,
        decided_by, metadata)
     VALUES
       ($1::uuid, 'clinical_continuity_policy_governance',
        'clinical_continuity_policy_version', $2::text,
        $3::integer, 'approved', $4::jsonb, $5::timestamptz, $6::uuid,
        $6::uuid, $7::jsonb)
     RETURNING id`,
    [
      tenantId,
      policyId,
      requiredApprovers,
      JSON.stringify(votes),
      decidedAt,
      approvers[0],
      JSON.stringify({
        clinical_continuity_policy_governance: {
          policy_checksum: checksum,
          countersignature_complete: true,
        },
      }),
    ],
  );
  return { id: Number(result.rows[0].id), decidedAt };
}

async function approveAndActivatePolicy(client, {
  tenantId,
  policy,
  checksum,
  approvers,
}) {
  await setTenant(client, tenantId);
  const approval = await createApproval(client, {
    tenantId,
    policyId: policy.id,
    checksum,
    approvers,
  });
  await client.query(
    `UPDATE clinical_continuity_policy_versions
        SET lifecycle_state = 'approved',
            approval_id = $1::integer,
            approved_by = $2::uuid,
            approved_at = $3::timestamptz
      WHERE tenant_id = $4::uuid AND id = $5::uuid`,
    [approval.id, approvers[0], approval.decidedAt, tenantId, policy.id],
  );
  await client.query(
    "SELECT set_config('app.clinical_continuity_activation_bypass', 'migration_or_test', true)",
  );
  await client.query(
    `UPDATE clinical_continuity_policy_versions
        SET lifecycle_state = 'active'
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, policy.id],
  );
  await client.query(
    "SELECT set_config('app.clinical_continuity_activation_bypass', '', true)",
  );
  return { ...policy, approvalId: approval.id };
}

async function insertSnapshot(client, values) {
  const generatedAt = values.generatedAt || new Date();
  const publishedAt = values.publishedAt
    || new Date(generatedAt.getTime() + 60 * 1000);
  const expiresAt = values.expiresAt
    || new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000);
  const retentionUntil = values.retentionUntil
    || new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  await setTenant(client, values.contextTenantId || values.tenantId);
  return client.query(
    `INSERT INTO downtime_snapshots
       (tenant_id, scope, ward_id, label, payload, expires_at,
        facility_id, location_type, location_identifier,
        pack_schema_version, policy_version_id, policy_version,
        publication_set_id, manifest_version, source_watermark,
        content_hash, rendered_content_hash, signature_algorithm,
        signing_key_id, signature, generated_at, published_at,
        fresh_until, freshness_metadata, retention_until)
     VALUES
       ($1::uuid, 'clinical_continuity_pack', $2::integer, $3::text,
        $4::jsonb, $5::timestamptz,
        $6::integer, $7::text, $8::text,
        1, $9::uuid, $10::bigint,
        $11::uuid, $12::bigint, $13::jsonb,
        $14::char(64), $15::char(64), 'ed25519',
        $16::text, $17::bytea, $18::timestamptz, $19::timestamptz,
        $20::timestamptz, $21::jsonb, $22::timestamptz)
     RETURNING id`,
    [
      values.tenantId,
      values.wardId ?? null,
      values.label || `Continuity ${values.locationType}`,
      JSON.stringify(values.payload || { patients: [] }),
      expiresAt,
      values.facilityId,
      values.locationType,
      values.locationIdentifier || `${values.locationType}-${token()}`,
      values.policyId,
      values.policyVersion || 1,
      values.publicationSetId || randomUUID(),
      values.manifestVersion || 1,
      JSON.stringify(values.sourceWatermark || {
        transaction_id: '1',
        captured_at: generatedAt.toISOString(),
      }),
      values.contentHash || 'b'.repeat(64),
      values.renderedContentHash || 'c'.repeat(64),
      values.signingKeyId,
      values.signature || Buffer.alloc(64, 0x6b),
      generatedAt,
      publishedAt,
      values.freshUntil || new Date(generatedAt.getTime() + 15 * 60 * 1000),
      JSON.stringify(values.freshnessMetadata || {
        regeneration_minutes: 15,
        hard_expiry_hours: 24,
      }),
      retentionUntil,
    ],
  );
}

describe('migration 600 static continuity governance contract', () => {
  test('reserves one inert additive migration 600', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter((name) => name.startsWith('600_'));
    expect(names).toEqual(['600_clinical_continuity_pack_governance.sql']);
    expect(migrationSql).toContain('-- @no-transaction');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS clinical_continuity_policy_versions');
    expect(migrationSql).toContain('ALTER TABLE downtime_snapshots');
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\s+clinical_continuity_policy_versions\b/i);
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\s+encryption_keys\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+tenants\b/i);
    expect(migrationSql).not.toMatch(/\bCREATE\s+TABLE[^;]*signing_keys\b/i);
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS policy_signing_public_key_sha256 CHAR(64)',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS current_pack_signing_public_key_sha256 CHAR(64)',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS next_pack_signing_public_key_sha256 CHAR(64)',
    );
  });

  test('bootstraps the policy table and its fail-closed posture atomically', () => {
    const startMarker = 'DO $cc_policy_table_bootstrap$';
    const endMarker = '$cc_policy_table_bootstrap$;';
    const start = migrationSql.indexOf(startMarker);
    const end = migrationSql.indexOf(endMarker, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const bootstrap = migrationSql.slice(start, end + endMarker.length);
    const outsideBootstrap = [
      migrationSql.slice(0, start),
      migrationSql.slice(end + endMarker.length),
    ].join('\n');
    const normalized = bootstrap.replace(/\s+/gu, ' ');
    const orderedClauses = [
      'CREATE TABLE IF NOT EXISTS clinical_continuity_policy_versions',
      'ALTER TABLE clinical_continuity_policy_versions ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE clinical_continuity_policy_versions FORCE ROW LEVEL SECURITY',
      'CREATE POLICY tenant_isolation',
      'CREATE POLICY cc_policy_explicit_context',
      'REVOKE ALL PRIVILEGES ON TABLE clinical_continuity_policy_versions FROM PUBLIC',
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE clinical_continuity_policy_versions FROM %I',
    ];

    let previousOffset = -1;
    for (const clause of orderedClauses) {
      const offset = normalized.indexOf(clause);
      expect(offset).toBeGreaterThan(previousOffset);
      previousOffset = offset;
    }
    expect(normalized).toContain(
      "ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]",
    );
    expect(outsideBootstrap).not.toContain(
      'CREATE TABLE IF NOT EXISTS clinical_continuity_policy_versions',
    );
  });

  test('pins Pattern-A plus explicit fail-closed context and least privilege', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE clinical_continuity_policy_versions FORCE ROW LEVEL SECURITY',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE downtime_snapshots FORCE ROW LEVEL SECURITY',
    );
    expect(migrationSql).toContain('CREATE POLICY tenant_isolation');
    expect(migrationSql).toContain('CREATE POLICY cc_policy_explicit_context');
    expect(migrationSql).toContain('CREATE POLICY downtime_cc_explicit_tenant');
    expect(migrationSql).toContain(
      'REFERENCES encryption_keys (tenant_id, key_id)',
    );
    expect(migrationSql).toContain(
      'REFERENCES facilities (tenant_id, id)',
    );
    expect(migrationSql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE clinical_continuity_policy_versions',
    );
    expect(migrationSql).toContain('clinical_continuity_assert_snapshot_governance');
    expect(migrationSql).toContain('DO $cc_trigger_replacement$');
    expect(migrationSql).toContain('DO $cc_policy_replacement$');
    expect(migrationSql).not.toMatch(/^DROP (?:TRIGGER|POLICY)\b/mu);
  });

  test('keeps one active policy without collapsing facility version relations', () => {
    expect(migrationSql.replace(/\s+/gu, ' ')).toContain(
      "CREATE UNIQUE INDEX ux_cc_policy_active ON clinical_continuity_policy_versions ( tenant_id, facility_id, lifecycle_state ) WHERE lifecycle_state = 'active'",
    );
  });
});

describeIfDb('migration 600 database continuity governance contract', () => {
  let client;
  let tenantA;
  let tenantB;
  let facilityA;
  let facilityB;
  let revocationFacility;
  let approvalFailureFacility;
  let draftFacility;
  let wardA;
  let wardInOtherFacility;
  let approversA;
  let approversB;
  let keysA;
  let keysB;
  let activePolicyA;
  let activePolicyB;
  let draftPolicyA;
  let rlsRoleReady = false;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    tenantA = await seedTenant(client, 'tenant-a');
    tenantB = await seedTenant(client, 'tenant-b');
    facilityA = await seedFacility(client, tenantA, 'a');
    facilityB = await seedFacility(client, tenantB, 'b');
    revocationFacility = await seedFacility(client, tenantA, 'revocation');
    approvalFailureFacility = await seedFacility(client, tenantA, 'approval-failure');
    draftFacility = await seedFacility(client, tenantA, 'draft');
    wardA = await seedWard(client, tenantA, facilityA, 'a');
    wardInOtherFacility = await seedWard(
      client,
      tenantA,
      revocationFacility,
      'other-facility',
    );
    approversA = [
      await seedUser(client, tenantA, 'approver-a1', 'MEDICAL_SUPERINTENDENT'),
      await seedUser(client, tenantA, 'approver-a2', 'CNO'),
    ];
    approversB = [
      await seedUser(client, tenantB, 'approver-b1', 'MEDICAL_SUPERINTENDENT'),
      await seedUser(client, tenantB, 'approver-b2', 'CNO'),
    ];
    keysA = {
      policy: await seedKey(
        client,
        tenantA,
        `cc-policy-a-${token()}`,
        'clinical_continuity_policy_signing',
      ),
      current: await seedKey(
        client,
        tenantA,
        `cc-pack-current-a-${token()}`,
        'clinical_continuity_pack_signing',
      ),
      next: await seedKey(
        client,
        tenantA,
        `cc-pack-next-a-${token()}`,
        'clinical_continuity_pack_signing',
      ),
      unlisted: await seedKey(
        client,
        tenantA,
        `cc-pack-unlisted-a-${token()}`,
        'clinical_continuity_pack_signing',
      ),
    };
    keysB = {
      policy: await seedKey(
        client,
        tenantB,
        `cc-policy-b-${token()}`,
        'clinical_continuity_policy_signing',
      ),
      current: await seedKey(
        client,
        tenantB,
        `cc-pack-current-b-${token()}`,
        'clinical_continuity_pack_signing',
      ),
    };

    const checksumA = '1'.repeat(64);
    const policyA = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      nextKeyId: keysA.next,
      checksum: checksumA,
    });
    activePolicyA = await approveAndActivatePolicy(client, {
      tenantId: tenantA,
      policy: policyA,
      checksum: checksumA,
      approvers: approversA,
    });

    const checksumB = '2'.repeat(64);
    const policyB = await insertDraftPolicy(client, {
      tenantId: tenantB,
      facilityId: facilityB,
      policyKeyId: keysB.policy,
      currentKeyId: keysB.current,
      checksum: checksumB,
    });
    activePolicyB = await approveAndActivatePolicy(client, {
      tenantId: tenantB,
      policy: policyB,
      checksum: checksumB,
      approvers: approversB,
    });

    draftPolicyA = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: draftFacility,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      checksum: '3'.repeat(64),
    });

    const role = await client.query(
      `SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member,
              role.rolsuper, role.rolbypassrls
         FROM pg_roles AS role
        WHERE role.rolname = $1::name`,
      [RLS_TEST_ROLE],
    );
    rlsRoleReady = role.rows.length === 1
      && role.rows[0].member === true
      && role.rows[0].rolsuper === false
      && role.rows[0].rolbypassrls === false;
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('installs composite tenant references, exact location semantics, triggers, and forced RLS', async () => {
    const posture = await client.query(
      `SELECT relation.relname,
              relation.relrowsecurity,
              relation.relforcerowsecurity,
              ARRAY_AGG(DISTINCT policy.polname::text) FILTER (
                WHERE policy.polname IS NOT NULL
              ) AS policies,
              ARRAY_AGG(DISTINCT trigger.tgname::text) FILTER (
                WHERE trigger.tgname IS NOT NULL AND NOT trigger.tgisinternal
              ) AS triggers
         FROM pg_class AS relation
         LEFT JOIN pg_policy AS policy ON policy.polrelid = relation.oid
         LEFT JOIN pg_trigger AS trigger ON trigger.tgrelid = relation.oid
        WHERE relation.oid IN (
          'clinical_continuity_policy_versions'::regclass,
          'downtime_snapshots'::regclass
        )
        GROUP BY relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
        ORDER BY relation.relname`,
    );
    expect(posture.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relname: 'clinical_continuity_policy_versions',
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: expect.arrayContaining(['tenant_isolation', 'cc_policy_explicit_context']),
        triggers: expect.arrayContaining([
          'trg_cc_policy_version_monotonic',
          'trg_cc_policy_lifecycle',
          'trg_cc_policy_approval_evidence',
        ]),
      }),
      expect.objectContaining({
        relname: 'downtime_snapshots',
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: expect.arrayContaining(['tenant_isolation', 'downtime_cc_explicit_tenant']),
        triggers: expect.arrayContaining([
          'trg_downtime_cc_governance',
          'trg_downtime_cc_immutable',
        ]),
      }),
    ]));

    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname IN (
          'cc_policy_facility_tenant_fk',
          'cc_policy_current_key_tenant_fk',
          'cc_policy_supersedes_tenant_facility_fk',
          'fk_wards_facility_tenant',
          'fk_emergency_visits_facility_tenant',
          'fk_downtime_snapshots_facility_tenant',
          'fk_downtime_snapshots_cc_policy_pin',
           'fk_downtime_snapshots_cc_signing_key',
           'fk_downtime_snapshots_ward_facility_tenant',
           'cc_policy_public_key_binding_check',
           'cc_policy_revocation_epoch_check',
           'downtime_snapshots_cc_no_default_tenant',
           'downtime_snapshots_continuity_location_check'
        )
        ORDER BY conname`,
    );
    const definitions = Object.fromEntries(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(definitions.cc_policy_facility_tenant_fk)
      .toContain('FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id)');
    expect(definitions.cc_policy_current_key_tenant_fk)
      .toContain('FOREIGN KEY (tenant_id, current_pack_signing_key_id)');
    expect(definitions.cc_policy_supersedes_tenant_facility_fk)
      .toContain('FOREIGN KEY (tenant_id, facility_id, supersedes_policy_id)');
    expect(definitions.fk_wards_facility_tenant)
      .toContain('FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id)');
    expect(definitions.fk_emergency_visits_facility_tenant)
      .toContain('FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id)');
    expect(definitions.fk_downtime_snapshots_cc_policy_pin)
      .toContain('FOREIGN KEY (tenant_id, facility_id, policy_version_id, policy_version)');
    expect(definitions.fk_downtime_snapshots_ward_facility_tenant)
      .toContain('FOREIGN KEY (tenant_id, facility_id, ward_id)');
    expect(definitions.cc_policy_public_key_binding_check)
      .toContain('policy_signing_public_key_sha256');
    expect(definitions.cc_policy_public_key_binding_check)
      .toContain('current_pack_signing_public_key_sha256');
    expect(definitions.cc_policy_revocation_epoch_check)
      .toContain('revocation_epoch >= 0');
    expect(definitions.downtime_snapshots_cc_no_default_tenant)
      .toContain(DEFAULT_TENANT_ID);
    expect(definitions.downtime_snapshots_continuity_location_check)
      .toContain("'paeds'");
    expect(definitions.downtime_snapshots_continuity_location_check)
      .toContain("'ed_board'");
    expect(definitions.downtime_snapshots_continuity_location_check)
      .toContain("'opd_day'");
  });

  test('rejects the literal default tenant and cross-tenant facility references', async () => {
    await setTenant(client, DEFAULT_TENANT_ID);
    const defaultFacility = await seedFacility(client, DEFAULT_TENANT_ID, 'default-reject');
    const defaultPolicyKey = await seedKey(
      client,
      DEFAULT_TENANT_ID,
      `cc-policy-default-${token()}`,
      'clinical_continuity_policy_signing',
    );
    const defaultPackKey = await seedKey(
      client,
      DEFAULT_TENANT_ID,
      `cc-pack-default-${token()}`,
      'clinical_continuity_pack_signing',
    );
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: DEFAULT_TENANT_ID,
        facilityId: defaultFacility,
        policyKeyId: defaultPolicyKey,
        currentKeyId: defaultPackKey,
      }),
      { code: '23514', constraint: 'cc_policy_no_default_tenant_check' },
    );

    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: facilityB,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
      }),
      { code: '23503', constraint: 'cc_policy_facility_tenant_fk' },
    );
  });

  test('enforces monotonic versions and irreversible revocation sets', async () => {
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        revocationEpoch: -1,
      }),
      { code: '23514', constraint: 'cc_policy_revocation_epoch_check' },
    );
    const first = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: revocationFacility,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      checksum: '4'.repeat(64),
    });
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyVersion: 1,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        supersedesPolicyId: first.id,
      }),
      { code: '23514', message: 'increase monotonically' },
    );
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyVersion: 2,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        supersedesPolicyId: first.id,
        revokedKeyIds: ['retired-key'],
        revocationEpoch: 0,
      }),
      { code: '23514', message: 'higher epoch' },
    );
    const second = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: revocationFacility,
      policyVersion: 2,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      supersedesPolicyId: first.id,
      revokedKeyIds: ['retired-key'],
      revocationEpoch: 1,
      checksum: '5'.repeat(64),
    });
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyVersion: 3,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        supersedesPolicyId: second.id,
        revokedKeyIds: [],
        revocationEpoch: 2,
      }),
      { code: '23514', message: 'revoked key set cannot roll back' },
    );
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyVersion: 3,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        supersedesPolicyId: second.id,
        revokedKeyIds: ['retired-key', 'retired-key'],
        revocationEpoch: 2,
      }),
      { code: '23514', message: 'unique non-empty strings' },
    );
    await expectFailure(
      client,
      () => insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: revocationFacility,
        policyVersion: 3,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.current,
        supersedesPolicyId: second.id,
        revokedKeyIds: ['retired-key', keysA.current],
        revocationEpoch: 2,
      }),
      { code: '23514', message: 'cannot select a revoked signing key' },
    );
  });

  test('requires exact approval quorum and keeps approved evidence and policy content immutable', async () => {
    const checksum = '6'.repeat(64);
    const policy = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: approvalFailureFacility,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      checksum,
    });
    const invalidApproval = await createApproval(client, {
      tenantId: tenantA,
      policyId: policy.id,
      checksum,
      approvers: approversA,
      requiredApprovers: 0,
    });
    await expectFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_policy_versions
            SET lifecycle_state = 'approved',
                approval_id = $1::integer,
                approved_by = $2::uuid,
                approved_at = $3::timestamptz
          WHERE tenant_id = $4::uuid AND id = $5::uuid`,
        [
          invalidApproval.id,
          approversA[0],
          invalidApproval.decidedAt,
          tenantA,
          policy.id,
        ],
      ),
      { code: '23514', message: 'invalid approval' },
    );

    await setTenant(client, tenantA);
    await expectFailure(
      client,
      () => client.query(
        `UPDATE approvals
            SET metadata = metadata || '{"tampered":true}'::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantA, activePolicyA.approvalId],
      ),
      { code: 'P0001', message: 'approval evidence is immutable' },
    );
    await expectFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_policy_versions
            SET policy_document = policy_document || '{"tampered":true}'::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantA, activePolicyA.id],
      ),
      { code: 'P0001', message: 'content and version identity are immutable' },
    );
    await expectFailure(
      client,
      () => client.query(
        `UPDATE clinical_continuity_policy_versions
            SET current_pack_signing_public_key_sha256 = $1::char(64)
          WHERE tenant_id = $2::uuid AND id = $3::uuid`,
        ['d'.repeat(64), tenantA, activePolicyA.id],
      ),
      { code: 'P0001', message: 'content and version identity are immutable' },
    );
    await expectFailure(
      client,
      () => client.query(
        `DELETE FROM clinical_continuity_policy_versions
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantA, activePolicyA.id],
      ),
      { code: 'P0001', message: 'append-only' },
    );
  });

  test('rejects same-key-ID public-key substitution at activation and publication', async () => {
    const facility = await seedFacility(client, tenantA, 'key-binding');
    const checksum = '8'.repeat(64);
    const draft = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: facility,
      policyKeyId: keysA.policy,
      currentKeyId: keysA.current,
      nextKeyId: keysA.next,
      checksum,
    });

    await expectFailure(
      client,
      async () => {
        await setTenant(client, tenantA);
        await client.query(
          `UPDATE encryption_keys
              SET metadata = jsonb_set(
                    metadata,
                    '{public_key_spki_pem}',
                    to_jsonb($1::text),
                    TRUE
                  )
            WHERE tenant_id = $2::uuid AND key_id = $3::text`,
          [continuityPublicKeyPem(`substituted-${token()}`), tenantA, keysA.policy],
        );
        await approveAndActivatePolicy(client, {
          tenantId: tenantA,
          policy: draft,
          checksum,
          approvers: approversA,
        });
      },
      { code: '23514', message: 'unusable or revoked signing key' },
    );

    for (const [signingKeyId, manifestVersion] of [
      [keysA.current, 80],
      [keysA.next, 81],
    ]) {
      await expectFailure(
        client,
        async () => {
          await setTenant(client, tenantA);
          await client.query(
            `UPDATE encryption_keys
                SET metadata = jsonb_set(
                      metadata,
                      '{public_key_spki_pem}',
                      to_jsonb($1::text),
                      TRUE
                    )
              WHERE tenant_id = $2::uuid AND key_id = $3::text`,
            [
              continuityPublicKeyPem(`substituted-${token()}`),
              tenantA,
              signingKeyId,
            ],
          );
          await insertSnapshot(client, {
            tenantId: tenantA,
            facilityId: facilityA,
            wardId: wardA,
            locationType: 'ward',
            policyId: activePolicyA.id,
            signingKeyId,
            manifestVersion,
          });
        },
        { code: '23514', message: 'unusable or compromised' },
      );
    }
  });

  test.each([
    ['ward', true],
    ['paeds', true],
    ['ed_board', false],
    ['opd_day', false],
  ])('accepts governed %s publication evidence with canonical location binding', async (
    locationType,
    needsWard,
  ) => {
    const result = await insertSnapshot(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      wardId: needsWard ? wardA : null,
      locationType,
      policyId: activePolicyA.id,
      signingKeyId: locationType === 'paeds' ? keysA.next : keysA.current,
      manifestVersion: {
        ward: 10,
        paeds: 11,
        ed_board: 12,
        opd_day: 13,
      }[locationType],
    });
    expect(result.rowCount).toBe(1);
  });

  test('supports current/next overlap while refusing new signatures from a retiring current key', async () => {
    await client.query('SAVEPOINT cc_rotation_overlap');
    try {
      await setTenant(client, tenantA);
      await client.query(
        `UPDATE encryption_keys
            SET status = 'retiring', retiring_at = NOW()
          WHERE tenant_id = $1::uuid AND key_id = $2::text`,
        [tenantA, keysA.current],
      );
      await expectFailure(
        client,
        () => insertSnapshot(client, {
          tenantId: tenantA,
          facilityId: facilityA,
          wardId: wardA,
          locationType: 'ward',
          policyId: activePolicyA.id,
          signingKeyId: keysA.current,
          manifestVersion: 14,
        }),
        { code: '23514', message: 'unusable or compromised' },
      );
      await expect(insertSnapshot(client, {
        tenantId: tenantA,
        facilityId: facilityA,
        wardId: wardA,
        locationType: 'ward',
        policyId: activePolicyA.id,
        signingKeyId: keysA.next,
        manifestVersion: 15,
      })).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT cc_rotation_overlap');
      await client.query('RELEASE SAVEPOINT cc_rotation_overlap');
    }
  });

  test('allows exact terminal retirement after the selected key is compromised', async () => {
    await client.query('SAVEPOINT cc_compromised_retirement');
    try {
      const facility = await seedFacility(client, tenantA, 'compromised-retirement');
      const checksum = '7'.repeat(64);
      const draft = await insertDraftPolicy(client, {
        tenantId: tenantA,
        facilityId: facility,
        policyKeyId: keysA.policy,
        currentKeyId: keysA.unlisted,
        checksum,
      });
      const active = await approveAndActivatePolicy(client, {
        tenantId: tenantA,
        policy: draft,
        checksum,
        approvers: approversA,
      });
      await client.query(
        `UPDATE encryption_keys
            SET status = 'compromised'
          WHERE tenant_id = $1::uuid AND key_id = $2::text`,
        [tenantA, keysA.unlisted],
      );
      const retiredAt = new Date();
      await client.query(
        "SELECT set_config('app.clinical_continuity_activation_bypass', 'migration_or_test', true)",
      );
      const retired = await client.query(
        `UPDATE clinical_continuity_policy_versions
            SET lifecycle_state = 'retired',
                retired_by = $1::uuid,
                retired_at = $2::timestamptz,
                retirement_reason = 'selected signing key compromised',
                effective_until = $2::timestamptz
          WHERE tenant_id = $3::uuid AND id = $4::uuid
          RETURNING lifecycle_state`,
        [approversA[0], retiredAt, tenantA, active.id],
      );
      await client.query(
        "SELECT set_config('app.clinical_continuity_activation_bypass', '', true)",
      );
      expect(retired.rows).toEqual([{ lifecycle_state: 'retired' }]);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT cc_compromised_retirement');
      await client.query('RELEASE SAVEPOINT cc_compromised_retirement');
    }
  });

  test('rejects draft policy, unlisted/compromised key, legacy location aliases, bad expiry, and bad signature', async () => {
    const base = {
      tenantId: tenantA,
      facilityId: facilityA,
      wardId: wardA,
      locationType: 'ward',
      policyId: activePolicyA.id,
      signingKeyId: keysA.current,
    };
    await expectFailure(
      client,
      () => insertSnapshot(client, { ...base, signingKeyId: keysA.unlisted }),
      { code: '23514', message: 'not authorized by policy' },
    );
    await expectFailure(
      client,
      () => insertSnapshot(client, {
        ...base,
        facilityId: draftFacility,
        policyId: draftPolicyA.id,
      }),
      { code: '23514', message: 'current effective policy' },
    );
    await expectFailure(
      client,
      () => insertSnapshot(client, {
        ...base,
        wardId: null,
        locationType: 'ed',
      }),
      { code: '23514', constraint: 'downtime_snapshots_continuity_location_check' },
    );
    const generatedAt = new Date();
    await expectFailure(
      client,
      () => insertSnapshot(client, {
        ...base,
        generatedAt,
        expiresAt: new Date(generatedAt.getTime() + 25 * 60 * 60 * 1000),
      }),
      { code: '23514', constraint: 'downtime_snapshots_continuity_time_check' },
    );
    await expectFailure(
      client,
      () => insertSnapshot(client, {
        ...base,
        wardId: wardInOtherFacility,
      }),
      { code: '23503', constraint: 'fk_downtime_snapshots_ward_facility_tenant' },
    );
    await expectFailure(
      client,
      () => insertSnapshot(client, { ...base, signature: Buffer.alloc(63) }),
      { code: '23514', constraint: 'downtime_snapshots_continuity_hash_check' },
    );
    await expectFailure(
      client,
      async () => {
        await setTenant(client, tenantA);
        await client.query(
          `UPDATE encryption_keys
              SET status = 'compromised'
            WHERE tenant_id = $1::uuid AND key_id = $2::text`,
          [tenantA, keysA.current],
        );
        await insertSnapshot(client, base);
      },
      { code: '23514', message: 'unusable or compromised' },
    );
  });

  test('keeps publication evidence append-only and permits only governed post-retention payload purge', async () => {
    const current = await insertSnapshot(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      wardId: wardA,
      locationType: 'ward',
      policyId: activePolicyA.id,
      signingKeyId: keysA.current,
      manifestVersion: 20,
    });
    const currentId = Number(current.rows[0].id);
    await expectFailure(
      client,
      () => client.query(
        `UPDATE downtime_snapshots
            SET payload = '{"tampered":true}'::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantA, currentId],
      ),
      { code: 'P0001', message: 'immutable except' },
    );
    await expectFailure(
      client,
      () => client.query(
        `DELETE FROM downtime_snapshots
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantA, currentId],
      ),
      { code: 'P0001', message: 'cannot be deleted' },
    );

    const generatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const historical = await insertSnapshot(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      wardId: wardA,
      locationType: 'ward',
      policyId: activePolicyA.id,
      signingKeyId: keysA.current,
      manifestVersion: 21,
      generatedAt,
      publishedAt: new Date(generatedAt.getTime() + 60 * 1000),
      expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000),
      retentionUntil: new Date(Date.now() - 60 * 60 * 1000),
    });
    const historicalId = Number(historical.rows[0].id);
    const purged = await client.query(
      `SELECT clinical_continuity_purge_snapshot_payload(
        $1::uuid, $2::integer, $3::integer, 'approved retention elapsed'
      ) AS id`,
      [tenantA, facilityA, historicalId],
    );
    expect(Number(purged.rows[0].id)).toBe(historicalId);
    const evidence = await client.query(
      `SELECT payload, payload_purged_at IS NOT NULL AS purged,
              payload_purge_reason
         FROM downtime_snapshots
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantA, historicalId],
    );
    expect(evidence.rows[0]).toEqual({
      payload: {},
      purged: true,
      payload_purge_reason: 'approved retention elapsed',
    });
  });

  test('fails closed for unset, bypass, and cross-tenant non-owner worker context', async () => {
    if (!rlsRoleReady) {
      throw new Error(
        `${RLS_TEST_ROLE} must exist as a granted NOSUPERUSER NOBYPASSRLS role`,
      );
    }
    await client.query('SAVEPOINT cc_worker_scope');
    await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);

    await setTenant(client, tenantA);
    const tenantVisible = await client.query(
      `SELECT DISTINCT tenant_id::text
         FROM clinical_continuity_policy_versions
        ORDER BY tenant_id::text`,
    );
    expect(tenantVisible.rows).toEqual([{ tenant_id: tenantA }]);
    const c3Snapshot = await client.query(
      `SELECT id
         FROM downtime_snapshots
        WHERE tenant_id = $1::uuid
          AND scope = 'clinical_continuity_pack'
        ORDER BY id
        LIMIT 1`,
      [tenantA],
    );
    await expectFailure(
      client,
      () => client.query(
        `DELETE FROM downtime_snapshots
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantA, c3Snapshot.rows[0].id],
      ),
      { code: 'P0001', message: 'cannot be deleted' },
    );

    await setTenant(client, 'bypass');
    const bypassVisible = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM clinical_continuity_policy_versions) AS policies,
         (SELECT COUNT(*)::integer FROM downtime_snapshots
           WHERE scope = 'clinical_continuity_pack') AS snapshots`,
    );
    expect(bypassVisible.rows[0]).toEqual({ policies: 0, snapshots: 0 });

    await setTenant(client, '');
    const unsetVisible = await client.query(
      'SELECT COUNT(*)::integer AS count FROM clinical_continuity_policy_versions',
    );
    expect(unsetVisible.rows[0].count).toBe(0);

    await expectFailure(
      client,
      () => insertSnapshot(client, {
        contextTenantId: tenantA,
        tenantId: tenantB,
        facilityId: facilityB,
        wardId: null,
        locationType: 'ed_board',
        policyId: activePolicyB.id,
        signingKeyId: keysB.current,
      }),
      { code: '42501', message: 'row-level security policy' },
    );

    await client.query('ROLLBACK TO SAVEPOINT cc_worker_scope');
    await client.query('RELEASE SAVEPOINT cc_worker_scope');
  });

  test('pins least-privilege production role and sequence grants when the roles exist', async () => {
    const roles = await client.query(
      `SELECT rolname
         FROM pg_roles
        WHERE rolname IN ('vhhealth_app', 'vhhealth_runtime')
        ORDER BY rolname`,
    );
    if (roles.rows.length !== 2) {
      expect(migrationSql).toContain(
        "ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]",
      );
      return;
    }
    const privileges = await client.query(
      `SELECT
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_policy_versions', 'SELECT'
         ) AS policy_select,
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_policy_versions', 'INSERT'
         ) AS policy_insert,
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_policy_versions', 'UPDATE'
         ) AS policy_update,
         has_table_privilege(
           'vhhealth_runtime', 'downtime_snapshots', 'INSERT'
         ) AS snapshot_insert,
         has_table_privilege(
           'vhhealth_runtime', 'downtime_snapshots', 'UPDATE'
         ) AS snapshot_update,
         has_table_privilege(
           'vhhealth_runtime', 'downtime_snapshots', 'DELETE'
         ) AS legacy_snapshot_delete,
         has_sequence_privilege(
           'vhhealth_runtime', 'downtime_snapshots_id_seq', 'USAGE'
         ) AS snapshot_sequence_usage,
         has_sequence_privilege(
           'vhhealth_runtime', 'clinical_continuity_manifest_version_seq', 'USAGE'
         ) AS manifest_sequence_usage,
         has_function_privilege(
           'vhhealth_runtime', 'clinical_continuity_assert_snapshot_governance()', 'EXECUTE'
         ) AS can_call_governance,
         has_function_privilege(
           'vhhealth_runtime',
           'clinical_continuity_purge_snapshot_payload(uuid,integer,integer,text)',
           'EXECUTE'
         ) AS can_purge`,
    );
    expect(privileges.rows[0]).toEqual({
      policy_select: true,
      policy_insert: false,
      policy_update: false,
      snapshot_insert: true,
      snapshot_update: false,
      legacy_snapshot_delete: true,
      snapshot_sequence_usage: true,
      manifest_sequence_usage: true,
      can_call_governance: false,
      can_purge: false,
    });
  });
});
