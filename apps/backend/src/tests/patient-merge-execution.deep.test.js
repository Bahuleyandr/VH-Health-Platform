// 2026-08-07 Phase-3 deep review — patient merge execution rework.
//
// Proves, against a real migrated schema:
//   1. The catalog-discovered FK sweep re-points the whole chart, not a
//      hand-picked subset: admissions AND the composite-FK-linked
//      investigations row (both patient_uid and the patient_id int column
//      readers actually query) and appointments move to the survivor in one
//      transaction, with the migration-634 deferrable composite FKs checked
//      at COMMIT.
//   2. The merged-away patient record is deactivated in the same
//      transaction (is_active=false, status='merged', merged_into_uid) —
//      it can no longer mint logins and un-merge provenance is durable.
//   3. Old identifiers stay resolvable: the secondary's MRN keeps its
//      original patient_uid (provenance) but lookupByIdentifier resolves it
//      to the survivor.
//   4. Canonical clinical timeline invariant: exactly one
//      clinical_timeline_events row + one clinical_audit_events row for the
//      merge, in the same transaction, on insert-once idempotency keys.
//   5. Transactionality: a data conflict (per-patient unique row on both
//      records, e.g. abha_profiles) aborts as a 409 and rolls back
//      EVERYTHING — no half-merged chart, secondary stays live.
//   6. Migration-634 pin: no composite patient_uid FK may be
//      non-deferrable, or the multi-table sweep becomes impossible again.
//   7. Trigger-aware sweep exclusion: the classifier validated against the
//      LIVE schema — update-blocking / identity-pinned tables are skipped
//      (their rows stay on the old uid) while the core chart keeps moving,
//      and a merge across a protected table succeeds instead of aborting.
//   8. Reader-side merged-uid union: after a merge, the survivor's canonical
//      timeline includes events recorded under the merged-away uid.
//   9. Both-active-admissions guard: two simultaneously-admitted patients
//      (migration 640's one-active-admission index) are rejected with a
//      specific 409 before anything mutates.
//  10. Inactive inputs are rejected in both positions.
//  11. Chained merges (A→B then B→C): stored survivor pointers end at the
//      final survivor; old identifiers resolve to it; the survivor's
//      timeline union spans the whole chain.
//  12. Two-person rule holds even for unattributed rows: a request with
//      NULL requested_by is rejected at approval with a specific 409
//      instead of letting any single actor approve it.
//  13. ICU code-status history retains immutable original provenance while
//      current identity joins through its admission to the merge survivor.
//  14. Medication-safety logical clocks remain on every merged-away record;
//      the survivor folds all unequal chain clocks to max+1, failed merges
//      roll the fold back, and a committed retry cannot advance it twice.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
  setTenantTx,
} from '../lib/prisma.js';
import {
  requestMerge,
  approveMerge,
  executeMerge,
  __testing__ as mergeTesting,
} from '../services/patient/patientMergeService.js';
import { lookupByIdentifier } from '../services/patient/patientIdentifierService.js';
import { importFhirBundle as importFhirBundleWithAuthority } from '../services/import/patientDataImport.js';
import { reconcileRecordedVitalsEffects } from '../services/emr/vitalsChartService.js';
import {
  listWorkflowSlaInstances,
  readCanonicalPatientTimeline,
} from '../services/clinical/canonicalClinicalPlatformService.js';
import { resolveMergedPatientUidSet } from '../services/clinical/mergedPatientReadUnion.js';
import {
  getMyLabResult,
  listMyLabResults,
} from '../services/portal/patientPortalService.js';
import { listTasks } from '../services/workflow/taskService.js';
import { listPatientAccessAudit } from '../services/governance/clinicalGovernanceService.js';
import { isUserTokensRevoked } from '../utils/tokenBlacklist.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const MARK = `PMERGE-${process.pid}-${Date.now()}`;
const RUNTIME_ROLE = `vh_p2_merge_${process.pid}_${Date.now().toString(36)}`;
const PRIOR_RUNTIME_ROLE = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;

function importFhirBundle(bundle, importedBy, options = {}) {
  const patientReference = (bundle.entry || [])
    .map(({ resource }) => resource?.subject?.reference || resource?.patient?.reference)
    .find(Boolean);
  const patientUid = String(patientReference || '').replace('Patient/', '');
  return importFhirBundleWithAuthority(bundle, importedBy, {
    ...options,
    authority: { patientUid },
  });
}

const REQUESTER = randomUUID();
const APPROVER = randomUUID();
const EXECUTOR = randomUUID();

const seeded = {
  userUids: [],
  admissionIds: [],
  icuAdmissionIds: [],
  investigationIds: [],
  appointmentIds: [],
  labResultIds: [],
  taskIds: [],
  workflowSlaIds: [],
  patientAccessAuditIds: [],
  eventOutboxIds: [],
  fhirSetFingerprints: [],
  fhirVitalsIds: [],
};

let phoneSeq = 0;
async function seedPatient(label) {
  const phone = `+9198${String(700000 + ++phoneSeq)}${String(Date.now() % 1000).padStart(3, '0')}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, phone, name, role, registered_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', NOW(), NOW())
     RETURNING id, uid::text AS uid`,
    TENANT, phone, `${MARK}-${label}`,
  );
  seeded.userUids.push(rows[0].uid);
  return { id: rows[0].id, uid: rows[0].uid, phone };
}

async function setPatientSafetyVersion(patientId, version) {
  return setTenantTx(TENANT, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_patient_safety_versions
         (tenant_id, patient_id, version, updated_at)
       VALUES ($1::uuid, $2::integer, $3::bigint, clock_timestamp())
       ON CONFLICT (tenant_id, patient_id) DO UPDATE
         SET version = EXCLUDED.version,
             updated_at = clock_timestamp()
       RETURNING patient_id::text AS patient_id, version::text AS version`,
      TENANT,
      patientId,
      String(version),
    );
    return rows[0];
  });
}

async function readPatientSafetyVersions(patientIds) {
  return setTenantTx(TENANT, (tx) => tx.$queryRawUnsafe(
    `SELECT patient_id::text AS patient_id, version::text AS version
       FROM pharmacy_patient_safety_versions
      WHERE tenant_id = $1::uuid
        AND patient_id = ANY($2::integer[])
      ORDER BY patient_id`,
    TENANT,
    patientIds,
  ));
}

async function seedChart(patient) {
  const admissionRows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'ACTIVE', NOW(), NOW())
     RETURNING id`,
    TENANT, patient.uid,
  );
  const admissionId = admissionRows[0].id;
  seeded.admissionIds.push(admissionId);

  // Composite fk_investigations_admission (tenant_id, admission_id,
  // patient_uid) — the sweep must move parent + child consistently.
  const investigationRows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, test_name, patient_id, patient_uid, admission_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, NOW())
     RETURNING id`,
    TENANT, patient.phone, `${MARK}-test`, patient.id, patient.uid, admissionId,
  );
  seeded.investigationIds.push(investigationRows[0].id);

  const appointmentRows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (tenant_id, phone, appointment_date, appointment_time, patient_id, updated_at)
     VALUES ($1::uuid, $2, CURRENT_DATE, '10:00', $3, NOW())
     RETURNING id`,
    TENANT, patient.phone, patient.id,
  );
  seeded.appointmentIds.push(appointmentRows[0].id);
  return { admissionId, investigationId: investigationRows[0].id, appointmentId: appointmentRows[0].id };
}

