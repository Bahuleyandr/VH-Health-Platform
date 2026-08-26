import {
  activateLabThresholdPolicyBundle,
  addLabThresholdCatalogEntry,
  approveLabThresholdPolicyBundle,
  createLabThresholdPolicyBundle,
  replaceLabThresholdPolicyRules,
  submitLabThresholdPolicyBundle,
} from '../../services/lab/labThresholdGovernanceService.js';
import { setTenantTx } from '../../lib/prisma.js';

export async function seedActiveLabThresholdPolicy({
  db,
  tenantId,
  facilityCode,
  facilityName,
  authorUid,
  approverUid,
  activatorUid,
  entries,
  sourceReference,
  effectiveFrom = new Date(Date.now() - 60_000).toISOString(),
  metadata = {},
  isDefault = false,
}) {
  const facilities = await db.$queryRawUnsafe(
    `INSERT INTO facilities
       (tenant_id, facility_code, display_name, status, is_default, created_by)
     VALUES ($1::uuid, $2, $3, 'active', $4::boolean, $5::uuid)
     RETURNING id`,
    tenantId,
    facilityCode,
    facilityName,
    isDefault,
    authorUid,
  );
  const facilityId = Number(facilities[0].id);
  const catalogEntries = new Map();
  for (const entry of entries) {
    const catalog = await addLabThresholdCatalogEntry({
      tenantId,
      facilityId,
      actorUid: authorUid,
      actorRole: 'ADMIN',
      entry: {
        test_code: entry.testCode,
        loinc_code: entry.loincCode ?? null,
        test_name: entry.testName,
        specimen_type: entry.specimenType ?? 'any',
        evaluation_mode: 'numeric_threshold',
        unit: entry.unit,
        criticality_required: true,
      },
      metadata,
    });
    catalogEntries.set(entry.testCode, catalog.entry.id);
  }

  const bundle = await createLabThresholdPolicyBundle({
    tenantId,
    facilityId,
    actorUid: authorUid,
    actorRole: 'ADMIN',
    metadata,
  });
  const coverage = await replaceLabThresholdPolicyRules({
    tenantId,
    bundleId: bundle.id,
    actorUid: authorUid,
    actorRole: 'ADMIN',
    rules: entries.map((entry) => ({
      catalog_entry_id: catalogEntries.get(entry.testCode),
      reference_low: entry.referenceLow ?? null,
      reference_high: entry.referenceHigh ?? null,
      critical_low: entry.criticalLow ?? null,
      critical_high: entry.criticalHigh ?? null,
    })),
  });
  const rulesByCatalogEntry = new Map(
    coverage.rules.map((rule) => [String(rule.catalog_entry_id), rule.id]),
  );
  const policyRules = new Map(entries.map((entry) => [
    entry.testCode,
    rulesByCatalogEntry.get(String(catalogEntries.get(entry.testCode))),
  ]));
  if ([...policyRules.values()].some((id) => !id)) {
    throw new Error('Governed lab threshold fixture did not materialize every rule');
  }

  await submitLabThresholdPolicyBundle({
    tenantId,
    bundleId: bundle.id,
    actorUid: authorUid,
    actorRole: 'ADMIN',
    sourceReference,
    effectiveFrom,
  });
  await approveLabThresholdPolicyBundle({
    tenantId,
    bundleId: bundle.id,
    actorUid: approverUid,
    actorRole: 'PATHOLOGIST',
    reason: 'Independent clinical approval for a disposable deep-test fixture.',
    evidenceReference: `${sourceReference}-approval`,
    evidenceSha256: 'e'.repeat(64),
  });
  const activated = await activateLabThresholdPolicyBundle({
    tenantId,
    bundleId: bundle.id,
    actorUid: activatorUid,
    actorRole: 'SUPER_ADMIN',
    reason: 'Test-only activation after independent fixture approval.',
  });
  return Object.freeze({
    facilityId,
    bundleId: activated.bundle.id,
    catalogRevision: Number(activated.bundle.catalog_revision),
    catalogEntries,
    policyRules,
  });
}

