import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/602_clinical_continuity_action_registry.sql', import.meta.url),
  'utf8'
);
const RLS_TEST_ROLE = 'rls_test_app';

function token() {
  return randomUUID().replaceAll('-', '');
}

function publicKeyPem(keyId) {
  return [
    '-----BEGIN PUBLIC KEY-----',
    Buffer.from(keyId, 'utf8').toString('base64'),
    '-----END PUBLIC KEY-----'
  ].join('\n');
}

function publicKeySha256(keyId) {
  return createHash('sha256').update(publicKeyPem(keyId), 'utf8').digest('hex');
}

async function setTenant(client, tenantId) {
  await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [
    tenantId
  ]);
}

async function expectFailure(client, operation, expectedText) {
  await client.query('SAVEPOINT expected_c4_2_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c4_2_failure');
  await client.query('RELEASE SAVEPOINT expected_c4_2_failure');
  expect(failure).toBeDefined();
  expect(failure.message).toContain(expectedText);
}

async function seedTenant(client, label) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `c4-2-${label}-${token()}`.slice(0, 60), `C4.2 ${label}`]
  );
  return tenantId;
}

async function seedFacility(client, tenantId, label) {
  const result = await client.query(
    `INSERT INTO facilities
       (tenant_id, facility_code, display_name, timezone)
     VALUES ($1::uuid, $2::text, $3::text, 'Asia/Kolkata')
     RETURNING id`,
    [tenantId, `C42-${label}-${token()}`.slice(0, 70), `C4.2 facility ${label}`]
  );
  return Number(result.rows[0].id);
}

async function seedKeys(client, tenantId, label) {
  const policyKey = `c42-policy-${label}-${token()}`.slice(0, 64);
  const packKey = `c42-pack-${label}-${token()}`.slice(0, 64);
  for (const [keyId, purpose] of [
    [policyKey, 'clinical_continuity_policy_signing'],
    [packKey, 'clinical_continuity_pack_signing']
  ]) {
    await setTenant(client, tenantId);
    await client.query(
      `INSERT INTO encryption_keys
         (tenant_id, key_id, provider, algorithm, status, metadata)
       VALUES
         ($1::uuid, $2::text, 'env', 'ed25519', 'active',
          jsonb_build_object(
            'purpose', $3::text,
            'public_key_spki_pem', $4::text
          ))`,
      [tenantId, keyId, purpose, publicKeyPem(keyId)]
    );
  }
  return { policyKey, packKey };
}

function actionRegistryDocument({
  tenantId,
  facilityId,
  registryVersion,
  registryChecksum,
  effectiveFrom,
  effectiveUntil
}) {
  return {
    actionRegistry: {
      actions: Array.from({ length: 17 }, (_, index) => ({ actionId: `test.${index}` })),
      activation: { enforcedActionIds: [], mode: 'shadow' },
      approvalEvidence: {
        countersignedAt: '2026-07-30',
        decisionId: 'C-D3',
        source:
          'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
      },
      audience: { devicePostures: ['desktop'] },
      compatibilityRules: [],
      expiresAt: effectiveUntil.toISOString(),
      issuedAt: effectiveFrom.toISOString(),
      minimumAppVersions: { desktop: '1.0.0', tablet: '1.0.0' },
      registryChecksum,
      registrySchemaVersion: 1,
      registryVersion: String(registryVersion)
    },
    audience: {
      tenantId,
      facilityId: String(facilityId)
    },
    policySchemaVersion: 3
  };
}

async function insertDraftPolicy(client, {
  tenantId,
  facilityId,
  keys,
  policyVersion = 1,
  policySchemaVersion = 1,
  supersedesPolicyId = null,
  actionRegistryVersion = null,
  actionRegistryChecksum = null
}) {
  await setTenant(client, tenantId);
  const effectiveFrom = new Date('2026-07-30T00:00:00.000Z');
  const effectiveUntil =
    policySchemaVersion === 3 ? new Date('2026-08-30T00:00:00.000Z') : null;
  const policyDocument =
    policySchemaVersion === 3
      ? actionRegistryDocument({
          tenantId,
          facilityId,
          registryVersion: actionRegistryVersion,
          registryChecksum: actionRegistryChecksum,
          effectiveFrom,
          effectiveUntil
        })
      : {
          audience: { tenantId, facilityId: String(facilityId) },
          policySchemaVersion
        };
  const result = await client.query(
    `INSERT INTO clinical_continuity_policy_versions
       (tenant_id, facility_id, policy_version, policy_schema_version,
        action_registry_schema_version, action_registry_version,
        action_registry_checksum, policy_document, policy_checksum,
        policy_signing_key_id, policy_signing_public_key_sha256,
        current_pack_signing_key_id, current_pack_signing_public_key_sha256,
        policy_signature, effective_from, effective_until,
        supersedes_policy_id)
     VALUES
       ($1::uuid, $2::integer, $3::bigint, $4::integer,
        $5::integer, $6::bigint, $7::char(64), $8::jsonb, $9::char(64),
        $10::text, $11::char(64), $12::text, $13::char(64),
        $14::bytea, $15::timestamptz, $16::timestamptz, $17::uuid)
     RETURNING id::text`,
    [
      tenantId,
      facilityId,
      policyVersion,
      policySchemaVersion,
      policySchemaVersion === 3 ? 1 : null,
      actionRegistryVersion,
      actionRegistryChecksum,
      JSON.stringify(policyDocument),
      'd'.repeat(64),
      keys.policyKey,
      publicKeySha256(keys.policyKey),
      keys.packKey,
      publicKeySha256(keys.packKey),
      Buffer.alloc(64, 0x42),
      effectiveFrom,
      effectiveUntil,
      supersedesPolicyId
    ]
  );
  return result.rows[0].id;
}

