import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  activateLabThresholdPolicyBundle,
  addLabThresholdCatalogEntry,
  approveLabThresholdPolicyBundle,
  createLabThresholdPolicyBundle,
  replaceLabThresholdPolicyRules,
  submitLabThresholdPolicyBundle,
} from '../services/lab/labThresholdGovernanceService.js';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('lab threshold governance service lifecycle', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const authorUid = randomUUID();
  const approverUid = randomUUID();
  const activatorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let facilityId;

  beforeAll(async () => {
    await client.connect();
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Lab threshold service lifecycle test')`,
      [tenantId, `lab-threshold-service-${suffix}`],
    );
    await client.query(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
       VALUES
         ($1::uuid, $4::uuid, 'Policy author', 'ADMIN', TRUE, 'active', FALSE, NOW()),
         ($2::uuid, $4::uuid, 'Clinical approver', 'PATHOLOGIST', TRUE, 'active', FALSE, NOW()),
         ($3::uuid, $4::uuid, 'Policy activator', 'SUPER_ADMIN', TRUE, 'active', FALSE, NOW())`,
      [authorUid, approverUid, activatorUid, tenantId],
    );
    const facilities = await client.query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, created_by)
       VALUES ($1::uuid, $2, 'Lab threshold service lifecycle test', 'active', $3::uuid)
       RETURNING id`,
      [tenantId, `safe01-service-${suffix}`, authorUid],
    );
    facilityId = facilities.rows[0].id;
  });

  afterAll(async () => {
    const role = await client.query(
      `SELECT rolsuper
         FROM pg_roles
        WHERE rolname = current_user`,
    ).catch(() => ({ rows: [] }));
    if (role.rows[0]?.rolsuper) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await client.query('DELETE FROM audit_logs WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query(
          'DELETE FROM lab_threshold_policy_rules WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await client.query(
          'DELETE FROM lab_threshold_policy_bundles WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await client.query(
          'DELETE FROM lab_threshold_catalog_entries WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await client.query(
          'DELETE FROM lab_threshold_catalog_states WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await client.query('DELETE FROM facilities WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM users WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM tenants WHERE id = $1::uuid', [tenantId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    await client.end();
  });

  test('rejects stale authority and completes the four-eyes activation workflow', async () => {
    await expect(addLabThresholdCatalogEntry({
      tenantId,
      facilityId,
      actorUid: authorUid,
      actorRole: 'SUPER_ADMIN',
      entry: {
        test_code: 'K',
        loinc_code: '2823-3',
        test_name: 'Potassium',
        specimen_type: 'serum',
        evaluation_mode: 'numeric_threshold',
        unit: 'mmol/L',
        criticality_required: true,
      },
    })).rejects.toMatchObject({ code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN' });

    const catalog = await addLabThresholdCatalogEntry({
      tenantId,
      facilityId,
      actorUid: authorUid,
      actorRole: 'ADMIN',
      entry: {
        test_code: 'K',
        loinc_code: '2823-3',
        test_name: 'Potassium',
        specimen_type: 'serum',
        evaluation_mode: 'numeric_threshold',
        unit: 'mmol/L',
        criticality_required: true,
      },
    });
    expect(catalog.current_revision).toBe(1);

    const bundle = await createLabThresholdPolicyBundle({
      tenantId,
      facilityId,
      actorUid: authorUid,
      actorRole: 'ADMIN',
    });
    const coverage = await replaceLabThresholdPolicyRules({
      tenantId,
      bundleId: bundle.id,
      actorUid: authorUid,
      actorRole: 'ADMIN',
      rules: [{
        catalog_entry_id: catalog.entry.id,
        reference_low: 3.5,
        reference_high: 5.1,
        critical_low: 2.5,
        critical_high: 6.5,
      }],
    });
    expect(coverage.blockers).toEqual([]);

    const submitted = await submitLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: authorUid,
      actorRole: 'ADMIN',
      sourceReference: 'signed-test-policy-source',
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(submitted.lifecycle_status).toBe('in_review');

    await expect(approveLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: authorUid,
      actorRole: 'PATHOLOGIST',
      reason: 'Spoofed pathologist role must not authorize approval.',
      evidenceReference: 'signed-test-evidence',
      evidenceSha256: 'e'.repeat(64),
    })).rejects.toMatchObject({ code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN' });

    const approved = await approveLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: approverUid,
      actorRole: 'PATHOLOGIST',
      reason: 'Independent clinical review completed for the test fixture.',
      evidenceReference: 'signed-test-evidence',
      evidenceSha256: 'e'.repeat(64),
    });
    expect(approved.lifecycle_status).toBe('approved');
    expect(String(approved.approved_by)).toBe(approverUid);

    await expect(activateLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: approverUid,
      actorRole: 'PATHOLOGIST',
      reason: 'Clinical approval does not confer release authority.',
    })).rejects.toMatchObject({ code: 'CURRENT_HUMAN_ACTOR_FORBIDDEN' });

    await client.query(
      `UPDATE users SET role = 'SUPER_ADMIN', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, approverUid],
    );
    await expect(activateLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: approverUid,
      actorRole: 'SUPER_ADMIN',
      reason: 'A role change must not collapse clinical approval and release authority.',
    })).rejects.toMatchObject({ code: 'LAB_THRESHOLD_DISTINCT_ACTIVATOR_REQUIRED' });
    await client.query(
      `UPDATE users SET role = 'PATHOLOGIST', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, approverUid],
    );

    const activated = await activateLabThresholdPolicyBundle({
      tenantId,
      bundleId: bundle.id,
      actorUid: activatorUid,
      actorRole: 'SUPER_ADMIN',
      reason: 'Authorized test activation after independent clinical approval.',
    });
    expect(activated).toMatchObject({
      previous_bundle_id: null,
      replayed: false,
      bundle: {
        id: bundle.id,
        lifecycle_status: 'active',
        activated_by: activatorUid,
      },
    });

    const audits = await client.query(
      `SELECT action, actor_uid, role
         FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND resource IN ('lab_threshold_catalog_entries', 'lab_threshold_policy_bundles')
        ORDER BY created_at, id`,
      [tenantId],
    );
    expect(audits.rows).toEqual([
      { action: 'LAB_THRESHOLD_CATALOG_ENTRY_ADDED', actor_uid: authorUid, role: 'ADMIN' },
      { action: 'LAB_THRESHOLD_POLICY_BUNDLE_CREATED', actor_uid: authorUid, role: 'ADMIN' },
      { action: 'LAB_THRESHOLD_POLICY_RULES_REPLACED', actor_uid: authorUid, role: 'ADMIN' },
      { action: 'LAB_THRESHOLD_POLICY_BUNDLE_SUBMITTED', actor_uid: authorUid, role: 'ADMIN' },
      { action: 'LAB_THRESHOLD_POLICY_BUNDLE_APPROVED', actor_uid: approverUid, role: 'PATHOLOGIST' },
      { action: 'LAB_THRESHOLD_POLICY_BUNDLE_ACTIVATED', actor_uid: activatorUid, role: 'SUPER_ADMIN' },
    ]);
  });
});