export async function cleanupGovernedOruFixture({
  tenantId,
  analyzerCodes = [],
  userUids = [],
  resultPatientUids = [],
  facilityIds = [],
  investigationIds = [],
  bookingIds = [],
}) {
  const analyzers = [...new Set(analyzerCodes.map(String).filter(Boolean))];
  const users = [...new Set(userUids.map(String).filter(Boolean))];
  const scopedPatientUids = [...new Set(resultPatientUids.map(String).filter(Boolean))];
  const facilities = [...new Set(facilityIds
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const requestedInvestigations = [...new Set(investigationIds
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const requestedBookings = [...new Set(bookingIds
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];

  await setTenantTx(tenantId, async (tx) => {
    const resultRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, investigation_id, booking_id, ingest_command_id
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND (
            performed_by_lab = ANY($2::text[])
            OR patient_uid = ANY($3::uuid[])
          )`,
      tenantId,
      analyzers,
      scopedPatientUids,
    );
    const resultIds = resultRows.map((row) => Number(row.id));
    const resultIdTexts = resultIds.map(String);
    const ingestCommandIds = [...new Set(resultRows
      .map((row) => Number(row.ingest_command_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    const patientUids = [...new Set(resultRows.map((row) => String(row.patient_uid)))];
    const allInvestigationIds = [...new Set([
      ...requestedInvestigations,
      ...resultRows.map((row) => Number(row.investigation_id)),
    ].filter((id) => Number.isSafeInteger(id) && id > 0))];
    const allBookingIds = [...new Set([
      ...requestedBookings,
      ...resultRows.map((row) => Number(row.booking_id)),
    ].filter((id) => Number.isSafeInteger(id) && id > 0))];
    const exceptions = await tx.$queryRawUnsafe(
      `SELECT id, task_id
         FROM lab_threshold_unmatched_exceptions
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    const exceptionIds = exceptions.map((row) => String(row.id));
    const exceptionTaskIds = exceptions
      .map((row) => Number(row.task_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const alerts = await tx.$queryRawUnsafe(
      `SELECT id, acknowledgement_task_id
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    const alertIds = alerts.map((row) => Number(row.id));
    const alertTaskIds = alerts
      .map((row) => Number(row.acknowledgement_task_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const taskIds = [...new Set([...exceptionTaskIds, ...alertTaskIds])];
    const fixtureUsers = await tx.$queryRawUnsafe(
      `SELECT id, uid
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])`,
      tenantId,
      users,
    );
    const userIds = fixtureUsers.map((row) => Number(row.id));
    const policyResources = await tx.$queryRawUnsafe(
      `SELECT id::text AS id
         FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])
       UNION ALL
       SELECT id::text
         FROM lab_threshold_policy_rules
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])
       UNION ALL
       SELECT id::text
         FROM lab_threshold_catalog_entries
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    const auditResourceIds = [
      ...new Set([...policyResources.map((row) => row.id), ...exceptionIds]),
    ];
    const outboxRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND (
            payload->>'result_id' = ANY($2::text[])
            OR payload->>'alert_id' = ANY($3::text[])
            OR source_event_key = ANY($4::text[])
            OR recipient_id = ANY($5::text[])
          )`,
      tenantId,
      resultIdTexts,
      alertIds.map(String),
      exceptionIds.map((id) => `lab-threshold-exception:${id}`),
      userIds.map(String),
    );
    const outboxIds = outboxRows.map((row) => Number(row.id));

    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_delivery_attempts
        WHERE tenant_id = $1::uuid
          AND notification_outbox_id = ANY($2::int[])`,
      tenantId,
      outboxIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      tenantId,
      outboxIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notifications
        WHERE tenant_id = $1::uuid
          AND (
            data->>'result_id' = ANY($2::text[])
            OR related_id = ANY($3::int[])
            OR user_id = ANY($4::int[])
            OR uid = ANY($5::uuid[])
          )`,
      tenantId,
      resultIdTexts,
      alertIds,
      userIds,
      users,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid AND result_id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_reconciliation_receipts
        WHERE tenant_id = $1::uuid AND result_id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_results'
          AND source_id = ANY($2::text[])`,
      tenantId,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND resource_table = 'lab_results'
          AND resource_id = ANY($2::text[])`,
      tenantId,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid AND task_id = ANY($2::int[])`,
      tenantId,
      taskIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND (
            id = ANY($2::int[])
            OR (related_resource_type = 'lab_result'
              AND related_resource_id = ANY($3::text[]))
            OR (related_resource_type = 'lab_threshold_exception'
              AND related_resource_id = ANY($4::text[]))
          )`,
      tenantId,
      taskIds,
      resultIdTexts,
      exceptionIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_result'
          AND source_id = ANY($2::text[])`,
      tenantId,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid AND result_id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_unmatched_exceptions
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
      tenantId,
      exceptionIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_oru_ingest_messages
        WHERE tenant_id = $1::uuid
          AND trusted_sender_identity = ANY($2::text[])`,
      tenantId,
      analyzers,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_results
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      tenantId,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_result_ingest_commands
        WHERE tenant_id = $1::uuid AND id = ANY($2::bigint[])`,
      tenantId,
      ingestCommandIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM investigation_bookings
        WHERE tenant_id = $1::uuid AND id = ANY($2::bigint[])`,
      tenantId,
      allBookingIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM investigations
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      tenantId,
      allInvestigationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND (
            resource_id = ANY($2::text[])
            OR actor_uid = ANY($3::uuid[])
          )`,
      tenantId,
      auditResourceIds,
      users,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_policy_rules
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_catalog_entries
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_catalog_states
        WHERE tenant_id = $1::uuid AND facility_id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_analyzers
        WHERE tenant_id = $1::uuid AND analyzer_code = ANY($2::text[])`,
      tenantId,
      analyzers,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM facilities
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      tenantId,
      facilities,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users
        WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])`,
      tenantId,
      users,
    );
  });
}

export default { cleanupGovernedOruFixture, seedActiveLabThresholdPolicy };