async function seedFhirVitalReceiptSet(patient) {
  const fingerprintSuffix = randomUUID().replaceAll('-', '').padEnd(64, '0');
  const setFingerprint = `fhir-set:${fingerprintSuffix}`;
  const resourceFingerprint = `fhir:${randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const observedAt = new Date();
  const vitalsRows = await prisma.$queryRawUnsafe(
    `INSERT INTO vitals_chart
       (tenant_id, patient_uid, heart_rate, source, source_device, recorded_by, recorded_at)
     VALUES ($1::uuid, $2::uuid, 82, 'fhir', $3, $2::uuid, $4::timestamptz)
     RETURNING id`,
    TENANT,
    patient.uid,
    setFingerprint,
    observedAt,
  );
  const vitalsChartId = vitalsRows[0].id;
  seeded.fhirVitalsIds.push(vitalsChartId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO fhir_vital_observation_receipts
       (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, ARRAY['8867-4']::text[])`,
    TENANT,
    resourceFingerprint,
    patient.uid,
    `${MARK}-fhir-observation`,
    observedAt,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO fhir_vital_observation_sets
       (tenant_id, set_fingerprint, patient_uid, observed_at, imported_by,
        vitals_chart_id, news2_effects_completed_at, anomaly_effects_completed_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $3::uuid,
             $5::integer, clock_timestamp(), clock_timestamp())`,
    TENANT,
    setFingerprint,
    patient.uid,
    observedAt,
    vitalsChartId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO fhir_vital_observation_set_resources
       (tenant_id, set_fingerprint, resource_fingerprint)
     VALUES ($1::uuid, $2, $3)`,
    TENANT,
    setFingerprint,
    resourceFingerprint,
  );
  seeded.fhirSetFingerprints.push(setFingerprint);
  return { setFingerprint, resourceFingerprint, vitalsChartId, observedAt };
}

function criticalFhirVitalBundle(patientUid, observedAt, resourceId) {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Observation',
        id: resourceId,
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
        subject: { reference: `Patient/${patientUid}` },
        effectiveDateTime: observedAt.toISOString(),
        component: [
          ['9279-1', 26, '/min'],
          ['2708-6', 88, '%'],
          ['8480-6', 88, 'mm[Hg]'],
          ['8867-4', 132, '/min'],
          ['8310-5', 37, 'Cel'],
          ['3151-8', 0, 'L/min'],
        ].map(([code, value, unit]) => ({
          code: { coding: [{ system: 'http://loinc.org', code }] },
          valueQuantity: {
            value,
            system: 'http://unitsofmeasure.org',
            code: unit,
          },
        })),
      },
    }],
  };
}

async function seedIcuAdmission(patient) {
  return setTenantTx(TENANT, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_admissions
         (tenant_id, patient_uid, unit_code, code_status, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'MICU', 'dnr', 'active', NOW(), NOW())
       RETURNING id`,
      TENANT, patient.uid,
    );
    const id = rows[0].id;
    seeded.icuAdmissionIds.push(id);
    await tx.$queryRawUnsafe(
      `INSERT INTO icu_code_status_history
         (tenant_id, icu_admission_id, patient_uid, previous_code_status, new_code_status)
       VALUES ($1::uuid, $2, $3::uuid, 'full_code', 'dnr')`,
      TENANT, id, patient.uid,
    );
    return id;
  });
}

async function seedIdentifier(patientUid, value) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_identifiers
       (tenant_id, patient_uid, identifier_type, identifier_value, status, is_primary)
     VALUES ($1::uuid, $2::uuid, 'mrn', $3, 'active', true)`,
    TENANT, patientUid, value,
  );
}

async function seedActiveAdmission(patientUid, status = 'admitted') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW())
     RETURNING id`,
    TENANT, patientUid, status,
  );
  seeded.admissionIds.push(rows[0].id);
  return rows[0].id;
}

// Direct INSERT: the append-only guard blocks UPDATE/DELETE, not INSERT, so
// pre-merge history can be seeded under the uid it "happened to".
async function seedTimelineEvent(patientUid, label) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, clinical_summary, idempotency_key)
     VALUES ($1::uuid, $2::uuid, 'vitals.recorded', $3, $4)
     RETURNING id::text AS id`,
    TENANT, patientUid, `${MARK}-${label}`, `${MARK}:${label}:${randomUUID()}`,
  );
  return rows[0].id;
}

async function seedLabResult(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, released_to_patient_at)
     VALUES ($1::uuid, $2::uuid, 'HB', $3, '13.2', 'final', NOW(), NOW())
     RETURNING id`,
    TENANT, patientUid, `${MARK}-haemoglobin`,
  );
  seeded.labResultIds.push(rows[0].id);
  return rows[0].id;
}

async function seedTask(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tasks (tenant_id, patient_uid, title)
     VALUES ($1::uuid, $2::uuid, $3)
     RETURNING id`,
    TENANT, patientUid, `${MARK}-merge-aware-task`,
  );
  seeded.taskIds.push(rows[0].id);
  return rows[0].id;
}

async function seedWorkflowSla(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_sla_instances
       (tenant_id, rule_code, patient_uid, due_at)
     VALUES ($1::uuid, $2, $3::uuid, NOW() + INTERVAL '1 hour')
     RETURNING id::text AS id`,
    TENANT, `${MARK}-sla`, patientUid,
  );
  seeded.workflowSlaIds.push(rows[0].id);
  return rows[0].id;
}

async function seedPatientAccessAudit(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_access_audit_log
       (tenant_id, patient_uid, access_decision, access_source, action, request_id)
     VALUES ($1::uuid, $2::uuid, 'allow', 'system', 'PATIENT_MERGE_TEST', $3)
     RETURNING id`,
    TENANT, patientUid, `${MARK}:patient-access`,
  );
  seeded.patientAccessAuditIds.push(rows[0].id);
  return rows[0].id;
}