describe('migration 602 static action-registry contract', () => {
  test('is one inert, route-neutral extension with no new table or seeded authority', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => name.startsWith('602_'));
    expect(names).toEqual(['602_clinical_continuity_action_registry.sql']);
    expect(migrationSql).toContain('-- @no-transaction');
    expect(migrationSql).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+clinical_continuity_policy_versions\b/i);
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS action_registry_version BIGINT');
    expect(migrationSql).toContain('jsonb_array_length');
    expect(migrationSql).toContain('= 17');
  });

  test('inherits and reasserts the strict C3.1 tenant and least-privilege posture', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE clinical_continuity_policy_versions FORCE ROW LEVEL SECURITY'
    );
    expect(migrationSql).toContain("polname = 'cc_policy_explicit_context'");
    expect(migrationSql).toContain('AND polpermissive = FALSE');
    expect(migrationSql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE'
    );
  });

  test('pins v3-only shape, monotonic versions, immutability, and approval evidence', () => {
    expect(migrationSql).toContain('policy_schema_version <> 3');
    expect(migrationSql).toContain('policy_schema_version = 3');
    expect(migrationSql).toContain(
      'clinical continuity action-registry version cannot roll back'
    );
    expect(migrationSql).toContain(
      'clinical continuity action-registry checksum changed without a new version'
    );
    expect(migrationSql).toContain(
      'clinical continuity action-registry binding is immutable'
    );
    expect(migrationSql).toContain('action_registry_decision_id');
    expect(migrationSql).toContain("IS DISTINCT FROM 'C-D3'");
  });
});

