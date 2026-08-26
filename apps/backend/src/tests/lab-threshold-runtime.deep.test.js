import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { evaluateCriticalThreshold } from '../services/lab/labCriticalThresholdService.js';
import { applyLabThresholdAssessmentTx } from '../services/lab/labThresholdExceptionService.js';
import { reconcileLabThresholdExceptionTx } from '../services/lab/labThresholdReconciliationService.js';

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

describeIfDb('governed lab threshold runtime', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const authorUid = randomUUID();
  const approverUid = randomUUID();
  const activatorUid = randomUUID();
  const labInchargeUid = randomUUID();
  const patientUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let facilityId;
  let bundleId;
  let numericCatalogId;
  let qualitativeCatalogId;
  let numericRuleId;

  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      return (await client.query(sql, params)).rows;
    },
    async $executeRawUnsafe(sql, ...params) {
      return (await client.query(sql, params)).rowCount;
    },
  };

  async function insertResult({
    testCode,
    testName,
    valueText,
    valueNumeric,
    unit,
    specimenType,
  }) {
    const rows = await client.query(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, patient_name, test_code, test_name,
          value_text, value_numeric, unit, status, facility_id, specimen_type,
          performed_at, received_at)
       VALUES ($1::uuid, $2::uuid, 'Runtime patient', $3, $4,
               $5, $6::numeric, $7, 'preliminary', $8::int, $9, NOW(), NOW())
       RETURNING *`,
      [
        tenantId,
        patientUid,
        testCode,
        testName,
        valueText,
        valueNumeric,
        unit,
        facilityId,
        specimenType,
      ],
    );
    return rows.rows[0];
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'Lab threshold runtime test')`,
      [tenantId, `lab-runtime-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, name, role, gender, birthday, is_pregnant, updated_at)
         VALUES
          ($1::uuid, $6::uuid, 'Policy author', 'ADMIN', NULL, NULL, FALSE, NOW()),
          ($2::uuid, $6::uuid, 'Clinical approver', 'PATHOLOGIST', NULL, NULL, FALSE, NOW()),
          ($3::uuid, $6::uuid, 'Policy activator', 'SUPER_ADMIN', NULL, NULL, FALSE, NOW()),
          ($4::uuid, $6::uuid, 'Laboratory owner', 'LAB_INCHARGE', NULL, NULL, FALSE, NOW()),
          ($5::uuid, $6::uuid, 'Runtime patient', 'PATIENT', 'female', DATE '1990-01-01', FALSE, NOW())`,
      [authorUid, approverUid, activatorUid, labInchargeUid, patientUid, tenantId],
    );
    const facilities = await client.query(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, is_default, created_by)
       VALUES ($1::uuid, $2, 'Lab threshold runtime test', TRUE, $3::uuid)
       RETURNING id`,
      [tenantId, `safe01-runtime-${suffix}`, authorUid],
    );
    facilityId = facilities.rows[0].id;
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
    numericCatalogId = numeric.rows[0].id;
    const qualitative = await client.query(
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
    qualitativeCatalogId = qualitative.rows[0].id;
    await client.query(
      `INSERT INTO lab_threshold_catalog_states
         (tenant_id, facility_id, current_revision, updated_by)
       VALUES ($1::uuid, $2::int, 2, $3::uuid)`,
      [tenantId, facilityId, authorUid],
    );
    const bundles = await client.query(
      `INSERT INTO lab_threshold_policy_bundles
         (tenant_id, facility_id, bundle_version, catalog_revision,
          lifecycle_status, created_by)
       VALUES ($1::uuid, $2::int, 1, 2, 'draft', $3::uuid)
       RETURNING id`,
      [tenantId, facilityId, authorUid],
    );
    bundleId = bundles.rows[0].id;
    const rules = await client.query(
      `INSERT INTO lab_threshold_policy_rules
         (tenant_id, facility_id, bundle_id, catalog_entry_id,
          reference_low, reference_high, critical_low, critical_high, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid,
               3.5, 5.1, 2.5, 6.5, $5::uuid)
       RETURNING id`,
      [tenantId, facilityId, bundleId, numericCatalogId, authorUid],
    );
    numericRuleId = rules.rows[0].id;
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'in_review', source_reference = 'runtime-test',
              content_sha256 = repeat('a', 64),
              effective_from = NOW() - INTERVAL '1 hour',
              submitted_by = $3::uuid, submitted_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, bundleId, authorUid],
    );
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'approved', approved_by = $3::uuid,
              approved_at = NOW(), approval_reason = 'Runtime proof',
              approval_evidence_reference = 'runtime-evidence',
              approval_evidence_sha256 = repeat('e', 64)
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, bundleId, approverUid],
    );
    await client.query(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, bundleId, activatorUid],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('persists one exact numeric policy binding and governed reference range', async () => {
    const result = await insertResult({
      testCode: 'K',
      testName: 'Potassium',
      valueText: '4.2',
      valueNumeric: 4.2,
      unit: 'mmol/L',
      specimenType: 'serum',
    });
    const assessment = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    expect(assessment).toMatchObject({
      matched: true,
      breached: false,
      policyBundleId: bundleId,
      policyRuleId: numericRuleId,
      catalogEntryId: numericCatalogId,
      criticalityStatus: 'within_policy',
    });
    const applied = await applyLabThresholdAssessmentTx({
      tx,
      tenantId,
      result,
      assessment,
      source: 'runtime_deep_test',
    });
    expect(applied.result).toMatchObject({
      criticality_status: 'within_policy',
      threshold_policy_bundle_id: bundleId,
      threshold_policy_rule_id: numericRuleId,
      threshold_catalog_entry_id: numericCatalogId,
      reference_range: '3.5–5.1 mmol/l',
      abnormal_flag: 'N',
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });

  test('owns an unmatched result with a high-priority task and closes both after reconciliation', async () => {
    const result = await insertResult({
      testCode: 'K',
      testName: 'Potassium',
      valueText: '4.2',
      valueNumeric: 4.2,
      unit: 'mg/dL',
      specimenType: 'serum',
    });
    const unmatched = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    expect(unmatched).toMatchObject({
      matched: false,
      unmatchedReason: 'unit_mismatch',
      criticalityStatus: 'threshold_unavailable',
    });
    const opened = await applyLabThresholdAssessmentTx({
      tx,
      tenantId,
      result,
      assessment: unmatched,
      source: 'runtime_deep_test',
    });
    expect(opened.exception).toMatchObject({
      lifecycle_status: 'open',
      unmatched_reason: 'unit_mismatch',
      assigned_role: 'LAB_INCHARGE',
      occurrence_count: 1,
      reconciliation_attempts: 0,
    });
    expect(opened.task).toMatchObject({
      task_kind: 'review',
      priority: 'high',
      status: 'open',
      assigned_to_role: 'LAB_INCHARGE',
    });
    expect(opened.exception.metadata).toMatchObject({ notification_recipient_count: 1 });
    const notificationRows = await client.query(
      `SELECT outbox.status, outbox.channel, outbox.source_event_key
         FROM notification_outbox AS outbox
         JOIN users AS recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND recipient.uid = $2::uuid
          AND outbox.source_event_key = $3`,
      [tenantId, labInchargeUid, `lab-threshold-exception:${opened.exception.id}`],
    );
    expect(notificationRows.rows).toEqual([
      expect.objectContaining({ status: 'PENDING', channel: 'inapp' }),
    ]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    const deferred = await reconcileLabThresholdExceptionTx({
      tx,
      tenantId,
      exceptionId: opened.exception.id,
      source: 'runtime_deep_reconciliation',
    });
    expect(deferred).toMatchObject({ outcome: 'deferred' });
    const deferredRows = await client.query(
      `SELECT occurrence_count, reconciliation_attempts
         FROM lab_threshold_unmatched_exceptions
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, opened.exception.id],
    );
    expect(deferredRows.rows[0]).toMatchObject({
      occurrence_count: 1,
      reconciliation_attempts: 1,
    });

    const correctedRows = await client.query(
      `UPDATE lab_results
          SET unit = 'mmol/L', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      [tenantId, Number(result.id)],
    );
    expect(correctedRows.rows).toHaveLength(1);
    const reconciled = await reconcileLabThresholdExceptionTx({
      tx,
      tenantId,
      exceptionId: opened.exception.id,
      source: 'runtime_deep_reconciliation',
    });
    expect(reconciled).toMatchObject({ outcome: 'resolved' });
    const resolvedRows = await client.query(
      `SELECT *
         FROM lab_threshold_unmatched_exceptions
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, opened.exception.id],
    );
    expect(resolvedRows.rows[0]).toMatchObject({
      lifecycle_status: 'resolved',
      resolved_bundle_id: bundleId,
      resolved_rule_id: numericRuleId,
      resolved_catalog_entry_id: numericCatalogId,
      occurrence_count: 1,
      reconciliation_attempts: 2,
    });
    const tasks = await client.query(
      `SELECT status, completed_at
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [tenantId, Number(opened.task.id)],
    );
    expect(tasks.rows[0]).toMatchObject({ status: 'completed' });
    expect(tasks.rows[0].completed_at).not.toBeNull();
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });

  test('reconciliation creates a governed critical alert and acknowledgement task', async () => {
    const result = await insertResult({
      testCode: 'K',
      testName: 'Potassium',
      valueText: '7.0',
      valueNumeric: 7,
      unit: 'mg/dL',
      specimenType: 'serum',
    });
    const unmatched = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    const opened = await applyLabThresholdAssessmentTx({
      tx,
      tenantId,
      result,
      assessment: unmatched,
      source: 'runtime_deep_test',
    });
    await client.query(
      `UPDATE lab_results
          SET unit = 'mmol/L', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [tenantId, Number(result.id)],
    );
    const reconciled = await reconcileLabThresholdExceptionTx({
      tx,
      tenantId,
      exceptionId: opened.exception.id,
      source: 'runtime_deep_reconciliation',
    });
    expect(reconciled).toMatchObject({
      outcome: 'resolved',
      assessment: {
        breached: true,
        criticalityStatus: 'critical',
        policyBundleId: bundleId,
        policyRuleId: numericRuleId,
        catalogEntryId: numericCatalogId,
      },
      materialization: { created: true, state: 'critical' },
    });
    const alerts = await client.query(
      `SELECT alert.threshold_policy_bundle_id,
              alert.threshold_policy_rule_id,
              alert.threshold_catalog_entry_id,
              task.status AS task_status
         FROM lab_critical_alerts AS alert
         JOIN tasks AS task
           ON task.tenant_id = alert.tenant_id
          AND task.id = alert.acknowledgement_task_id
        WHERE alert.tenant_id = $1::uuid
          AND alert.result_id = $2::int
          AND alert.superseded_at IS NULL`,
      [tenantId, Number(result.id)],
    );
    expect(alerts.rows).toEqual([
      expect.objectContaining({
        threshold_policy_bundle_id: bundleId,
        threshold_policy_rule_id: numericRuleId,
        threshold_catalog_entry_id: numericCatalogId,
        task_status: 'open',
      }),
    ]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });

  test('persists a signed qualitative exemption without creating an exception task', async () => {
    const result = await insertResult({
      testCode: 'CULTURE',
      testName: 'Culture',
      valueText: 'negative',
      valueNumeric: null,
      unit: null,
      specimenType: 'blood',
    });
    const assessment = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    expect(assessment).toMatchObject({
      matched: true,
      criticalityStatus: 'not_applicable',
      policyBundleId: bundleId,
      policyRuleId: null,
      catalogEntryId: qualitativeCatalogId,
    });
    const applied = await applyLabThresholdAssessmentTx({
      tx,
      tenantId,
      result,
      assessment,
      source: 'runtime_deep_test',
    });
    expect(applied.result).toMatchObject({
      criticality_status: 'not_applicable',
      threshold_policy_bundle_id: bundleId,
      threshold_policy_rule_id: null,
      threshold_catalog_entry_id: qualitativeCatalogId,
    });
    expect(applied.exception).toBeNull();
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });
});
