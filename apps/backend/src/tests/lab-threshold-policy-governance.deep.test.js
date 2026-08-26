import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

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

describeIfDb('lab threshold policy governance', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const authorUid = randomUUID();
  const approverUid = randomUUID();
  const activatorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let facilityId;
  let numericEntryId;
  let exemptEntryId;
  let firstBundleId;

  async function attempt(operation) {
    await client.query('SAVEPOINT lab_threshold_probe');
    let failure;
    let value;
    try {
      value = await operation();
    } catch (error) {
      failure = error;
    }
    if (failure) await client.query('ROLLBACK TO SAVEPOINT lab_threshold_probe');
    await client.query('RELEASE SAVEPOINT lab_threshold_probe');
    return { failure, value };
  }

  async function createBundle(version) {
    const rows = await client.query(
      `INSERT INTO lab_threshold_policy_bundles
         (tenant_id, facility_id, bundle_version, catalog_revision,
          lifecycle_status, created_by)
       VALUES ($1::uuid, $2::int, $3::int, 2, 'draft', $4::uuid)
       RETURNING id`,
      [tenantId, facilityId, version, authorUid],
    );
    return rows.rows[0].id;
  }

  async function addNumericRule(bundleId) {
    await client.query(
      `INSERT INTO lab_threshold_policy_rules
         (tenant_id, facility_id, bundle_id, catalog_entry_id,
          reference_low, reference_high, critical_low, critical_high, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid,
               3.5, 5.1, 2.5, 6.5, $5::uuid)`,
      [tenantId, facilityId, bundleId, numericEntryId, authorUid],
    );
  }

  async function submitAndApprove(bundleId, digestCharacter) {
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'in_review',
              source_reference = $3,
              content_sha256 = repeat($4, 64),
              effective_from = NOW() - INTERVAL '1 minute',
              submitted_by = $5::uuid,
              submitted_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, bundleId, `scratch-${digestCharacter}`, digestCharacter, authorUid],
    );
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'approved',
              approved_by = $3::uuid,
              approved_at = NOW(),
              approval_reason = 'Scratch clinical approval proof',
              approval_evidence_reference = 'scratch-evidence',
              approval_evidence_sha256 = repeat('e', 64)
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, bundleId, approverUid],
    );
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Lab threshold governance test')`,
      [tenantId, `lab-threshold-${suffix}`],
    );
    await client.query(
      `INSERT INTO users (uid, tenant_id, name, role, updated_at)
       VALUES
         ($1::uuid, $4::uuid, 'Policy author', 'ADMIN', NOW()),
         ($2::uuid, $4::uuid, 'Clinical approver', 'PATHOLOGIST', NOW()),
         ($3::uuid, $4::uuid, 'Policy activator', 'SUPER_ADMIN', NOW())`,
      [authorUid, approverUid, activatorUid, tenantId],
    );
    const facilities = await client.query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, created_by)
       VALUES ($1::uuid, $2, 'Lab threshold governance test', $3::uuid)
       RETURNING id`,
      [tenantId, `safe01-${suffix}`, authorUid],
    );
    facilityId = facilities.rows[0].id;
    await client.query(
      `INSERT INTO lab_threshold_catalog_states
         (tenant_id, facility_id, current_revision, updated_by)
       VALUES ($1::uuid, $2::int, 0, $3::uuid)`,
      [tenantId, facilityId, authorUid],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('installs the evidence triggers and validates every lab-result policy foreign key', async () => {
    const triggers = await client.query(
      `SELECT tgname
         FROM pg_trigger
        WHERE tgrelid IN (
          'lab_threshold_catalog_entries'::regclass,
          'lab_threshold_policy_rules'::regclass,
          'lab_threshold_policy_bundles'::regclass,
          'lab_results'::regclass,
          'lab_critical_alerts'::regclass,
          'lab_threshold_unmatched_exceptions'::regclass
        )
          AND NOT tgisinternal
          AND tgname IN (
            'trg_lab_threshold_catalog_entry_write',
            'trg_lab_threshold_policy_bundle_transition',
            'trg_lab_threshold_policy_rule_write',
            'trg_validate_lab_result_threshold_policy_insert',
            'trg_validate_lab_result_threshold_policy_update',
            'trg_validate_lab_critical_alert_threshold_policy',
            'trg_validate_lab_threshold_exception_binding'
          )
        ORDER BY tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'trg_lab_threshold_catalog_entry_write',
      'trg_lab_threshold_policy_bundle_transition',
      'trg_lab_threshold_policy_rule_write',
      'trg_validate_lab_critical_alert_threshold_policy',
      'trg_validate_lab_result_threshold_policy_insert',
      'trg_validate_lab_result_threshold_policy_update',
      'trg_validate_lab_threshold_exception_binding',
    ]);

    const constraints = await client.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conrelid = 'lab_results'::regclass
          AND conname IN (
            'fk_lab_results_facility_tenant',
            'fk_lab_results_threshold_bundle',
            'fk_lab_results_threshold_catalog_entry',
            'fk_lab_results_threshold_rule'
          )
        ORDER BY conname`,
    );
    expect(constraints.rows).toEqual([
      { conname: 'fk_lab_results_facility_tenant', convalidated: true },
      { conname: 'fk_lab_results_threshold_bundle', convalidated: true },
      { conname: 'fk_lab_results_threshold_catalog_entry', convalidated: true },
      { conname: 'fk_lab_results_threshold_rule', convalidated: true },
    ]);
  });

  test('records numeric and signed qualitative catalogue coverage but rejects overlaps', async () => {
    const numeric = await client.query(
      `INSERT INTO lab_threshold_catalog_entries
         (tenant_id, facility_id, introduced_revision, test_code, loinc_code,
          test_name, specimen_type, evaluation_mode, unit, normalized_unit,
          pregnancy_scope, criticality_required, created_by)
       VALUES ($1::uuid, $2::int, 1, 'K', '2823-3', 'Potassium', 'serum',
               'numeric_threshold', 'mmol/L', 'mmol/l', 'all', TRUE, $3::uuid)
       RETURNING id`,
      [tenantId, facilityId, authorUid],
    );
    numericEntryId = numeric.rows[0].id;

    const overlap = await attempt(() => client.query(
      `INSERT INTO lab_threshold_catalog_entries
         (tenant_id, facility_id, introduced_revision, test_code, loinc_code,
          test_name, specimen_type, evaluation_mode, unit, normalized_unit,
          pregnancy_scope, criticality_required, created_by)
       VALUES ($1::uuid, $2::int, 2, 'K', '2823-3', 'Overlapping potassium', 'serum',
               'numeric_threshold', 'mmol/L', 'mmol/l', 'all', TRUE, $3::uuid)`,
      [tenantId, facilityId, authorUid],
    ));
    expect(overlap.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_catalog_entry_scope_overlap',
    });

    const exempt = await client.query(
      `INSERT INTO lab_threshold_catalog_entries
         (tenant_id, facility_id, introduced_revision, test_code, test_name,
          specimen_type, evaluation_mode, pregnancy_scope, criticality_required,
          exemption_reason, created_by)
       VALUES ($1::uuid, $2::int, 2, 'CULTURE', 'Culture', 'blood',
               'qualitative_exempt', 'all', FALSE,
               'Clinically approved qualitative exemption.', $3::uuid)
       RETURNING id`,
      [tenantId, facilityId, authorUid],
    );
    exemptEntryId = exempt.rows[0].id;
    await client.query(
      `UPDATE lab_threshold_catalog_states
          SET current_revision = 2, updated_by = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      [tenantId, facilityId, authorUid],
    );

    const deletion = await attempt(() => client.query(
      `DELETE FROM lab_threshold_catalog_entries
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, numericEntryId],
    ));
    expect(deletion.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_catalog_entry_no_delete',
    });
  });

  test('permits rules only for numeric entries and enforces required critical bounds', async () => {
    const invalidInitialState = await attempt(() => client.query(
      `INSERT INTO lab_threshold_policy_bundles
         (tenant_id, facility_id, bundle_version, catalog_revision,
          lifecycle_status, created_by)
       VALUES ($1::uuid, $2::int, 99, 2, 'active', $3::uuid)`,
      [tenantId, facilityId, authorUid],
    ));
    expect(invalidInitialState.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_bundle_initial_draft',
    });

    firstBundleId = await createBundle(1);
    const exemptRule = await attempt(() => client.query(
      `INSERT INTO lab_threshold_policy_rules
         (tenant_id, facility_id, bundle_id, catalog_entry_id,
          reference_low, reference_high, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 0, 1, $5::uuid)`,
      [tenantId, facilityId, firstBundleId, exemptEntryId, authorUid],
    ));
    expect(exemptRule.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_rule_numeric_entry',
    });

    const missingCritical = await attempt(() => client.query(
      `INSERT INTO lab_threshold_policy_rules
         (tenant_id, facility_id, bundle_id, catalog_entry_id,
          reference_low, reference_high, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 3.5, 5.1, $5::uuid)`,
      [tenantId, facilityId, firstBundleId, numericEntryId, authorUid],
    ));
    expect(missingCritical.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_rule_critical_required',
    });
    await addNumericRule(firstBundleId);
  });

  test('enforces review, distinct clinical approval, activation, and immutable evidence', async () => {
    const skippedReview = await attempt(() => client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId],
    ));
    expect(skippedReview.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_bundle_transition',
    });

    await submitAndApprove(firstBundleId, 'a');
    const ruleEdit = await attempt(() => client.query(
      `UPDATE lab_threshold_policy_rules
          SET critical_high = 7
        WHERE tenant_id = $1::uuid AND bundle_id = $2::uuid`,
      [tenantId, firstBundleId],
    ));
    expect(ruleEdit.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_rule_draft_only',
    });

    const collapsedActivation = await attempt(() => client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId, approverUid],
    ));
    expect(collapsedActivation.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_bundle_activation',
    });

    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId, activatorUid],
    );
    const tamper = await attempt(() => client.query(
      `UPDATE lab_threshold_policy_bundles
          SET content_sha256 = repeat('f', 64)
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId],
    ));
    expect(tamper.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_bundle_content_immutable',
    });

    const deletion = await attempt(() => client.query(
      `DELETE FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId],
    ));
    expect(deletion.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_lab_threshold_policy_bundle_no_delete',
    });
  });

  test('supports a one-predecessor activation chain and signed rollback', async () => {
    const secondBundleId = await createBundle(2);
    await addNumericRule(secondBundleId);
    await submitAndApprove(secondBundleId, 'b');
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'superseded',
              superseded_by_bundle_id = $3::uuid,
              superseded_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId, secondBundleId],
    );
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, secondBundleId, activatorUid],
    );

    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'superseded',
              superseded_by_bundle_id = $3::uuid,
              superseded_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, secondBundleId, firstBundleId],
    );
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW(), superseded_by_bundle_id = NULL,
              superseded_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, firstBundleId, activatorUid],
    );
    const statuses = await client.query(
      `SELECT id, lifecycle_status
         FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = $2::int
        ORDER BY bundle_version`,
      [tenantId, facilityId],
    );
    expect(statuses.rows).toEqual([
      { id: firstBundleId, lifecycle_status: 'active' },
      { id: secondBundleId, lifecycle_status: 'superseded' },
    ]);
  });
});