describeIfDb('migration 602 database action-registry contract', () => {
  let client;
  let tenantA;
  let tenantB;
  let facilityA;
  let facilityB;
  let keysA;
  let keysB;
  let v1PolicyId;
  let registryPolicyId;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    tenantA = await seedTenant(client, 'tenant-a');
    tenantB = await seedTenant(client, 'tenant-b');
    facilityA = await seedFacility(client, tenantA, 'a');
    facilityB = await seedFacility(client, tenantB, 'b');
    keysA = await seedKeys(client, tenantA, 'a');
    keysB = await seedKeys(client, tenantB, 'b');
    v1PolicyId = await insertDraftPolicy(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      keys: keysA
    });
    registryPolicyId = await insertDraftPolicy(client, {
      tenantId: tenantB,
      facilityId: facilityB,
      keys: keysB,
      policySchemaVersion: 3,
      actionRegistryVersion: 5,
      actionRegistryChecksum: 'a'.repeat(64)
    });
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('installs the columns, trigger set, tenant index, and inherited forced RLS', async () => {
    const posture = await client.query(
      `SELECT relation.relrowsecurity,
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
        WHERE relation.oid = 'clinical_continuity_policy_versions'::regclass
        GROUP BY relation.relrowsecurity, relation.relforcerowsecurity`
    );
    expect(posture.rows[0].relrowsecurity).toBe(true);
    expect(posture.rows[0].relforcerowsecurity).toBe(true);
    expect(posture.rows[0].policies).toContain('cc_policy_explicit_context');
    expect(posture.rows[0].triggers).toEqual(
      expect.arrayContaining([
        'trg_cc_action_registry_approval',
        'trg_cc_action_registry_immutable',
        'trg_cc_action_registry_version'
      ])
    );

    const columns = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'clinical_continuity_policy_versions'
          AND column_name LIKE 'action_registry_%'
        ORDER BY column_name`
    );
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'action_registry_checksum',
      'action_registry_schema_version',
      'action_registry_version'
    ]);
  });

  test('keeps v1/v2 incapable of carrying registry authority', async () => {
    const facility = await seedFacility(client, tenantA, 'legacy-registry');
    await expectFailure(
      client,
      () =>
        client.query(
          `INSERT INTO clinical_continuity_policy_versions
             (tenant_id, facility_id, policy_version, policy_schema_version,
              action_registry_schema_version, action_registry_version,
              action_registry_checksum, policy_document, policy_checksum,
              policy_signing_key_id, policy_signing_public_key_sha256,
              current_pack_signing_key_id, current_pack_signing_public_key_sha256,
              policy_signature, effective_from)
           VALUES
             ($1::uuid, $2::integer, 1, 2, 1, 1, $3::char(64),
              $4::jsonb, $5::char(64), $6::text, $7::char(64),
              $8::text, $9::char(64), $10::bytea, NOW())`,
          [
            tenantA,
            facility,
            'b'.repeat(64),
            JSON.stringify({
              actionRegistry: {},
              audience: { tenantId: tenantA, facilityId: String(facility) },
              policySchemaVersion: 2
            }),
            'c'.repeat(64),
            keysA.policyKey,
            publicKeySha256(keysA.policyKey),
            keysA.packKey,
            publicKeySha256(keysA.packKey),
            Buffer.alloc(64, 0x42)
          ]
        ),
      'cc_policy_action_registry_shape_check'
    );
  });

  test('rejects registry rollback, checksum reuse, and checksum mutation', async () => {
    await expectFailure(
      client,
      () =>
        insertDraftPolicy(client, {
          tenantId: tenantB,
          facilityId: facilityB,
          keys: keysB,
          policyVersion: 2,
          policySchemaVersion: 3,
          supersedesPolicyId: registryPolicyId,
          actionRegistryVersion: 4,
          actionRegistryChecksum: 'b'.repeat(64)
        }),
      'action-registry version cannot roll back'
    );
    await expectFailure(
      client,
      () =>
        insertDraftPolicy(client, {
          tenantId: tenantB,
          facilityId: facilityB,
          keys: keysB,
          policyVersion: 2,
          policySchemaVersion: 3,
          supersedesPolicyId: registryPolicyId,
          actionRegistryVersion: 5,
          actionRegistryChecksum: 'b'.repeat(64)
        }),
      'checksum changed without a new version'
    );
    await expectFailure(
      client,
      () =>
        insertDraftPolicy(client, {
          tenantId: tenantB,
          facilityId: facilityB,
          keys: keysB,
          policyVersion: 2,
          policySchemaVersion: 3,
          supersedesPolicyId: registryPolicyId,
          actionRegistryVersion: 6,
          actionRegistryChecksum: 'a'.repeat(64)
        }),
      'version changed without new content'
    );
  });

  test('fails closed for bypass and cross-tenant worker scope', async () => {
    const role = await client.query(
      `SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member,
              role.rolsuper, role.rolbypassrls
         FROM pg_roles AS role
        WHERE role.rolname = $1::name`,
      [RLS_TEST_ROLE]
    );
    if (
      role.rows.length !== 1 ||
      role.rows[0].member !== true ||
      role.rows[0].rolsuper !== false ||
      role.rows[0].rolbypassrls !== false
    ) {
      throw new Error(`${RLS_TEST_ROLE} must be a granted non-bypass test role`);
    }

    await client.query('SAVEPOINT c4_2_worker_scope');
    await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);
    await setTenant(client, tenantA);
    const own = await client.query(
      `SELECT id::text
         FROM clinical_continuity_policy_versions
        WHERE id = $1::uuid`,
      [v1PolicyId]
    );
    expect(own.rows).toEqual([{ id: v1PolicyId }]);

    await setTenant(client, tenantB);
    const crossTenant = await client.query(
      `SELECT id::text
         FROM clinical_continuity_policy_versions
        WHERE id = $1::uuid`,
      [v1PolicyId]
    );
    expect(crossTenant.rows).toEqual([]);

    await setTenant(client, 'bypass');
    const bypass = await client.query(
      'SELECT COUNT(*)::integer AS count FROM clinical_continuity_policy_versions'
    );
    expect(bypass.rows[0].count).toBe(0);

    const hiddenMutation = await client.query(
      `UPDATE clinical_continuity_policy_versions
          SET action_registry_version = 99
        WHERE id = $1::uuid`,
      [registryPolicyId]
    );
    expect(hiddenMutation.rowCount).toBe(0);
    await client.query('ROLLBACK TO SAVEPOINT c4_2_worker_scope');
    await client.query('RELEASE SAVEPOINT c4_2_worker_scope');
  });

  test('keeps production application roles read-only when present', async () => {
    const grants = await client.query(
      `SELECT role.rolname,
              has_table_privilege(
                role.rolname,
                'clinical_continuity_policy_versions',
                'SELECT'
              ) AS can_select,
              has_table_privilege(
                role.rolname,
                'clinical_continuity_policy_versions',
                'INSERT,UPDATE,DELETE,TRUNCATE'
              ) AS can_mutate
         FROM pg_roles AS role
        WHERE role.rolname IN ('vhhealth_app', 'vhhealth_runtime')
        ORDER BY role.rolname`
    );
    for (const row of grants.rows) {
      expect(row.can_select).toBe(true);
      expect(row.can_mutate).toBe(false);
    }
  });
});