async function seedUnsupportedEventOutbox(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO event_outbox
       (event_type, aggregate_type, aggregate_id, patient_uid, payload)
     VALUES ('patient.merge.test', 'patient', $1, $2::uuid, '{}'::jsonb)
     RETURNING id::text AS id`,
    `${MARK}:outbox`, patientUid,
  );
  seeded.eventOutboxIds.push(rows[0].id);
  return rows[0].id;
}

async function approvedMergeRequest(primary, secondary) {
  const request = await requestMerge({
    tenantId: TENANT,
    primaryUid: primary.uid,
    secondaryUid: secondary.uid,
    requestedBy: REQUESTER,
    requesterNote: MARK,
  });
  await approveMerge({ tenantId: TENANT, id: request.id, approverUid: APPROVER });
  return request;
}

async function cleanup() {
  if (!DB) return;
  if (seeded.fhirSetFingerprints.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM fhir_vital_observation_set_resources
        WHERE tenant_id = $1::uuid AND set_fingerprint = ANY($2::varchar[])`,
      TENANT,
      seeded.fhirSetFingerprints,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM fhir_vital_observation_sets
        WHERE tenant_id = $1::uuid AND set_fingerprint = ANY($2::varchar[])`,
      TENANT,
      seeded.fhirSetFingerprints,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM fhir_vital_observation_receipts
        WHERE tenant_id = $1::uuid AND resource_id LIKE $2`,
      TENANT,
      `${MARK}%`,
    );
  }
  if (seeded.fhirVitalsIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM news2_scores WHERE vitals_chart_id = ANY($1::int[])`,
      seeded.fhirVitalsIds,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
        WHERE source_table = 'vitals_chart' AND source_id = ANY($1::text[])`,
      seeded.fhirVitalsIds.map(String),
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE resource_table = 'vitals_chart' AND resource_id = ANY($1::text[])`,
      seeded.fhirVitalsIds.map(String),
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM vitals_chart WHERE id = ANY($1::int[])`,
      seeded.fhirVitalsIds,
    );
  }
  if (seeded.eventOutboxIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM event_outbox WHERE id = ANY($1::bigint[])`, seeded.eventOutboxIds,
    );
  }
  if (seeded.patientAccessAuditIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log WHERE id = ANY($1::int[])`, seeded.patientAccessAuditIds,
    );
  }
  if (seeded.taskIds.length || seeded.workflowSlaIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      if (seeded.taskIds.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM tasks WHERE id = ANY($1::int[])`, seeded.taskIds,
        );
      }
      if (seeded.workflowSlaIds.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM workflow_sla_instances WHERE id = ANY($1::uuid[])`, seeded.workflowSlaIds,
        );
      }
    });
  }
  if (seeded.userUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_alerts
        WHERE patient_id IN (SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
      seeded.userUids,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM cds_alerts WHERE patient_uid = ANY($1::uuid[])`,
      seeded.userUids,
    );
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE source_table = 'patient_merge_requests' AND clinical_summary LIKE '%merged%' AND patient_uid = ANY($1::uuid[])`,
    seeded.userUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE clinical_summary LIKE $1 AND patient_uid = ANY($2::uuid[])`,
    `${MARK}%`, seeded.userUids,
  );
  if (seeded.labResultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE id = ANY($1::int[])`, seeded.labResultIds,
    );
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE action = 'patient.merge.executed' AND patient_uid = ANY($1::uuid[])`,
    seeded.userUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_merge_requests WHERE tenant_id = $1::uuid AND requester_note = $2`,
    TENANT, MARK,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value LIKE $2`,
    TENANT, `${MARK}%`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM abha_profiles WHERE tenant_id = $1::uuid AND abha_id LIKE $2`,
    TENANT, `${MARK}%`,
  );
  if (seeded.investigationIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE id = ANY($1::int[])`, seeded.investigationIds,
    );
  }
  if (seeded.appointmentIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE id = ANY($1::int[])`, seeded.appointmentIds,
    );
  }
  if (seeded.icuAdmissionIds.length) {
    await setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.audit_bypass = 'on'");
      await tx.$executeRawUnsafe(
        `DELETE FROM icu_code_status_history WHERE icu_admission_id = ANY($1::int[])`,
        seeded.icuAdmissionIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM icu_admissions WHERE id = ANY($1::int[])`,
        seeded.icuAdmissionIds,
      );
    });
  }
  if (seeded.admissionIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE id = ANY($1::int[])`, seeded.admissionIds,
    );
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM invalidated_tokens WHERE jti = ANY($1::text[])`,
    seeded.userUids.map((uid) => `user:${uid}`),
  );
  if (seeded.userUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, seeded.userUids,
    );
  }
}

d('patient merge execution (deep)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, $8, 'STAFF', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6, $9, 'STAFF', true, 'active', NOW()),
         ($3::uuid, $4::uuid, $7, $10, 'STAFF', true, 'active', NOW())`,
      REQUESTER,
      APPROVER,
      EXECUTOR,
      TENANT,
      `+9197${String(process.pid).padStart(8, '0').slice(-8)}1`,
      `+9197${String(process.pid).padStart(8, '0').slice(-8)}2`,
      `+9197${String(process.pid).padStart(8, '0').slice(-8)}3`,
      `${MARK}-requester`,
      `${MARK}-approver`,
      `${MARK}-executor`,
    );
    seeded.userUids.push(REQUESTER, APPROVER, EXECUTOR);
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = RUNTIME_ROLE;
    const grantResult = await ensureTenantRlsRuntimeRoleGrants();
    if (grantResult.error) throw new Error(grantResult.error);
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      if (PRIOR_RUNTIME_ROLE == null) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = PRIOR_RUNTIME_ROLE;
      await prisma.$executeRawUnsafe(`DROP OWNED BY ${RUNTIME_ROLE}`).catch(() => {});
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
    }
  }, 30_000);

  test('migration 634 pin: composite patient_uid FKs are all deferrable', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pc.conname
       FROM pg_constraint pc
       WHERE pc.contype = 'f'
         AND NOT pc.condeferrable
         AND array_length(pc.conkey, 1) > 1
         AND EXISTS (
           SELECT 1 FROM unnest(pc.conkey) AS k
           JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k
           WHERE a.attname = 'patient_uid'
         )`,
    );
    // A non-deferrable composite patient_uid FK makes the merge sweep
    // impossible (parent/child cannot re-point in separate statements).
    // New migrations must declare such FKs DEFERRABLE INITIALLY IMMEDIATE.
    expect(rows.map((row) => row.conname)).toEqual([]);
  });

  test('FHIR receipt ownership rolls back with a failed merge and moves atomically on retry', async () => {
    const primary = await seedPatient('primary-fhir-receipt');
    const secondary = await seedPatient('secondary-fhir-receipt');
    const fhir = await seedFhirVitalReceiptSet(secondary);
    await prisma.$executeRawUnsafe(
      `INSERT INTO abha_profiles (tenant_id, patient_uid, abha_id)
       VALUES ($1::uuid, $2::uuid, $3), ($1::uuid, $4::uuid, $5)`,
      TENANT,
      primary.uid,
      `${MARK}-FHIR-ABHA-P`,
      secondary.uid,
      `${MARK}-FHIR-ABHA-S`,
    );
    const request = await approvedMergeRequest(primary, secondary);

    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_DATA_CONFLICT' });
    const afterRollback = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT patient_uid::text FROM fhir_vital_observation_receipts
           WHERE tenant_id = $1::uuid AND resource_fingerprint = $2) AS receipt_patient_uid,
         (SELECT patient_uid::text FROM fhir_vital_observation_sets
           WHERE tenant_id = $1::uuid AND set_fingerprint = $3) AS set_patient_uid,
         (SELECT patient_uid::text FROM vitals_chart WHERE id = $4::integer) AS vitals_patient_uid,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_set_resources
           WHERE tenant_id = $1::uuid AND set_fingerprint = $3) AS link_count`,
      TENANT,
      fhir.resourceFingerprint,
      fhir.setFingerprint,
      fhir.vitalsChartId,
    );
    expect(afterRollback).toEqual([{
      receipt_patient_uid: secondary.uid,
      set_patient_uid: secondary.uid,
      vitals_patient_uid: secondary.uid,
      link_count: 1,
    }]);

    await prisma.$executeRawUnsafe(
      `DELETE FROM abha_profiles WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT,
      primary.uid,
    );
    const executed = await executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');
    const afterRetry = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT patient_uid::text FROM fhir_vital_observation_receipts
           WHERE tenant_id = $1::uuid AND resource_fingerprint = $2) AS receipt_patient_uid,
         (SELECT patient_uid::text FROM fhir_vital_observation_sets
           WHERE tenant_id = $1::uuid AND set_fingerprint = $3) AS set_patient_uid,
         (SELECT patient_uid::text FROM vitals_chart WHERE id = $4::integer) AS vitals_patient_uid,
         (SELECT COUNT(*)::integer FROM fhir_vital_observation_set_resources
           WHERE tenant_id = $1::uuid AND set_fingerprint = $3) AS link_count`,
      TENANT,
      fhir.resourceFingerprint,
      fhir.setFingerprint,
      fhir.vitalsChartId,
    );
    expect(afterRetry).toEqual([{
      receipt_patient_uid: primary.uid,
      set_patient_uid: primary.uid,
      vitals_patient_uid: primary.uid,
      link_count: 1,
    }]);

    const correctedReplay = await importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: `${MARK}-fhir-observation`,
          status: 'corrected',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
          subject: { reference: `Patient/${secondary.uid}` },
          effectiveDateTime: fhir.observedAt.toISOString(),
          valueQuantity: { value: 96, code: '/min' },
        },
      }],
    }, primary.uid, { tenantId: TENANT });
    expect(correctedReplay).toEqual(expect.objectContaining({
      imported: 0,
      deduplicated: 0,
      errors: [expect.objectContaining({
        code: 'FHIR_OBSERVATION_RESOURCE_ID_CONFLICT',
      })],
    }));
    const fragmentedRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM vitals_chart
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND source = 'fhir'`,
      TENANT,
      secondary.uid,
    );
    expect(fragmentedRows[0].count).toBe(0);
  });

  test('FHIR import revalidates the active survivor inside its write transaction', async () => {
    const primary = await seedPatient('primary-fhir-race');
    const secondary = await seedPatient('secondary-fhir-race');
    const request = await approvedMergeRequest(primary, secondary);
    const observedAt = new Date(Date.now() - 20 * 60 * 1000);
    observedAt.setMilliseconds(0);
    const resourceId = `${MARK}-fhir-race-observation`;
    let signalResolved;
    let releaseWrite;
    const patientResolved = new Promise((resolve) => { signalResolved = resolve; });
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    const importPromise = importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: resourceId,
          status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
          subject: { reference: `Patient/${secondary.uid}` },
          effectiveDateTime: observedAt.toISOString(),
          valueQuantity: { value: 84, code: '/min' },
        },
      }],
    }, EXECUTOR, {
      tenantId: TENANT,
      beforeFhirVitalWrite: async () => {
        signalResolved();
        await writeGate;
      },
    });

    await patientResolved;
    let mergeSettled = false;
    const mergePromise = executeMerge({
      tenantId: TENANT,
      id: request.id,
      executorUid: EXECUTOR,
    }).finally(() => { mergeSettled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mergeSettled).toBe(false);
    } finally {
      releaseWrite();
    }
    const [imported, executed] = await Promise.all([importPromise, mergePromise]);
    expect(executed.status).toBe('executed');
    expect(imported).toEqual(expect.objectContaining({ imported: 1, errors: [] }));

    const ownership = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT patient_uid::text
            FROM fhir_vital_observation_receipts
           WHERE tenant_id = $1::uuid AND resource_id = $2) AS receipt_patient_uid,
         (SELECT patient_uid::text
            FROM fhir_vital_observation_sets
           WHERE tenant_id = $1::uuid
             AND set_fingerprint = (
               SELECT set_fingerprint
                 FROM fhir_vital_observation_set_resources
                WHERE tenant_id = $1::uuid
                  AND resource_fingerprint = (
                    SELECT resource_fingerprint
                      FROM fhir_vital_observation_receipts
                     WHERE tenant_id = $1::uuid AND resource_id = $2
                  )
             )) AS set_patient_uid,
         (SELECT patient_uid::text
            FROM vitals_chart
           WHERE tenant_id = $1::uuid AND source = 'fhir'
             AND recorded_at = $3::timestamptz) AS vitals_patient_uid,
         (SELECT COUNT(*)::integer
            FROM vitals_chart
           WHERE tenant_id = $1::uuid AND patient_uid = $4::uuid
             AND source = 'fhir' AND recorded_at = $3::timestamptz) AS secondary_rows`,
      TENANT,
      resourceId,
      observedAt,
      secondary.uid,
    );
    expect(ownership[0]).toEqual({
      receipt_patient_uid: primary.uid,
      set_patient_uid: primary.uid,
      vitals_patient_uid: primary.uid,
      secondary_rows: 0,
    });
    const importedRows = await prisma.$queryRawUnsafe(
      `SELECT sets.set_fingerprint, sets.vitals_chart_id
         FROM fhir_vital_observation_receipts AS receipt
         JOIN fhir_vital_observation_set_resources AS link
           ON link.tenant_id = receipt.tenant_id
          AND link.resource_fingerprint = receipt.resource_fingerprint
         JOIN fhir_vital_observation_sets AS sets
           ON sets.tenant_id = link.tenant_id
          AND sets.set_fingerprint = link.set_fingerprint
        WHERE receipt.tenant_id = $1::uuid AND receipt.resource_id = $2`,
      TENANT,
      resourceId,
    );
    seeded.fhirSetFingerprints.push(importedRows[0].set_fingerprint);
    seeded.fhirVitalsIds.push(importedRows[0].vitals_chart_id);
  });

  test('FHIR effect recovery cannot create late tasks or alerts on a merged-away identity', async () => {
    const primary = await seedPatient('primary-fhir-effect-race');
    const secondary = await seedPatient('secondary-fhir-effect-race');
    const request = await approvedMergeRequest(primary, secondary);
    const observedAt = new Date(Date.now() - 19 * 60 * 1000);
    observedAt.setMilliseconds(0);
    const resourceId = `${MARK}-fhir-effect-race-observation`;
    const initial = await importFhirBundle(
      criticalFhirVitalBundle(secondary.uid, observedAt, resourceId),
      EXECUTOR,
      { tenantId: TENANT },
    );
    expect(initial).toEqual(expect.objectContaining({ imported: 1, errors: [] }));
    const sourceRows = await prisma.$queryRawUnsafe(
      `SELECT sets.set_fingerprint, sets.vitals_chart_id, score.id AS news2_id
         FROM fhir_vital_observation_receipts AS receipt
         JOIN fhir_vital_observation_set_resources AS link
           ON link.tenant_id = receipt.tenant_id
          AND link.resource_fingerprint = receipt.resource_fingerprint
         JOIN fhir_vital_observation_sets AS sets
           ON sets.tenant_id = link.tenant_id
          AND sets.set_fingerprint = link.set_fingerprint
         JOIN news2_scores AS score ON score.vitals_chart_id = sets.vitals_chart_id
        WHERE receipt.tenant_id = $1::uuid AND receipt.resource_id = $2`,
      TENANT,
      resourceId,
    );
    expect(sourceRows).toHaveLength(1);
    const source = sourceRows[0];
    seeded.fhirSetFingerprints.push(source.set_fingerprint);
    seeded.fhirVitalsIds.push(source.vitals_chart_id);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      const taskRows = await tx.$queryRawUnsafe(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'news2_score'
            AND related_resource_id = $2::text
        RETURNING workflow_sla_instance_id::text AS workflow_sla_instance_id`,
        TENANT,
        String(source.news2_id),
      );
      const workflowIds = taskRows
        .map(({ workflow_sla_instance_id: id }) => id)
        .filter(Boolean);
      if (workflowIds.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM workflow_sla_instances WHERE id = ANY($1::uuid[])`,
          workflowIds,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_alerts
          WHERE patient_id IN ($1::int, $2::int)`,
        primary.id,
        secondary.id,
      );
    });

    let signalLoaded;
    let releaseEffects;
    const effectsLoaded = new Promise((resolve) => { signalLoaded = resolve; });
    const effectsGate = new Promise((resolve) => { releaseEffects = resolve; });
    const recoveryPromise = reconcileRecordedVitalsEffects({
      tenantId: TENANT,
      vitalsChartId: source.vitals_chart_id,
      news2Pending: true,
      anomalyPending: true,
      beforeClinicalEffects: async () => {
        signalLoaded();
        await effectsGate;
      },
    });

    await effectsLoaded;
    try {
      const executed = await executeMerge({
        tenantId: TENANT,
        id: request.id,
        executorUid: EXECUTOR,
      });
      expect(executed.status).toBe('executed');
    } finally {
      releaseEffects();
    }
    await expect(recoveryPromise).resolves.toEqual(expect.objectContaining({
      news2Reconciled: true,
      anomalyReconciled: true,
    }));

    const ownership = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'news2_score'
             AND related_resource_id = $2::text
             AND patient_uid = $3::uuid) AS primary_tasks,
         (SELECT COUNT(*)::integer FROM tasks
           WHERE tenant_id = $1::uuid
             AND related_resource_type = 'news2_score'
             AND related_resource_id = $2::text
             AND patient_uid = $4::uuid) AS secondary_tasks,
         (SELECT COUNT(*)::integer FROM clinical_alerts
           WHERE patient_id = $5::int) AS primary_alerts,
         (SELECT COUNT(*)::integer FROM clinical_alerts
           WHERE patient_id = $6::int) AS secondary_alerts`,
      TENANT,
      String(source.news2_id),
      primary.uid,
      secondary.uid,
      primary.id,
      secondary.id,
    );
    expect(ownership[0]).toEqual({
      primary_tasks: 1,
      secondary_tasks: 0,
      primary_alerts: 2,
      secondary_alerts: 0,
    });
    const createdTasks = await prisma.$queryRawUnsafe(
      `SELECT id, workflow_sla_instance_id::text AS workflow_sla_instance_id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'news2_score'
          AND related_resource_id = $2::text`,
      TENANT,
      String(source.news2_id),
    );
    seeded.taskIds.push(...createdTasks.map(({ id }) => id));
    seeded.workflowSlaIds.push(...createdTasks
      .map(({ workflow_sla_instance_id: id }) => id)
      .filter(Boolean));
  });

  test('FHIR anomaly recovery reclassifies against the active survivor cohort after a merge', async () => {
    const primary = await seedPatient('primary-fhir-pregnancy-effect-race');
    const secondary = await seedPatient('secondary-fhir-pregnancy-effect-race');
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_pregnant = true WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      primary.uid,
    );
    const request = await approvedMergeRequest(primary, secondary);
    const observedAt = new Date(Date.now() - 18 * 60 * 1000);
    observedAt.setMilliseconds(0);
    const resourceId = `${MARK}-fhir-pregnancy-effect-race-observation`;
    const initial = await importFhirBundle({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: resourceId,
          status: 'final',
          category: [{ coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
          }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
          subject: { reference: `Patient/${secondary.uid}` },
          effectiveDateTime: observedAt.toISOString(),
          valueQuantity: {
            value: 145,
            system: 'http://unitsofmeasure.org',
            code: 'mm[Hg]',
          },
        },
      }],
    }, EXECUTOR, { tenantId: TENANT });
    expect(initial).toEqual(expect.objectContaining({ imported: 1, errors: [] }));

    const sourceRows = await prisma.$queryRawUnsafe(
      `SELECT sets.set_fingerprint, sets.vitals_chart_id
         FROM fhir_vital_observation_receipts AS receipt
         JOIN fhir_vital_observation_set_resources AS link
           ON link.tenant_id = receipt.tenant_id
          AND link.resource_fingerprint = receipt.resource_fingerprint
         JOIN fhir_vital_observation_sets AS sets
           ON sets.tenant_id = link.tenant_id
          AND sets.set_fingerprint = link.set_fingerprint
        WHERE receipt.tenant_id = $1::uuid AND receipt.resource_id = $2`,
      TENANT,
      resourceId,
    );
    expect(sourceRows).toHaveLength(1);
    const source = sourceRows[0];
    seeded.fhirSetFingerprints.push(source.set_fingerprint);
    seeded.fhirVitalsIds.push(source.vitals_chart_id);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE fhir_vital_observation_sets
            SET anomaly_effects_completed_at = NULL,
                anomaly_effects_claimed_at = NULL,
                anomaly_effects_claim_token = NULL,
                anomaly_effects_next_retry_at = NULL
          WHERE tenant_id = $1::uuid AND set_fingerprint = $2`,
        TENANT,
        source.set_fingerprint,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_alerts WHERE patient_id IN ($1::int, $2::int)`,
        primary.id,
        secondary.id,
      );
    });

    let signalLoaded;
    let releaseEffects;
    const effectsLoaded = new Promise((resolve) => { signalLoaded = resolve; });
    const effectsGate = new Promise((resolve) => { releaseEffects = resolve; });
    const recoveryPromise = reconcileRecordedVitalsEffects({
      tenantId: TENANT,
      vitalsChartId: source.vitals_chart_id,
      anomalyPending: true,
      beforeClinicalEffects: async () => {
        signalLoaded();
        await effectsGate;
      },
      onClinicalAlertsPersisted: async ({ tx }) => {
        await tx.$executeRawUnsafe(
          `UPDATE fhir_vital_observation_sets
              SET anomaly_effects_completed_at = clock_timestamp()
            WHERE tenant_id = $1::uuid
              AND set_fingerprint = $2
              AND vitals_chart_id = $3::integer
              AND anomaly_effects_completed_at IS NULL`,
          TENANT,
          source.set_fingerprint,
          source.vitals_chart_id,
        );
      },
    });

    await effectsLoaded;
    try {
      const executed = await executeMerge({
        tenantId: TENANT,
        id: request.id,
        executorUid: EXECUTOR,
      });
      expect(executed.status).toBe('executed');
    } finally {
      releaseEffects();
    }
    await expect(recoveryPromise).resolves.toEqual(expect.objectContaining({
      anomalyReconciled: true,
      alertCount: 1,
    }));

    const evidence = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM clinical_alerts
           WHERE patient_id = $1::int
             AND vital_name = 'systolic_bp'
             AND message LIKE 'Pregnancy-induced hypertension:%') AS primary_pregnancy_alerts,
         (SELECT COUNT(*)::integer FROM clinical_alerts
           WHERE patient_id = $2::int) AS secondary_alerts,
         (SELECT anomaly_effects_completed_at IS NOT NULL
            FROM fhir_vital_observation_sets
           WHERE tenant_id = $3::uuid AND set_fingerprint = $4) AS anomaly_completed`,
      primary.id,
      secondary.id,
      TENANT,
      source.set_fingerprint,
    );
    expect(evidence).toEqual([{
      primary_pregnancy_alerts: 1,
      secondary_alerts: 0,
      anomaly_completed: true,
    }]);
  });

  test('executed merge moves the whole chart, deactivates the secondary, keeps identifiers resolvable, and emits the canonical pair', async () => {
    const primary = await seedPatient('primary');
    const secondary = await seedPatient('secondary');
    const tokenIssuedAt = Math.floor(Date.now() / 1000) - 1;
    const mergeUids = [primary.uid, secondary.uid];
    const epochsBefore = await prisma.$queryRawUnsafe(
      `SELECT uid::text, token_epoch
         FROM users
        WHERE uid = ANY($1::uuid[])`,
      mergeUids,
    );
    const epochBefore = new Map(epochsBefore.map((row) => [row.uid, Number(row.token_epoch)]));
    const chart = await seedChart(secondary);
    const icuAdmissionId = await seedIcuAdmission(secondary);
    await seedIdentifier(primary.uid, `${MARK}-P-MRN`);
    await seedIdentifier(secondary.uid, `${MARK}-S-MRN`);

    const request = await approvedMergeRequest(primary, secondary);
    const executed = await executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');

    // 1. Chart moved — admission, composite-FK investigation (uuid + int
    // reader columns), appointment.
    const admission = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text FROM admissions WHERE id = $1`, chart.admissionId,
    );
    expect(admission[0].patient_uid).toBe(primary.uid);
    const investigation = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, patient_id, admission_id FROM investigations WHERE id = $1`,
      chart.investigationId,
    );
    expect(investigation[0].patient_uid).toBe(primary.uid);
    expect(investigation[0].patient_id).toBe(primary.id);
    expect(investigation[0].admission_id).toBe(chart.admissionId);
    const codeStatusHistory = await prisma.$queryRawUnsafe(
      `SELECT history.patient_uid::text AS recorded_patient_uid,
              admission.patient_uid::text AS current_patient_uid
         FROM icu_code_status_history AS history
         JOIN icu_admissions AS admission
           ON admission.tenant_id = history.tenant_id
          AND admission.id = history.icu_admission_id
        WHERE history.icu_admission_id = $1`,
      icuAdmissionId,
    );
    expect(codeStatusHistory).toEqual([
      expect.objectContaining({
        recorded_patient_uid: secondary.uid,
        current_patient_uid: primary.uid,
      }),
    ]);
    const appointment = await prisma.$queryRawUnsafe(
      `SELECT patient_id FROM appointments WHERE id = $1`, chart.appointmentId,
    );
    expect(appointment[0].patient_id).toBe(primary.id);

    // 2. Secondary deactivated with durable survivor pointer.
    const merged = await prisma.$queryRawUnsafe(
      `SELECT is_active, status, merged_into_uid::text, merged_at FROM users WHERE uid = $1::uuid`,
      secondary.uid,
    );
    expect(merged[0].is_active).toBe(false);
    expect(merged[0].status).toBe('merged');
    expect(merged[0].merged_into_uid).toBe(primary.uid);
    expect(merged[0].merged_at).not.toBeNull();

    // The secondary's durable epoch + watermark committed with the merge.
    // Redis/WebSocket publication is only an acceleration/notification layer:
    // reconnect authorization still rejects the old bearer from Postgres.
    const epochsAfter = await prisma.$queryRawUnsafe(
      `SELECT uid::text, token_epoch
         FROM users
        WHERE uid = ANY($1::uuid[])`,
      mergeUids,
    );
    const epochAfter = new Map(epochsAfter.map((row) => [row.uid, Number(row.token_epoch)]));
    expect(epochAfter.get(secondary.uid)).toBe(epochBefore.get(secondary.uid) + 1);
    expect(epochAfter.get(primary.uid)).toBe(epochBefore.get(primary.uid));
    const revocationMarker = await prisma.$queryRawUnsafe(
      `SELECT reason
         FROM invalidated_tokens
        WHERE jti = $1
          AND expires_at > NOW()`,
      `user:${secondary.uid}`,
    );
    expect(revocationMarker).toEqual([{ reason: 'patient_merged' }]);
    await expect(isUserTokensRevoked(
      secondary.uid,
      tokenIssuedAt,
      epochBefore.get(secondary.uid),
    )).resolves.toBe(true);
    await expect(isUserTokensRevoked(
      primary.uid,
      tokenIssuedAt,
      epochBefore.get(primary.uid),
    )).resolves.toBe(false);

    // 3. Old MRN resolves to the survivor; provenance intact on the row.
    const lookup = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-S-MRN`,
    });
    expect(lookup.count).toBe(1);
    expect(lookup.identifiers[0].patient_uid).toBe(primary.uid);
    expect(lookup.identifiers[0].original_patient_uid).toBe(secondary.uid);
    expect(lookup.identifiers[0].status).toBe('merged_into');
    const identifierRow = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, status, merged_into_uid::text, metadata
       FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-S-MRN`,
    );
    expect(identifierRow[0].patient_uid).toBe(secondary.uid);
    expect(identifierRow[0].merged_into_uid).toBe(primary.uid);
    expect(identifierRow[0].metadata.merge_request_id).toBe(request.id);
    // The survivor's own MRN is untouched.
    const primaryMrn = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-P-MRN`,
    });
    expect(primaryMrn.identifiers[0].patient_uid).toBe(primary.uid);
    expect(primaryMrn.identifiers[0].status).toBe('active');

    // 4. Canonical pair, insert-once keys, same transaction as the merge.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, event_type FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(primary.uid);
    expect(timeline[0].event_type).toBe('patient.merge.executed');
    const audit = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, action FROM clinical_audit_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('patient.merge.executed');

    // Execution summary records the sweep for admin audit.
    const summary = executed.execution_summary;
    expect(summary.identifiers_retargeted).toBe(1);
    expect(summary.secondary_deactivated).toBe(true);
    expect(summary.secondary_tokens_revoked).toBe(true);
    expect(summary.table_summary.admissions.rows_moved).toBe(1);
    expect(summary.table_summary.investigations.rows_moved).toBe(2);
    expect(summary.table_summary.appointments.rows_moved).toBe(1);
    expect(summary.update_blocked_skipped).toEqual(
      expect.arrayContaining([
        'clinical_timeline_events.patient_uid',
        'icu_code_status_history.patient_uid',
      ]),
    );
    expect(summary.update_blocked_triggers.clinical_timeline_events).toEqual(
      expect.arrayContaining(['audit_append_only_guard']),
    );

    // The merged-away record can no longer be merge-targeted again.
    await expect(requestMerge({
      tenantId: TENANT,
      primaryUid: primary.uid,
      secondaryUid: secondary.uid,
      requestedBy: REQUESTER,
      requesterNote: MARK,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a data conflict rolls back the entire merge — nothing moves, secondary stays live', async () => {
    const primary = await seedPatient('primary2');
    const secondary = await seedPatient('secondary2');
    const chart = await seedChart(secondary);
    await seedIdentifier(secondary.uid, `${MARK}-S2-MRN`);
    // abha_profiles is UNIQUE (tenant_id, patient_uid): a row on BOTH
    // records makes the sweep collide at the unique index.
    await prisma.$executeRawUnsafe(
      `INSERT INTO abha_profiles (tenant_id, patient_uid, abha_id)
       VALUES ($1::uuid, $2::uuid, $3), ($1::uuid, $4::uuid, $5)`,
      TENANT, primary.uid, `${MARK}-ABHA-P`, secondary.uid, `${MARK}-ABHA-S`,
    );
    await setPatientSafetyVersion(primary.id, 31);
    await setPatientSafetyVersion(secondary.id, 47);
    const safetyClocksBefore = await readPatientSafetyVersions([primary.id, secondary.id]);

    const request = await approvedMergeRequest(primary, secondary);
    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_DATA_CONFLICT' });

    // Everything rolled back: chart untouched, identifiers active,
    // secondary live, merge still 'approved' (retryable after cleanup),
    // no canonical rows.
    const admission = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text FROM admissions WHERE id = $1`, chart.admissionId,
    );
    expect(admission[0].patient_uid).toBe(secondary.uid);
    const identifier = await prisma.$queryRawUnsafe(
      `SELECT status, patient_uid::text FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-S2-MRN`,
    );
    expect(identifier[0].status).toBe('active');
    expect(identifier[0].patient_uid).toBe(secondary.uid);
    const user = await prisma.$queryRawUnsafe(
      `SELECT is_active, status, merged_into_uid::text FROM users WHERE uid = $1::uuid`,
      secondary.uid,
    );
    expect(user[0].is_active).toBe(true);
    expect(user[0].status).not.toBe('merged');
    expect(user[0].merged_into_uid).toBeNull();
    const requestRow = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_merge_requests WHERE id = $1`, request.id,
    );
    expect(requestRow[0].status).toBe('approved');
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(timeline).toHaveLength(0);
    expect(await readPatientSafetyVersions([primary.id, secondary.id]))
      .toEqual(safetyClocksBefore);
  });

  test('a failed merge transaction rolls back its safety-clock fold', async () => {
    const primary = await seedPatient('primary-clock-rollback');
    const secondary = await seedPatient('secondary-clock-rollback');
    await setPatientSafetyVersion(primary.id, 13);
    await setPatientSafetyVersion(secondary.id, 29);
    const clocksBefore = await readPatientSafetyVersions([primary.id, secondary.id]);

    await expect(setTenantTx(TENANT, async (tx) => {
      const folded = await mergeTesting.foldPatientSafetyVersionForMerge(tx, {
        tenantId: TENANT,
        survivorPatientId: primary.id,
        mergedAwayPatientIds: [secondary.id],
      });
      expect(folded).toEqual({ patient_id: String(primary.id), version: '30' });
      throw new Error(`${MARK}-forced-merge-rollback`);
    })).rejects.toThrow(`${MARK}-forced-merge-rollback`);

    expect(await readPatientSafetyVersions([primary.id, secondary.id]))
      .toEqual(clocksBefore);
  });

  test('trigger classification against the live schema: core chart sweeps, protected classes are excluded', async () => {
    const targets = await mergeTesting.discoverMergeSweepTargets(prisma);
    const byTable = new Map(targets.map((t) => [`${t.table_name}.${t.column_name}`, t]));

    // Core chart tables must remain sweepable — a conservative-but-wrong
    // classifier here silently splits every merged chart.
    for (const key of [
      'admissions.patient_uid', 'appointments.patient_id',
      'investigations.patient_uid', 'investigations.patient_id',
      'vitals_chart.patient_uid', 'prescriptions.patient_id',
      'care_pathway_instances.patient_uid',
    ]) {
      if (!byTable.has(key)) continue; // column set can evolve
      expect({ key, blocked: byTable.get(key).update_blocked })
        .toEqual({ key, blocked: false });
    }

    // One representative per protected class, validated against the live
    // trigger catalog:
    //   audit_append_only_guard (bypass-escape raise) — canonical timeline;
    //   unconditional raise — diagnostic evidence;
    //   bypass-escape raise — financial ledger;
    //   identity pin (OLD.patient_uid comparison) — interface lab rows.
    const expectBlocked = {
      'clinical_timeline_events.patient_uid': 'audit_append_only_guard',
      'clinical_audit_events.patient_uid': 'audit_append_only_guard',
      'diagnostic_result_actions.patient_uid': 'diagnostic_result_evidence_append_only',
      'ledger_postings.patient_uid': 'ledger_block_mutation',
      'lab_results.patient_uid': 'lab_results_assert_oru_identity',
    };
    for (const [key, trigger] of Object.entries(expectBlocked)) {
      const target = byTable.get(key);
      expect({ key, present: !!target }).toEqual({ key, present: true });
      expect({ key, blocked: target.update_blocked }).toEqual({ key, blocked: true });
      expect(target.blocking_triggers).toEqual(expect.arrayContaining([trigger]));
    }

    // GUC-engaged external-recovery guards must NOT block (the merge tx
    // never sets app.external_recovery_effect_disposition).
    const admissions = byTable.get('admissions.patient_uid');
    expect(admissions.blocking_triggers).toEqual([]);

    // Logical clocks are neither chart data nor mutable FKs. They have a
    // dedicated max+1 fold and predecessor rows must never enter the sweep.
    expect(byTable.has('pharmacy_patient_safety_versions.patient_id')).toBe(false);
  });

  test('certified protected rows remain on the old uid and their reader returns them for the survivor', async () => {
    const primary = await seedPatient('primary-certified');
    const secondary = await seedPatient('secondary-certified');
    const accessAuditId = await seedPatientAccessAudit(secondary.uid);

    const request = await approvedMergeRequest(primary, secondary);
    const executed = await executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');

    const accessAudit = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text FROM patient_access_audit_log WHERE id = $1::int`, accessAuditId,
    );
    expect(accessAudit[0].patient_uid).toBe(secondary.uid);
    expect(executed.execution_summary.update_blocked_skipped).toEqual(
      expect.arrayContaining(['patient_access_audit_log.patient_uid']),
    );

    const access = await listPatientAccessAudit({
      tenantId: TENANT, patientUid: primary.uid,
    });
    expect(access.access_events.map((row) => Number(row.id))).toContain(Number(accessAuditId));
  });

  test('existing merged charts recover protected lab, task, and SLA history through repaired readers', async () => {
    const primary = await seedPatient('primary-existing-merge');
    const secondary = await seedPatient('secondary-existing-merge');
    const labId = await seedLabResult(secondary.uid);
    const taskId = await seedTask(secondary.uid);
    const workflowSlaId = await seedWorkflowSla(secondary.uid);
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET merged_into_uid = $1::uuid,
              status = 'merged',
              is_active = false
        WHERE tenant_id = $2::uuid AND uid = $3::uuid`,
      primary.uid, TENANT, secondary.uid,
    );

    const labList = await listMyLabResults({
      tenantId: TENANT, patient_uid: primary.uid, limit: 20,
    });
    expect(labList.map((row) => Number(row.id))).toContain(Number(labId));
    await expect(getMyLabResult({
      tenantId: TENANT, patient_uid: primary.uid, id: labId,
    })).resolves.toMatchObject({ id: labId });

    const tasks = await listTasks({ tenantId: TENANT, patientUid: primary.uid });
    expect(tasks.tasks.map((row) => Number(row.id))).toContain(Number(taskId));

    const slas = await listWorkflowSlaInstances({
      tenantId: TENANT, patientUid: primary.uid,
    });
    expect(slas.slas.map((row) => String(row.id))).toContain(workflowSlaId);
  });

  test('unsupported protected history blocks before any merge mutation', async () => {
    const primary = await seedPatient('primary-unsupported');
    const secondary = await seedPatient('secondary-unsupported');
    await seedIdentifier(secondary.uid, `${MARK}-UNSUPPORTED-MRN`);
    await seedLabResult(secondary.uid);
    await seedTask(secondary.uid);
    await seedWorkflowSla(secondary.uid);
    await seedUnsupportedEventOutbox(secondary.uid);

    const request = await approvedMergeRequest(primary, secondary);
    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'PATIENT_MERGE_PROTECTED_HISTORY_UNSUPPORTED',
        details: {
          unsupported_protected_history: expect.arrayContaining([
            expect.objectContaining({ table: 'event_outbox', column: 'patient_uid' }),
            expect.objectContaining({ table: 'lab_results', column: 'patient_uid' }),
            expect.objectContaining({ table: 'tasks', column: 'patient_uid' }),
            expect.objectContaining({ table: 'workflow_sla_instances', column: 'patient_uid' }),
          ]),
        },
      });

    const user = await prisma.$queryRawUnsafe(
      `SELECT is_active, status, merged_into_uid::text
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT, secondary.uid,
    );
    expect(user[0].is_active).toBe(true);
    expect(user[0].status).not.toBe('merged');
    expect(user[0].merged_into_uid).toBeNull();
    const identifier = await prisma.$queryRawUnsafe(
      `SELECT status, patient_uid::text, merged_into_uid::text
         FROM patient_identifiers
        WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-UNSUPPORTED-MRN`,
    );
    expect(identifier[0]).toMatchObject({
      status: 'active',
      patient_uid: secondary.uid,
      merged_into_uid: null,
    });
  });

  test('both-active-admissions guard: two simultaneously-admitted patients are rejected, nothing mutates', async () => {
    const primary = await seedPatient('primary-adm');
    const secondary = await seedPatient('secondary-adm');
    await seedActiveAdmission(primary.uid, 'admitted');
    const secondaryAdmissionId = await seedActiveAdmission(secondary.uid, 'transferred');
    await seedIdentifier(secondary.uid, `${MARK}-BOTH-MRN`);

    const request = await approvedMergeRequest(primary, secondary);
    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_BOTH_ACTIVE_ADMISSIONS' });

    // Nothing mutated: admission untouched, identifier active, secondary
    // live, request still approved (retryable after a discharge).
    const admission = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, status FROM admissions WHERE id = $1`, secondaryAdmissionId,
    );
    expect(admission[0].patient_uid).toBe(secondary.uid);
    expect(admission[0].status).toBe('transferred');
    const identifier = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-BOTH-MRN`,
    );
    expect(identifier[0].status).toBe('active');
    const user = await prisma.$queryRawUnsafe(
      `SELECT is_active, merged_into_uid::text FROM users WHERE uid = $1::uuid`, secondary.uid,
    );
    expect(user[0].is_active).toBe(true);
    expect(user[0].merged_into_uid).toBeNull();
    const requestRow = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_merge_requests WHERE id = $1`, request.id,
    );
    expect(requestRow[0].status).toBe('approved');

    // One active side is fine: discharge the secondary's admission and the
    // same request executes.
    await prisma.$executeRawUnsafe(
      `UPDATE admissions SET status = 'discharged', discharged_at = NOW(), updated_at = NOW() WHERE id = $1`,
      secondaryAdmissionId,
    );
    const executed = await executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');
  });

  test('inactive patient records are rejected as merge inputs, in both positions', async () => {
    const active = await seedPatient('active');
    const inactive = await seedPatient('inactive');
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE uid = $1::uuid`,
      inactive.uid,
    );

    // Request-time, secondary inactive.
    await expect(requestMerge({
      tenantId: TENANT, primaryUid: active.uid, secondaryUid: inactive.uid,
      requestedBy: REQUESTER, requesterNote: MARK,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_TARGET_INACTIVE' });

    // Request-time, primary inactive.
    await expect(requestMerge({
      tenantId: TENANT, primaryUid: inactive.uid, secondaryUid: active.uid,
      requestedBy: REQUESTER, requesterNote: MARK,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_TARGET_INACTIVE' });

    // Execute-time: a record deactivated AFTER approval is caught under the
    // lock inside the transaction.
    const third = await seedPatient('third');
    const request = await approvedMergeRequest(active, third);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE uid = $1::uuid`,
      third.uid,
    );
    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_TARGET_INACTIVE' });
    const user = await prisma.$queryRawUnsafe(
      `SELECT merged_into_uid::text, status FROM users WHERE uid = $1::uuid`, third.uid,
    );
    expect(user[0].merged_into_uid).toBeNull();
    expect(user[0].status).not.toBe('merged');
  });

  test('an unattributed merge request (NULL requested_by) cannot be approved — the two-person rule never passes vacuously', async () => {
    const primary = await seedPatient('primary-unattributed');
    const secondary = await seedPatient('secondary-unattributed');
    const request = await requestMerge({
      tenantId: TENANT,
      primaryUid: primary.uid,
      secondaryUid: secondary.uid,
      requestedBy: null,
      requesterNote: MARK,
    });

    await expect(approveMerge({ tenantId: TENANT, id: request.id, approverUid: APPROVER }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_REQUESTER_UNATTRIBUTED' });

    // The row is untouched: still awaiting a properly attributed re-raise.
    const row = await prisma.$queryRawUnsafe(
      `SELECT status, approver_uid::text FROM patient_merge_requests WHERE id = $1`,
      request.id,
    );
    expect(row[0].status).toBe('requested');
    expect(row[0].approver_uid).toBeNull();
  });

  test('chained merges A→B then B→C: pointers end at the final survivor and the timeline union spans the chain', async () => {
    const a = await seedPatient('chain-a');
    const b = await seedPatient('chain-b');
    const c = await seedPatient('chain-c');
    await seedIdentifier(a.uid, `${MARK}-A-MRN`);
    await seedIdentifier(b.uid, `${MARK}-B-MRN`);
    await seedIdentifier(c.uid, `${MARK}-C-MRN`);
    await seedTimelineEvent(a.uid, 'chain-a-history');
    await seedTimelineEvent(b.uid, 'chain-b-history');
    await setPatientSafetyVersion(a.id, 41);
    await setPatientSafetyVersion(b.id, 7);
    await setPatientSafetyVersion(c.id, 19);

    // A → B.
    const first = await approvedMergeRequest(b, a);
    await executeMerge({ tenantId: TENANT, id: first.id, executorUid: EXECUTOR });
    const afterFirstClockRows = await readPatientSafetyVersions([a.id, b.id, c.id]);
    const afterFirstClocks = new Map(
      afterFirstClockRows.map((row) => [Number(row.patient_id), BigInt(row.version)]),
    );
    expect(afterFirstClocks.get(a.id)).toBe(42n);
    expect(afterFirstClocks.get(b.id)).toBe(43n);
    expect(afterFirstClocks.get(c.id)).toBe(19n);

    // B → C.
    const second = await approvedMergeRequest(c, b);
    const executed = await executeMerge({ tenantId: TENANT, id: second.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');
    expect(executed.execution_summary.chained_users_repointed).toBe(1);
    expect(executed.execution_summary.chained_identifiers_repointed).toBe(1);

    // Every predecessor clock remains on its original patient id. Triggered
    // deactivation/chain updates advance A and B first, then C folds the
    // entire unequal family to max+1 without rewriting either predecessor.
    const committedClockRows = await readPatientSafetyVersions([a.id, b.id, c.id]);
    expect(committedClockRows).toHaveLength(3);
    const committedClocks = new Map(
      committedClockRows.map((row) => [Number(row.patient_id), BigInt(row.version)]),
    );
    expect(committedClocks.get(a.id)).toBe(43n);
    expect(committedClocks.get(b.id)).toBe(44n);
    expect(committedClocks.get(c.id)).toBe(45n);
    expect(committedClocks.get(c.id)).toBeGreaterThan(committedClocks.get(a.id));
    expect(committedClocks.get(c.id)).toBeGreaterThan(committedClocks.get(b.id));
    expect(executed.execution_summary.patient_safety_version).toBe('45');

    // A committed execution is one-way. Retrying the same request fails
    // before any safety-source mutation and cannot advance the clock again.
    await expect(executeMerge({
      tenantId: TENANT,
      id: second.id,
      executorUid: EXECUTOR,
    })).rejects.toThrow(/must be in 'approved'/);
    expect(await readPatientSafetyVersions([a.id, b.id, c.id]))
      .toEqual(committedClockRows);

    // users: BOTH deactivated records point at the FINAL survivor; original
    // merge timestamps (provenance) survive the re-point.
    const users = await prisma.$queryRawUnsafe(
      `SELECT uid::text, is_active, status, merged_into_uid::text, merged_at
       FROM users WHERE uid IN ($1::uuid, $2::uuid) ORDER BY uid = $1::uuid DESC`,
      a.uid, b.uid,
    );
    for (const row of users) {
      expect(row.is_active).toBe(false);
      expect(row.status).toBe('merged');
      expect(row.merged_into_uid).toBe(c.uid);
      expect(row.merged_at).not.toBeNull();
    }

    // A's old MRN resolves straight to C; provenance still names A.
    const lookupA = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-A-MRN`,
    });
    expect(lookupA.count).toBe(1);
    expect(lookupA.identifiers[0].patient_uid).toBe(c.uid);
    expect(lookupA.identifiers[0].original_patient_uid).toBe(a.uid);
    const lookupB = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-B-MRN`,
    });
    expect(lookupB.identifiers[0].patient_uid).toBe(c.uid);

    // The reader helper resolves C to the whole chain (transitive walk would
    // also work, but the stored pointers are flattened so one hop suffices).
    const uidSet = await resolveMergedPatientUidSet(prisma, {
      tenantId: TENANT, patientUid: c.uid,
    });
    expect(uidSet[0]).toBe(c.uid);
    expect(new Set(uidSet)).toEqual(new Set([a.uid, b.uid, c.uid]));

    // C's canonical timeline unions A's and B's pre-merge history.
    const timeline = await readCanonicalPatientTimeline(c.uid, {
      tenantId: TENANT, limit: 200,
    });
    const summaries = timeline.events
      .map((event) => event.clinical_summary || event.summary || '')
      .filter((summary) => summary.startsWith(MARK));
    expect(summaries).toEqual(expect.arrayContaining([
      `${MARK}-chain-a-history`,
      `${MARK}-chain-b-history`,
    ]));
  });
});
