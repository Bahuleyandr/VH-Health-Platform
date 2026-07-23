import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  runCarePathwayReconciliationForTenantPathway,
} from '../services/pathways/pathwayReconciliationService.js';
import {
  createPathwayReconciliationRegistry,
  pathwayReconciliationRegistry,
} from '../services/pathways/pathwayReconciliationRegistry.js';
import { compileDiagnosticsOrderToActionDefinition } from '../services/pathways/diagnosticsPathwayDefinition.js';
import {
  CANONICAL_PATHWAY_KEYS,
  CARE_PATHWAY_KEYS,
} from '../services/pathways/pathwayMode.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedUser(client, tenantId, role) {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
             TRUE, 'active', FALSE, NOW())`,
    [uid, tenantId, `Reconciliation ${role} ${token()}`, role],
  );
  return uid;
}

async function setMode(client, tenantId, pathwayKey, mode) {
  await client.query(
    `UPDATE tenants
        SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object(
               'care_pathways',
               COALESCE(settings -> 'care_pathways', '{}'::jsonb)
               || jsonb_build_object($2::text, $3::text)
             )
      WHERE id = $1::uuid`,
    [tenantId, pathwayKey, mode],
  );
}

function buildRegistry(tuple, { throwFromCommon = false, version = 1 } = {}) {
  const commonCheck = {
    id: 'test_common_integrity',
    handlerVersion: `test.common_integrity.v${version}`,
    run: async () => {
      if (throwFromCommon) throw new Error('synthetic PHI-like database failure');
      return { code: 'TEST_COMMON_INTEGRITY', finding_count: 0 };
    },
  };
  const domainCheck = {
    id: 'test_diagnostics_closure',
    handlerVersion: `test.diagnostics_closure.v${version}`,
    run: async () => ({ code: 'TEST_DIAGNOSTICS_CLOSURE', finding_count: 0 }),
  };
  const profiles = CANONICAL_PATHWAY_KEYS.map((pathwayKey) => ({
    pathwayKey,
    profileVersion: version,
    commonCheckIds: [commonCheck.id],
    domainAdapters: pathwayKey === CARE_PATHWAY_KEYS.DIAGNOSTICS
      ? [{
          adapterId: 'test_diagnostics_adapter',
          adapterVersion: `test.diagnostics_adapter.v${version}`,
          workflowKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
          definitionVersion: tuple.definitionVersion,
          definitionChecksum: tuple.definitionChecksum,
          checks: [domainCheck],
        }]
      : [],
    repairDescriptors: [],
    excludedClocks: [],
    blockingReason: pathwayKey === CARE_PATHWAY_KEYS.DIAGNOSTICS
      ? null
      : 'test_vertical_adapter_pending',
  }));
  return createPathwayReconciliationRegistry({
    version,
    commonChecks: [commonCheck],
    profiles,
  });
}

describeIfDb('care pathway reconciliation transaction', () => {
  let client;
  let tenantId;
  let tuple;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    tenantId = randomUUID();
    await client.query(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Reconciliation service test',
               jsonb_build_object(
                 'care_pathways',
                 jsonb_build_object($3::text, 'off')
               ))`,
      [tenantId, `reconciliation-service-${token()}`, CARE_PATHWAY_KEYS.DIAGNOSTICS],
    );
    const clinicalOwner = await seedUser(client, tenantId, 'DOCTOR');
    const operationalOwner = await seedUser(client, tenantId, 'ADMIN');
    const approver = await seedUser(client, tenantId, 'SUPER_ADMIN');
    const definition = await client.query(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name,
          steps, triggers, defaults, is_active)
       VALUES ($1::uuid, $2::text, 1, 'Reconciliation diagnostics test',
               '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, TRUE)
       RETURNING id`,
      [tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS],
    );
    const definitionChecksum = compileDiagnosticsOrderToActionDefinition().checksum;
    const decidedAt = new Date('2026-07-21T10:00:00.000Z');
    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, status, approved_by, decided_by, decided_at, metadata)
       VALUES ($1::uuid, 'care_pathway_definition_governance',
               'care_pathway_definition', $2::text, 1, 'approved',
               $3::jsonb, $4::uuid, $5::timestamptz,
               jsonb_build_object(
                 'care_pathway_definition_governance',
                 jsonb_build_object('definition_checksum', $6::text)
               ))
       RETURNING id`,
      [
        tenantId,
        String(definition.rows[0].id),
        JSON.stringify([{ uid: approver, at: decidedAt.toISOString() }]),
        approver,
        decidedAt,
        definitionChecksum,
      ],
    );
    const governance = await client.query(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid,
          operational_owner_uid, governance_status, approval_id,
          approved_by, approved_at, patient_visibility_policy_ref,
          definition_checksum)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid,
               'approved', $5::integer, $6::uuid,
               $7::timestamptz, 'staff_after_signoff', $8::char(64))
       RETURNING id`,
      [
        tenantId,
        definition.rows[0].id,
        clinicalOwner,
        operationalOwner,
        approval.rows[0].id,
        approver,
        new Date('2026-07-21T10:01:00.000Z'),
        definitionChecksum,
      ],
    );
    tuple = {
      governanceId: governance.rows[0].id,
      workflowDefinitionId: definition.rows[0].id,
      definitionVersion: 1,
      definitionChecksum,
    };
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  test('off performs no observation or evidence insert', async () => {
    const before = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const observation = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry: buildRegistry(tuple),
    });
    expect(observation).toMatchObject({ skipped: 'off' });
    const after = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  test('writes a clean shadow receipt once and deduplicates the same sweep', async () => {
    await setMode(client, tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS, 'shadow');
    const registry = buildRegistry(tuple);
    const sweepId = randomUUID();
    const first = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      sweepId,
      registry,
    });
    expect(first).toMatchObject({
      pathway_mode: 'shadow',
      registry_checksum: registry.checksum,
      registry_complete: true,
      finding_count: 0,
      repair_count: 0,
      error_count: 0,
      passed: true,
    });
    const duplicate = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      sweepId,
      registry,
    });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    const rows = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid AND sweep_id = $2::uuid`,
      [tenantId, sweepId],
    );
    expect(rows.rows[0].count).toBe(1);
  });

  test('matches the production Diagnostics adapter independently of tenant-generated ids', async () => {
    await setMode(client, tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS, 'shadow');
    const observation = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry: pathwayReconciliationRegistry,
    });
    expect(observation).toMatchObject({
      pathway_mode: 'shadow',
      registry_complete: true,
      error_count: 0,
    });
    const persisted = await client.query(
      `SELECT governance_count, covered_governance_count,
              expected_check_count, executed_check_count, error_count
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, observation.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      governance_count: 1,
      covered_governance_count: 1,
      expected_check_count: 16,
      executed_check_count: 16,
      error_count: 0,
    });
  });

  test('active fails closed without running checks or mutating tenant mode', async () => {
    await setMode(client, tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS, 'active');
    const registry = buildRegistry(tuple);
    const observation = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry,
    });
    expect(observation).toMatchObject({
      pathway_mode: 'active',
      registry_complete: false,
      error_count: 1,
      passed: false,
    });
    const mode = await client.query(
      `SELECT settings #>> ARRAY['care_pathways', $2::text] AS mode
         FROM tenants WHERE id = $1::uuid`,
      [tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS],
    );
    expect(mode.rows[0].mode).toBe('active');
  });

  test('rolls back a failed observation and appends only a sanitized technical receipt', async () => {
    await setMode(client, tenantId, CARE_PATHWAY_KEYS.DIAGNOSTICS, 'shadow');
    const observation = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry: buildRegistry(tuple, { throwFromCommon: true, version: 2 }),
    });
    expect(observation).toMatchObject({
      pathway_mode: 'shadow',
      registry_complete: false,
      finding_count: 0,
      repair_count: 0,
      error_count: 1,
      passed: false,
    });
    const evidence = await client.query(
      `SELECT check_results
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, observation.id],
    );
    expect(evidence.rows[0].check_results).toEqual([{
      code: 'RECONCILIATION_TECHNICAL_ERROR',
      finding_count: 0,
      repair_count: 0,
      error_count: 1,
    }]);
    expect(JSON.stringify(evidence.rows[0].check_results)).not.toContain('synthetic PHI-like');
  });

  test('registry-version changes create a different evidence cohort', async () => {
    const firstRegistry = buildRegistry(tuple, { version: 1 });
    const secondRegistry = buildRegistry(tuple, { version: 2 });
    expect(firstRegistry.checksum).not.toBe(secondRegistry.checksum);
    const first = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry: firstRegistry,
    });
    const second = await runCarePathwayReconciliationForTenantPathway({
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
      registry: secondRegistry,
    });
    expect(first.registry_checksum).not.toBe(second.registry_checksum);
    expect(first.governance_checksum).toBe(second.governance_checksum);
  });
});
